import crypto from "crypto";
import { BrowserWindow } from "electron";
import https from "https";
import configStore from "./configStore";
import * as cookieCipher from "./cookieCipher";
import * as proxyService from "./proxyService";

/**
 * 网易云账号（扫码登录）与个性化推荐接口
 *
 * 登录：主进程弹出网易云官方登录页（独立内存 session），用户手机扫码确认后官方页面
 * 自己完成登录，`MUSIC_U` cookie 落进该 session，监听 cookie 变化拿到值后自动关窗。
 *
 * 加密约定：日常接口全走 plain api（GET/POST 表单）。唯二例外是「点赞/取消点赞评论」
 * 与「楼中楼」，这两个端点在 plain 路径上参数不通（实测报 illegal resourceId），必须走
 * weapi 报文——那只是网易 web 客户端的标准参数编码（公开常量，双重 AES + RSA 回传
 * 随机密钥），不涉及设备指纹/签名伪造等风控对抗；csrf_token 传空实测可用。
 * 实测（2026-10，全部为无副作用探测）：写操作只靠 MUSIC_U 即可通过鉴权，
 * 无需 __csrf；评论读取在 cookie 过期时退回匿名视角。
 *
 * cookie 保存：cookieCipher（AES-256-GCM，密钥在 configStore，绑机器）加密后存
 * configStore；加密不可用时退回明文。刻意不用 Electron safeStorage——它的密钥
 * 存 macOS 钥匙串，ad-hoc 签名每次更新后 CDHash 变化会反复弹「访问钥匙串」授权框。
 * 属登录凭据，刻意不进备份（与 WebDAV 密码同一约定）。
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
        | { enc?: boolean; data?: string; plain?: string; cipher?: string }
        | string
        | undefined;
    try {
        if (stored && typeof stored === "object") {
            if (stored.cipher) {
                // 当前格式：cookieCipher 密文。解不开（换机器/存储重置）按未登录处理
                cachedCookie = cookieCipher.decrypt(stored.cipher);
            } else if (stored.enc && stored.data) {
                // 旧格式：safeStorage 密文。2026-10 起已弃用（钥匙串弹窗问题），
                // 不再尝试解（密钥在钥匙串里，解就要弹窗），按未登录让用户重扫
                cachedCookie = null;
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
    let payload: { cipher?: string; plain?: string };
    const encrypted = cookieCipher.encrypt(value);
    if (encrypted) {
        payload = { cipher: encrypted };
    } else {
        payload = { plain: value };
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
        // 登录窗走独立 partition，session 一出生就要带上当前代理，
        // 否则代理用户开窗时登录页加载不出来
        proxyService.setupSessionProxy(win.webContents.session, "netease-login");
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
                // 全局代理开启时经代理（CONNECT 隧道）访问网易云接口
                ...(proxyService.httpsRequestAgent()
                    ? { agent: proxyService.httpsRequestAgent() }
                    : {}),
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
    {
        method = "GET",
        body,
        withCookie = true,
        extraCookie = [],
    }: { method?: string; body?: string; withCookie?: boolean; extraCookie?: string[] } = {},
    retries = 2,
): Promise<any> {
    const cookieParts = ["NMTID=00Oxxxx", "_ntes_nuid=11111111111111111111111111111111", ...extraCookie];
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

/** ---------- weapi 报文（点赞/取消点赞、楼中楼专用，理由见文件头） ---------- */

const WEAPI_PRESET_KEY = "0CoJUm6Qyw8W8jud";
const WEAPI_IV = "0102030405060708";
const WEAPI_BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const WEAPI_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;

/**
 * 写操作实测用的桌面客户端视角 cookie（os=pc 一组）。带上它报文形态与
 * 网易自家客户端一致；匿名探测下这些端点只认「参数合法 + MUSIC_U」。
 */
const DESKTOP_COOKIE = [
    "os=pc",
    "appver=3.1.17.204416",
    "osver=Microsoft-Windows-10-Professional-build-19045-64bit",
    "channel=netease",
];

/** 网易 web 端标准参数编码：AES-128-CBC 加密两次（预设密钥 + 随机密钥），随机密钥 RSA 无填充回传 */
function weapiEncrypt(data: Record<string, unknown>): string {
    let secretKey = "";
    for (let i = 0; i < 16; i++) {
        secretKey += WEAPI_BASE62[Math.floor(Math.random() * WEAPI_BASE62.length)];
    }
    const cipherOnce = (input: string, key: string) => {
        const c = crypto.createCipheriv("aes-128-cbc", Buffer.from(key, "utf-8"), Buffer.from(WEAPI_IV, "utf-8"));
        return Buffer.concat([c.update(input, "utf-8"), c.final()]).toString("base64");
    };
    const params = cipherOnce(cipherOnce(JSON.stringify(data), WEAPI_PRESET_KEY), secretKey);
    // 1024 位模长定长 128 字节，明文（反转后的随机密钥）左补零，密文 hex 大写
    const reversed = Buffer.from(secretKey.split("").reverse().join(""), "utf-8");
    const padded = Buffer.concat([Buffer.alloc(128 - reversed.length, 0), reversed]);
    const encSecKey = crypto
        .publicEncrypt({ key: WEAPI_PUBLIC_KEY, padding: crypto.constants.RSA_NO_PADDING }, padded)
        .toString("hex")
        .toUpperCase();
    return `params=${encodeURIComponent(params)}&encSecKey=${encSecKey}`;
}

