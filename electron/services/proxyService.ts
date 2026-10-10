import http from "http";
import https from "https";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { session } from "electron";
import axios from "axios";
import configStore from "./configStore";

/**
 * 全局网络代理（设置页「网络代理」）。
 *
 * 配置存 configStore（proxy.enabled / proxy.url），代理地址支持：
 *  - http://host:port            HTTP 代理（CONNECT 隧道）
 *  - socks5://host:port（socks/socks4/socks5h 同族）
 *  - 裸 host:port，默认按 http:// 处理
 *
 * 生效面（主进程全部出口 + Chromium 网络栈）：
 *  - axios 流量（插件音源搜索/取链、播放流转发、缓存/文件下载、插件与订阅源
 *    下载、更新检查、歌词封面、备份拉取）：axios 全局 defaults 注入 agent，各处不改；
 *  - neteaseService 裸 https.request（网易云接口）：请求前取 agent；
 *  - WebDAV（createClient 传 httpAgent/httpsAgent）；
 *  - Chromium session（渲染层远程封面、歌词直链 fetch、网易云登录窗）：setProxy。
 *
 * 刻意不代理：localhost/回环/内网地址（WebDAV 常架在 NAS、开发模式连本地服务，
 * 被代理拐走反而断）；mfs://local / mfs://cover 本地读取；shell.openExternal
 * （交给系统浏览器，走它自己的系统代理）。
 */

const ENABLED_KEY = "proxy.enabled";
const URL_KEY = "proxy.url";

export interface ProxyConfig {
    enabled: boolean;
    url: string;
}

export function getProxyConfig(): ProxyConfig {
    return {
        enabled: configStore.get(ENABLED_KEY, false) === true,
        url: String(configStore.get(URL_KEY, "") ?? "").trim(),
    };
}

/** 保存配置并即时生效（axios defaults + 全部已存在 session） */
export function setProxyConfig(next: Partial<ProxyConfig>): ProxyConfig {
    if (typeof next.enabled === "boolean") {
        configStore.set(ENABLED_KEY, next.enabled);
    }
    if (typeof next.url === "string") {
        configStore.set(URL_KEY, next.url.trim());
    }
    applyProxy();
    return getProxyConfig();
}

/**
 * 归一化代理地址：补协议、小写化、去掉路径尾巴。不合法返回 null。
 * socks 代理必须带端口（没有约定俗成的默认端口）。
 */
export function normalizeProxyUrl(raw: string): string | null {
    const input = String(raw ?? "").trim();
    if (!input) {
        return null;
    }
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`;
    try {
        const u = new URL(withScheme);
        if (!u.hostname) {
            return null;
        }
        const scheme = u.protocol.replace(":", "").toLowerCase();
        if (!["http", "https", "socks", "socks4", "socks4a", "socks5", "socks5h"].includes(scheme)) {
            return null;
        }
        if (!u.port && !["http", "https"].includes(scheme)) {
            return null;
        }
        return `${scheme}://${u.hostname}${u.port ? `:${u.port}` : ""}`;
    } catch {
        return null;
    }
}

/** 目标主机是否应绕过代理直连：回环 / 内网 / 本地主机名 */
function isDirectHost(host: string): boolean {
    const h = String(host ?? "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!h) {
        return false;
    }
    if (h === "localhost" || h.endsWith(".local") || h === "::1") {
        return true;
    }
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (m) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        if (a === 127 || a === 10 || a === 0) {
            return true;
        }
        // 169.254 链路本地
        if (a === 169 && b === 254) {
            return true;
        }
        if (a === 192 && b === 168) {
            return true;
        }
        if (a === 172 && b >= 16 && b <= 31) {
            return true;
        }
    }
    return false;
}

/**
 * 按「目标主机」分发的 agent：内网/本地直连，其余走代理。
 * node 的 http(s) 客户端对 agent 只要求有 addRequest(req, options)，鸭子类型即可；
 * 两个委托 agent 都是标准 Agent 子类，连接池各自维护。
 * （agent-base v7 的类型声明不再暴露 addRequest，运行时经 http.Agent 的
 *   createSocket/addRequest 分发照常可用，故 via 一律按 any 处理。）
 */
class DispatchAgent {
    constructor(
        private via: any,
        private direct: http.Agent | https.Agent,
    ) {}
    addRequest(req: any, options: any) {
        const patched = { ...options };
        // https.request 配自定义 agent 且目标不写端口时（axios 对默认端口 URL
        // 也不写），Node 会把 port 缺省成 80 而不是 443，代理就会对 443 的目标
        // CONNECT 80 端口，TLS 握手报 WRONG_VERSION_NUMBER。
        // https.request 会在 options 里带 _defaultAgent（https.globalAgent），
        // 以此区分 https 目标，把缺省/80 的端口强制回 443；http 目标 80 是正确值不动。
        const isHttpsTarget = options?._defaultAgent?.protocol === "https:";
        if (isHttpsTarget && (!patched.port || patched.port === 80)) {
            patched.port = 443;
        }
        if (isDirectHost(patched.host ?? patched.hostname)) {
            // 直连 agent 是运行时按协议选的，addRequest 的分发由 node 内部处理
            (this.direct as any).addRequest(req, patched);
        } else {
            this.via.addRequest(req, patched);
        }
    }
    destroy() {
        this.via?.destroy?.();
        this.direct.destroy();
    }
}

