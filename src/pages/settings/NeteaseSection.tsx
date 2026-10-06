import React, { useEffect, useState } from "react";
import { showToast } from "@/components/base/Toast";
import {
    getNeteaseStatus,
    neteaseLogout,
    openNeteaseLogin,
} from "@/core/netease";

/**
 * 设置页「网易云账号」分组：扫码登录 / 退出登录。
 * 登录凭据（MUSIC_U）保存在主进程并经 safeStorage 加密，不随备份导出。
 */
export default function NeteaseSection() {
    const [loggedIn, setLoggedIn] = useState<boolean | null>(null);
    const [loggingIn, setLoggingIn] = useState(false);

    useEffect(() => {
        getNeteaseStatus()
            .then((s) => setLoggedIn(!!s.loggedIn))
            .catch(() => setLoggedIn(false));
    }, []);

    const login = async () => {
        setLoggingIn(true);
        try {
            const res = await openNeteaseLogin();
            if (res.success) {
                showToast("网易云登录成功，可在「每日推荐」查看个性化推荐");
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
        setLoggedIn(false);
        showToast("已退出网易云登录");
    };

    return (
        <div className="settings-group">
            <div className="settings-group-title">网易云账号</div>
            <div className="settings-item">
                <div>
                    <div className="settings-item-label">每日推荐</div>
                    <div className="settings-item-desc">
                        {loggedIn
                            ? "已登录。侧边栏「每日推荐」展示账号的个性化推荐，并用音源插件匹配成可播放曲目"
                            : "扫码登录网易云后，侧边栏「每日推荐」展示账号的个性化推荐并用音源插件匹配。登录凭据加密保存在本机，不随备份导出"}
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
        </div>
    );
}