async function weapiRequest(
    pathname: string,
    data: Record<string, unknown>,
    { withCookie = true }: { withCookie?: boolean } = {},
): Promise<any> {
    return apiRequest(pathname, {
        method: "POST",
        body: weapiEncrypt({ ...data, csrf_token: "" }),
        withCookie,
        extraCookie: withCookie ? DESKTOP_COOKIE : [],
    });
}

/** ---------- 歌曲评论 ---------- */

/** 歌曲评论的 threadId 前缀（资源类型表里 0 = 歌曲） */
const SONG_THREAD_PREFIX = "R_SO_4_";

/**
 * 歌曲评论：热评 + 最新评论（limit/offset 对最新评论分页，热评每页都随包返回）。
 * 最新评论流里回复按时间混排（带 beReplied 引用上下文），与网易云桌面端一致。
 * 带登录 cookie 时每条评论带 liked 状态；cookie 过期退回匿名视角——阅读本身不要求登录。
 *
 * 注意 offset 分页有上限（实测约 1100 条处就返回 more=false，远小于 total），
 * 要翻完整流须改用 beforeTime 游标：传上一页最后一条的 time，offset 归零。
 */
async function getSongComments(
    songId: string,
    limit = 30,
    offset = 0,
    beforeTime = 0,
): Promise<any> {
    const path =
        `/api/v1/resource/comments/${SONG_THREAD_PREFIX}${songId}` +
        `?limit=${limit}&offset=${offset}` +
        (beforeTime > 0 ? `&beforeTime=${beforeTime}` : "");
    try {
        return await apiRequest(path);
    } catch (e) {
        if (e instanceof NeedLoginError) {
            return apiRequest(path, { withCookie: false });
        }
        throw e;
    }
}

/** 点赞/取消点赞评论。unlike 幂等（重复取消也返回 200） */
async function likeComment(songId: string, commentId: string, like: boolean): Promise<any> {
    return weapiRequest(`/weapi/v1/comment/${like ? "like" : "unlike"}`, {
        threadId: `${SONG_THREAD_PREFIX}${songId}`,
        commentId: String(commentId),
    });
}

/** 发表评论；带 replyCommentId 时为回复（落进目标评论的楼中楼） */
async function addComment(songId: string, content: string, replyCommentId?: string): Promise<any> {
    const body = new URLSearchParams({ threadId: `${SONG_THREAD_PREFIX}${songId}`, content });
    if (replyCommentId) {
        body.set("commentId", String(replyCommentId));
    }
    return apiRequest(`/api/resource/comments/${replyCommentId ? "reply" : "add"}`, {
        method: "POST",
        body: body.toString(),
        extraCookie: DESKTOP_COOKIE,
    });
}

/** 删除自己的评论 */
async function deleteComment(songId: string, commentId: string): Promise<any> {
    return apiRequest("/api/resource/comments/delete", {
        method: "POST",
        body: new URLSearchParams({
            threadId: `${SONG_THREAD_PREFIX}${songId}`,
            commentId: String(commentId),
        }).toString(),
        extraCookie: DESKTOP_COOKIE,
    });
}

/** 关键词搜歌曲（cloudsearch，免登录）：给渲染层做「播放曲 → 网易歌曲 id」反查用 */
async function searchSongs(keyword: string, limit = 10): Promise<any[]> {
    const path = `/api/cloudsearch/pc?s=${encodeURIComponent(keyword)}&type=1&limit=${limit}`;
    try {
        const j = await apiRequest(path);
        return Array.isArray(j?.result?.songs) ? j.result.songs : [];
    } catch (e) {
        if (e instanceof NeedLoginError) {
            const j = await apiRequest(path, { withCookie: false });
            return Array.isArray(j?.result?.songs) ? j.result.songs : [];
        }
        throw e;
    }
}

/**
 * 歌曲红心（喜欢）数量：播放条喜欢角标用。countDesc 是网易自己的展示格式
 * （如「100w+」），直接采用即与网易云展示规则一致。免登录可读。
 */
async function getSongRedCount(songId: string): Promise<{ count: number; countDesc: string | null }> {
    const j = await apiRequest(`/api/song/red/count?songId=${songId}`, { withCookie: false });
    return {
        count: j?.data?.count ?? 0,
        countDesc: j?.data?.countDesc ?? null,
    };
}

/**
 * 精彩评论（热门评论独立分页）：「查看更多精彩评论」页用。
 * 带 cookie 时评论带 liked 状态，过期退回匿名。
 */
async function getHotComments(songId: string, limit = 30, offset = 0): Promise<any> {
    const path = `/api/v1/resource/hotcomments/${SONG_THREAD_PREFIX}${songId}?rid=${songId}&limit=${limit}&offset=${offset}&beforeTime=0`;
    try {
        return await apiRequest(path);
    } catch (e) {
        if (e instanceof NeedLoginError) {
            return apiRequest(path, { withCookie: false });
        }
        throw e;
    }
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
    getSongComments,
    likeComment,
    addComment,
    deleteComment,
    searchSongs,
    getSongRedCount,
    getHotComments,
    NeedLoginError,
};