const directHttpAgent = new http.Agent({ keepAlive: true });
const directHttpsAgent = new https.Agent({ keepAlive: true });

let cached: {
    key: string;
    httpAgent: any;
    httpsAgent: any;
    axiosOpts: { httpAgent: any; httpsAgent: any; proxy: false };
} | null = null;

/** 当前代理配置对应的 axios 请求选项；未启用返回 undefined（走默认直连） */
export function axiosProxyOptions():
    | { httpAgent: any; httpsAgent: any; proxy: false }
    | undefined {
    const { enabled, url } = getProxyConfig();
    if (!enabled || !url) {
        return undefined;
    }
    const normalized = normalizeProxyUrl(url);
    if (!normalized) {
        return undefined;
    }
    if (!cached || cached.key !== normalized) {
        cached?.httpAgent?.destroy?.();
        cached?.httpsAgent?.destroy?.();
        let httpAgent: any;
        let httpsAgent: any;
        if (/^socks/i.test(normalized)) {
            // SocksProxyAgent 基于 agent-base，http/https 都能用
            const socks = new SocksProxyAgent(normalized);
            httpAgent = new DispatchAgent(socks, directHttpAgent);
            httpsAgent = new DispatchAgent(socks, directHttpsAgent);
        } else {
            httpAgent = new DispatchAgent(
                new HttpProxyAgent(normalized),
                directHttpAgent,
            );
            httpsAgent = new DispatchAgent(
                new HttpsProxyAgent(normalized),
                directHttpsAgent,
            );
        }
        cached = {
            key: normalized,
            httpAgent,
            httpsAgent,
            axiosOpts: { httpAgent, httpsAgent, proxy: false },
        };
    }
    return cached.axiosOpts;
}

/** 供裸 https.request 用的 agent（neteaseService）；未启用返回 undefined 直连 */
export function httpsRequestAgent(): any | undefined {
    return axiosProxyOptions()?.httpsAgent;
}

/** 供 WebDAV createClient 用的 agent 对；未启用返回 undefined */
export function webdavAgents(): { httpAgent: any; httpsAgent: any } | undefined {
    const opts = axiosProxyOptions();
    return opts ? { httpAgent: opts.httpAgent, httpsAgent: opts.httpsAgent } : undefined;
}

/**
 * Chromium session.setProxy 的配置；未启用返回 undefined（跟随系统）。
 * bypassList 与 isDirectHost 同口径，另加 <local>（局域网主机名）。
 */
export function chromiumProxyConfig():
    | { mode: "fixed_servers"; proxyRules: string; bypassList: string }
    | undefined {
    const { enabled, url } = getProxyConfig();
    if (!enabled || !url) {
        return undefined;
    }
    const normalized = normalizeProxyUrl(url);
    if (!normalized) {
        return undefined;
    }
    return {
        mode: "fixed_servers",
        proxyRules: normalized.toLowerCase(),
        bypassList:
            "localhost,127.0.0.1,[::1],<local>,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    };
}

/** 把当前代理配置应用到 axios 全局 defaults 与全部已存在 session */
export function applyProxy() {
    const opts = axiosProxyOptions();
    // 只动 agent/proxy 三个键，不碰各处已设置的 defaults（如 timeout、拦截器）
    axios.defaults.httpAgent = opts?.httpAgent;
    axios.defaults.httpsAgent = opts?.httpsAgent;
    axios.defaults.proxy = opts ? false : undefined;
    console.log("[proxy]", opts ? `已启用 ${getProxyConfig().url}` : "未启用");
    applyToChromiumSessions();
}

/** 本会话里碰过的 partition（登录窗等），用于 Electron <36 没有 getAllSessions 时遍历 */
const knownPartitions = new Set<string>(["netease-login"]);

/** 应用到当前所有已存在的 session（含登录窗等 partition） */
function applyToChromiumSessions() {
    try {
        const cfg = chromiumProxyConfig();
        const sessions: Electron.Session[] = [session.defaultSession];
        // Electron 33 没有 session.getAllSessions（36 才加），先遍历已知 partition
        const allSessions = (session as any).getAllSessions?.() as
            | Record<string, Electron.Session>
            | undefined;
        for (const partition of knownPartitions) {
            try {
                sessions.push(session.fromPartition(partition));
            } catch {
                // partition 还没被创建，忽略
            }
        }
        if (allSessions) {
            sessions.push(...Object.values(allSessions));
        }
        for (const ses of sessions) {
            void ses.setProxy(cfg ?? { mode: "system" });
        }
    } catch (e) {
        // app ready 前调不了 session；启动路径在 ready 后会再 applyProxy 一次
        console.warn("[proxy] session 应用跳过:", (e as Error)?.message);
    }
}

/**
 * 新建独立 partition 的窗口（网易云登录窗）前调用：让它的 session 一出生
 * 就带上当前代理，而不是等下一次 applyProxy 才覆盖到。
 */
export function setupSessionProxy(ses: Electron.Session, partition?: string) {
    if (partition) {
        // 记下这个 partition，便于 Electron <36（无 getAllSessions）也能遍历到
        knownPartitions.add(partition);
    }
    const cfg = chromiumProxyConfig();
    void ses.setProxy(cfg ?? { mode: "system" });
}
