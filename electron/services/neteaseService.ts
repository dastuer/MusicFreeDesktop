import { BrowserWindow, safeStorage } from "electron";
import https from "https";
import configStore from "./configStore";

/**
 * 网易云账号（扫码登录）与个性化推荐接口
 *
 * 登录：主进程弹出网易云官方登录页（独立内存 session），用户手机扫码确认后官方页面
 * 自己完成登录，`MUSIC_U` cookie 落进该 session，监听 cookie 变化拿到值后自动关窗。
 * 不自己实现 weapi 加密、不碰风控逻辑。
 *
 * cookie 保存：safeStorage（macOS 钥匙串 / Windows DPAPI）加密后存 configStore；
 * 加密不可用时退回明文。属登录凭据，刻意不进备份（与 WebDAV 密码同一约定）。
 *
 * 推荐接口走 music.163.com 的 plain api（GET/POST 表单），带 `Cookie: MUSIC_U=`
 * 即为账号个性化视角；未登录/过期时接口返回 code 301，这里转成 NeedLoginError。
 */

const COOKIE_KEY = "netease.musicU";
const LOGIN_URL = "https://music.163.com/#/login";
const UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

/** 接口判定「需要登录/登录过期」的信号码 */
const NEED_LOGIN_CODE = 301;

export class NeedLoginError extends Error {
    constructor() {
        super("网易云登录已过期，请重新扫码登录");
        this.name = "NeedLoginError";
    }
}

/** ---------- cookie 读取与保存 ---------- */

/** 读出来的缓存：undefined = 还没读过，null = 确认未登录 */
let cachedCookie: string | null | undefined;

function readCookie(): string | null {
    if (cachedCookie !== undefined) {
        return cachedCookie;
    }
    const stored = configStore.get(COOKIE_KEY) as
        | { enc?: boolean; data?: string; plain?: string }
        | string
        | undefined;
    try {
        if (stored && typeof stored === "object") {
            if (stored.enc && stored.data) {
                // 加密不可用（钥匙串拒绝访问等）时解不开，按未登录处理，不丢密文
                cachedCookie = safeStorage.isEncryptionAvailable()
                    ? safeStorage.decryptString(Buffer.from(stored.data, "base64"))
                    : null;
            } else {
                cachedCookie = stored.plain ?? null;
            }
        } else if (typeof stored === "string" && stored) {
            // 兼容：早期手工写入的裸字符串
            cachedCookie = stored;
        } else {
            cachedCookie = null;
        }
    } catch {
        cachedCookie = null;
    }
    return cachedCookie;
}

function saveCookie(value: string) {
    let payload: { enc: boolean; data?: string; plain?: string };
    if (safeStorage.isEncryptionAvailable()) {
        payload = { enc: true, data: safeStorage.encryptString(value).toString("base64") };
    } else {
        payload = { enc: false, plain: value };
    }
    configStore.set(COOKIE_KEY, payload);
    cachedCookie = value;
}

function clearCookie() {
    configStore.remove(COOKIE_KEY);
    cachedCookie = null;
}

/** ---------- 登录窗口 ---------- */

let loginWindow: BrowserWindow | null = null;
let loginPromise: Promise<{ success: boolean; canceled?: boolean; message?: string }> | null = null;

/**
 * 等登录窗的 session 里出现 MUSIC_U。
 * 用户扫码确认后官方页面写入该 cookie；用户直接关窗则 resolve null。
 */
function watchLoginCookie(win: BrowserWindow): Promise<string | null> {
    const ses = win.webContents.session;
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: string | null) => {
            if (settled) {
                return;
            }
            settled = true;
            ses.cookies.removeListener("changed", onCookieChanged);
            resolve(value);
        };
        const onCookieChanged = (_e: any, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
            if (!removed && cookie.name === "MUSIC_U" && cookie.value && (cookie.domain ?? "").endsWith("163.com")) {
                finish(cookie.value);
            }
        };
        ses.cookies.on("changed", onCookieChanged);
        win.once("closed", () => finish(null));
    });
}

