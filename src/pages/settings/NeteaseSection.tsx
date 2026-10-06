import React, { useEffect, useState } from "react";
import Icon from "@/components/base/Icon";
import { showToast } from "@/components/base/Toast";
import {
    getCachedNeteaseProfile,
    getNeteaseAccountInfo,
    getNeteaseStatus,
    INeteaseProfile,
    neteaseLogout,
    openNeteaseLogin,
} from "@/core/netease";
import {
    clearMatchCache,
    getMatchCacheCount,
} from "@/core/neteaseMatchCache";
import { resetAllMatchSessions } from "@/core/neteaseMatchSession";

/**
 * 设置页「网易云账号」分组：当前账号资料、扫码/重新登录、退出登录。
 * 登录凭据（MUSIC_U）保存在主进程并经 safeStorage 加密，不随备份导出。
 */
export default function NeteaseSection() {
    const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
    const [profile, setProfile] = useState<INeteaseProfile | null>(() =>
        getCachedNeteaseProfile(),
    );
    const [loggingIn, setLoggingIn] = useState(false);
    const [cacheCount, setCacheCount] = useState(0);

    useEffect(() => {
        getNeteaseStatus()
            .then((s) => setLoggedIn(!!s.loggedIn))
            .catch(() => setLoggedIn(false));
        // 资料失败不置 loggedIn：登录态以 getStatus 为准，这里只影响展示
        getNeteaseAccountInfo().then(setProfile).catch(() => {});
        setCacheCount(getMatchCacheCount());
    }, []);

    const login = async () => {
        setLoggingIn(true);
        // 换号要让旧账号的匹配会话全部作废（私人雷达等歌单内容按账号生成）。
        // 登录成功后这里会把资料缓存刷成新账号，每日推荐页挂载时的换号检测
        // 因此看不到变化——必须在登录事件这一刻就地判断并重置。
        const userIdBefore = getCachedNeteaseProfile()?.userId;
        try {
            const res = await openNeteaseLogin();
            if (res.success) {
                showToast("网易云登录成功，可在「每日推荐」查看个性化推荐");
                const after = await getNeteaseAccountInfo().catch(() => null);
                setProfile(after);
                if (after && after.userId !== userIdBefore) {
                    resetAllMatchSessions();
                }
            } else if (!res.canceled) {
                showToast(res.message ?? "登录未完成");
            }
        } catch (e: any) {
            showToast(`登录失败：${e?.message ?? "未知错误"}`);
        } finally {
            setLoggingIn(false);
            getNeteaseStatus()
                .then((s) => setLoggedIn(!!s.loggedIn))
                .catch(() => {});
        }
    };

    const logout = async () => {
        await neteaseLogout();
        resetAllMatchSessions();
        setLoggedIn(false);
        setProfile(null);
        showToast("已退出网易云登录");
    };

    const showAccount = !!loggedIn && !!profile;

    return (
        <div className="settings-group">
            <div className="settings-group-title">网易云账号</div>
            <div className="settings-item">
                <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
                    {profile?.avatarUrl ? (
                        <img
                            src={profile.avatarUrl}
                            alt=""
                            style={{
                                width: 44,
                                height: 44,
                                borderRadius: "50%",
                                objectFit: "cover",
                                flexShrink: 0,
                            }}
                        />
                    ) : (
                        <div
                            style={{
                                width: 44,
                                height: 44,
                                borderRadius: "50%",
                                background: "var(--hover-bg)",
                                color: "var(--text-tertiary)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                flexShrink: 0,
                            }}
                        >
                            <Icon name="netease" size={22} />
                        </div>
                    )}
                    <div style={{ minWidth: 0 }}>
                        <div className="settings-item-label">
                            {showAccount ? profile!.nickname || "网易云用户" : "每日推荐"}
                        </div>
                        <div className="settings-item-desc">
                            {loggedIn === null
                                ? "正在检查登录状态…"
                                : showAccount
                                  ? `已登录${profile!.userId ? `（ID ${profile!.userId}）` : ""}。侧边栏「每日推荐」展示该账号的个性化推荐，并用音源插件匹配成可播放曲目`
                                  : loggedIn
                                    ? "已登录，账号资料获取中…"
                                    : "尚未登录。扫码登录后，侧边栏「每日推荐」展示账号的个性化推荐并用音源插件匹配。登录凭据加密保存在本机，不随备份导出"}
                        </div>
                    </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    {loggedIn && (
                        <button className="btn-ghost" onClick={logout}>
                            退出登录
                        </button>
                    )}
                    <button
                        className="btn-primary"
                        disabled={loggingIn}
                        onClick={login}
                    >
                        {loggingIn ? "等待扫码…" : loggedIn ? "重新登录" : "扫码登录"}
                    </button>
                </div>
            </div>
            <div className="settings-item">
                <div>
                    <div className="settings-item-label">匹配缓存</div>
                    <div className="settings-item-desc">
                        网易云歌曲与音源曲目的匹配结果（当前 {cacheCount} 条）。再次匹配时命中缓存的直接使用、
                        不再逐首搜索；音源插件变更后对应条目自动失效重配。缓存可随时清除，不影响歌单数据
                    </div>
                </div>
                <button
                    className="btn-ghost"
                    style={{ flexShrink: 0 }}
                    disabled={!cacheCount}
                    onClick={() => {
                        clearMatchCache();
                        setCacheCount(0);
                        showToast("已清除匹配缓存");
                    }}
                >
                    清除
                </button>
            </div>
        </div>
    );
}
