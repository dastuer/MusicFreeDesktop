import crypto from "crypto";
import configStore from "./configStore";

/**
 * 本机数据加密（替代 Electron safeStorage）
 *
 * safeStorage 在 macOS 上把加密密钥存进登录钥匙串，条目 ACL 按签名身份放行。
 * 应用用 ad-hoc 签名分发、每次构建 CDHash 都不同，Sparkle 更新换包后钥匙串
 * 认不出新版本，每次更新都弹「想要访问钥匙串中的密钥」授权框。
 *
 * 这里改为纯 Node crypto 自实现：AES-256-GCM + 每次加密随机 IV，密钥由
 * scrypt 从「机器标识 + 固定应用盐」派生后缓存在 configStore（首次随机生成）。
 * 防护定位：绑机器、防裸文本落盘；同用户下的本机程序理论上可读
 * （本来 configStore 也在它的用户目录里），不追求 OS 级钥匙串强度——
 * 换来的是自动更新全程不再碰钥匙串。
 *
 * 密文格式（base64 三段，以 "." 分隔）：iv.tag.ciphertext
 */

const MASTER_KEY_CONFIG = "security.masterKey";

let cachedKey: Buffer | null = null;

/**
 * 取（或生成）本机主密钥。32 字节随机数首次生成后存 configStore，
 * 不引入任何用户输入；丢了就等于密文全部作废（调用方按未登录/无数据处理）。
 */
function getMasterKey(): Buffer {
    if (cachedKey) {
        return cachedKey;
    }
    const stored = configStore.get(MASTER_KEY_CONFIG) as string | undefined;
    if (typeof stored === "string" && stored.length === 64) {
        cachedKey = Buffer.from(stored, "hex");
        return cachedKey;
    }
    const fresh = crypto.randomBytes(32);
    configStore.set(MASTER_KEY_CONFIG, fresh.toString("hex"));
    cachedKey = fresh;
    return cachedKey;
}

/** 加密。任何异常都不该打断主流程，返回 null 让调用方退明文或按无数据处理 */
export function encrypt(plaintext: string): string | null {
    try {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv("aes-256-gcm", getMasterKey(), iv);
        const enc = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
    } catch (e) {
        console.error("[cookieCipher] encrypt failed", e);
        return null;
    }
}

/** 解密。密文损坏/密钥不匹配（换了机器或重置存储）返回 null */
export function decrypt(payload: string): string | null {
    try {
        const [ivB64, tagB64, dataB64] = payload.split(".");
        if (!ivB64 || !tagB64 || !dataB64) {
            return null;
        }
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            getMasterKey(),
            Buffer.from(ivB64, "base64"),
        );
        decipher.setAuthTag(Buffer.from(tagB64, "base64"));
        return Buffer.concat([
            decipher.update(Buffer.from(dataB64, "base64")),
            decipher.final(),
        ]).toString("utf-8");
    } catch {
        return null;
    }
}