/**
 * 打开官方登录窗（独立内存 partition，不污染主窗口 session）。
 * 扫码成功后自动关窗并保存 cookie；重复调用时聚焦已开的窗口并复用同一个 Promise。
 *
 * 每次开窗都先清空该 partition 的 cookie/存储：同名的内存 session 在一次运行内
 * 会被复用，上个账号登录留下的 MUSIC_U 会让官方页直接进入已登录态——二维码
 * 出不来，还可能被当成「重新登录」把旧账号又登回去。
 */
async function openLoginWindow(): Promise<{
    success: boolean;
    canceled?: boolean;
    message?: string;
}> {
    if (loginWindow && !loginWindow.isDestroyed() && loginPromise) {
        loginWindow.focus();
        return loginPromise;
    }
    loginPromise = new Promise((resolve) => {
        const win = new BrowserWindow({
            width: 1000,
            height: 720,
            title: "网易云音乐登录",
            autoHideMenuBar: true,
            webPreferences: {
                partition: "netease-login",
                contextIsolation: true,
                nodeIntegration: false,
                sandbox: true,
            },
        });
        loginWindow = win;
        (async () => {
            const ses = win.webContents.session;
            try {
                await ses.clearStorageData();
                await ses.clearCache();
            } catch (e) {
                console.warn("[netease] 清理登录窗 session 失败（继续打开）:", e);
            }
            if (!win.isDestroyed()) {
                win.loadURL(LOGIN_URL);
            }
        })();
        watchLoginCookie(win).then((value) => {
            loginWindow = null;
            loginPromise = null;
            if (!win.isDestroyed()) {
                win.close();
            }
            if (value) {
                saveCookie(value);
                resolve({ success: true });
            } else {
                resolve({ success: false, canceled: true });
            }
        });
    });
    return loginPromise;
}

/** ---------- HTTP ---------- */

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

function rawRequest(
    url: string,
    options: { method?: string; body?: string; headers?: Record<string, string> },
    timeoutMs = 15000,
): Promise<{ statusCode: number; text: string }> {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const data = options.body ? Buffer.from(options.body) : null;
        const req = https.request(
            {
                hostname: u.hostname,
                path: u.pathname + u.search,
                method: options.method ?? "GET",
                headers: {
                    "User-Agent": UA,
                    Referer: "https://music.163.com/",
                    ...(data
                        ? {
                              "Content-Type": "application/x-www-form-urlencoded",
                              "Content-Length": data.length,
                          }
                        : {}),
                    ...options.headers,
                },
                timeout: timeoutMs,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c as Buffer));
                res.on("end", () =>
                    resolve({
                        statusCode: res.statusCode ?? 0,
                        text: Buffer.concat(chunks).toString("utf-8"),
                    }),
                );
            },
        );
        req.on("timeout", () => req.destroy(new Error("请求网易云接口超时")));
        req.on("error", reject);
        if (data) {
            req.write(data);
        }
        req.end();
    });
}

/** 带重试的接口调用；code 301 视为登录过期。刷新接口对未登录也开放，所以 cookie 有无都照发 */
async function apiRequest(
    pathname: string,
    { method = "GET", body, withCookie = true }: { method?: string; body?: string; withCookie?: boolean } = {},
    retries = 2,
): Promise<any> {
    const cookieParts = ["NMTID=00Oxxxx", "_ntes_nuid=11111111111111111111111111111111"];
    const cookie = withCookie ? readCookie() : null;
    if (cookie) {
        cookieParts.push(`MUSIC_U=${cookie}`);
    }
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const { statusCode, text } = await rawRequest(`https://music.163.com${pathname}`, {
                method,
                body,
                headers: { Cookie: cookieParts.join("; ") },
            });
            if (statusCode === 429) {
                throw new Error("网易云接口限频，请稍后再试");
            }
            let json: any;
            try {
                json = JSON.parse(text);
            } catch {
                throw new Error(`网易云接口返回异常（HTTP ${statusCode}）`);
            }
            if (json.code === NEED_LOGIN_CODE) {
                throw new NeedLoginError();
            }
            return json;
        } catch (e: any) {
            if (e instanceof NeedLoginError) {
                throw e;
            }
            lastError = e;
            if (attempt < retries) {
                await sleep(800);
            }
        }
    }
    throw lastError ?? new Error("网易云接口请求失败");
}

/** ---------- 对外能力 ---------- */

export interface INeteaseProfile {
    userId: string;
    nickname: string;
    avatarUrl: string;
}

export interface INeteaseStatus {
    loggedIn: boolean;
}

function getStatus(): INeteaseStatus {
    return { loggedIn: !!readCookie() };
}

function logout() {
    clearCookie();
    cachedProfile = null;
}

/**
 * 当前账号资料（设置页展示、每日推荐页识别换号用），按 cookie 值缓存——
 * 同一登录态重复取不发请求；退出/换号后 cookie 变化自然失效。
 * 拿不到（接口抖动等）返回 null，不阻塞登录态判断。
 */
let cachedProfile: { cookie: string; profile: INeteaseProfile } | null = null;

async function getAccountInfo(): Promise<INeteaseProfile | null> {
    const cookie = readCookie();
    if (!cookie) {
        return null;
    }
    if (cachedProfile?.cookie === cookie) {
        return cachedProfile.profile;
    }
    const j = await apiRequest("/api/nuser/account/get");
    const p = j?.profile;
    if (!p?.userId) {
        return null;
    }
    const profile: INeteaseProfile = {
        userId: String(p.userId),
        nickname: p.nickname ?? "",
        avatarUrl: p.avatarUrl ?? "",
    };
    cachedProfile = { cookie, profile };
    return profile;
}

/** 每日推荐歌曲（账号个性化；返回原始 dailySongs 数组，字段交给渲染层归一化） */
async function getDailySongs(): Promise<any[]> {
    const j = await apiRequest("/api/v3/discovery/recommend/songs");
    const songs = j?.data?.dailySongs;
    if (!Array.isArray(songs)) {
        throw new Error("日推数据格式异常");
    }
    return songs;
}

/** 每日推荐歌单（账号个性化） */
async function getRecommendPlaylists(): Promise<any[]> {
    const j = await apiRequest("/api/v1/discovery/recommend/resource");
    return Array.isArray(j?.recommend) ? j.recommend : [];
}

/** 首页个性化推荐歌单网格 */
async function getPersonalizedPlaylists(limit = 30): Promise<any[]> {
    const j = await apiRequest(`/api/personalized/playlist?limit=${limit}`);
    return Array.isArray(j?.result) ? j.result : [];
}

/**
 * 拉一份歌单的全量曲目：v3 详情接口带 n=1000 时 tracks 通常已齐，
 * 缺的（超大歌单分页截断）按 trackIds 走 song/detail 批量补齐（与导入脚本同口径）。
 */
async function getPlaylistDetail(id: string): Promise<{ name: string; tracks: any[] }> {
    const detail = await apiRequest("/api/v3/playlist/detail", {
        method: "POST",
        body: `id=${id}&n=1000&s=0`,
    });
    const pl = detail?.playlist;
    if (!pl) {
        throw new Error(`没拿到歌单内容（code=${detail?.code ?? "?"}），歌单可能已失效`);
    }
    const ids: number[] = (pl.trackIds ?? []).map((t: any) => t.id);
    const tracks = new Map<number, any>();
    for (const t of pl.tracks ?? []) {
        tracks.set(t.id, t);
    }
    for (let i = 0; i < ids.length; i += 100) {
        const chunk = ids.slice(i, i + 100);
        const c = JSON.stringify(chunk.map((x) => ({ id: x })));
        const j = await apiRequest("/api/v3/song/detail", {
            method: "POST",
            body: `c=${encodeURIComponent(c)}&ids=${JSON.stringify(chunk)}`,
        });
        for (const s of j.songs ?? []) {
            if (!tracks.has(s.id)) {
                tracks.set(s.id, s);
            }
        }
        await sleep(300);
    }
    return {
        name: pl.name,
        tracks: ids.map((sid) => tracks.get(sid)).filter(Boolean),
    };
}

export default {
    setup() {
        // 无需初始化，cookie 走 configStore 懒读；占位让调用方保持与服务层一致的形态
    },
    openLoginWindow,
    getStatus,
    logout,
    getAccountInfo,
    getDailySongs,
    getRecommendPlaylists,
    getPersonalizedPlaylists,
    getPlaylistDetail,
    NeedLoginError,
};
