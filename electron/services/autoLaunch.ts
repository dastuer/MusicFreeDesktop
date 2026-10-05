import { app } from "electron";

/**
 * 开机自启动（设置页「通用」开关）
 *
 * 状态只有一份：系统登录项本身（macOS 登录项 / Windows 注册表 HKCU Run 键），
 * 不在 configStore 里另存偏好——设置页每次都读系统真实状态，避免出现
 * 「应用里说开着、系统里被关了」还得替用户偷偷重新注册的情况。
 *
 * dev（未打包）下不注册：登录项会指向 node_modules 里的 Electron 壳，
 * 开机拉起的是不带参数的 Electron 而不是本应用，纯属污染登录项。
 * 此时设置页的开关只回提示、不改系统。
 */

const isDev = !app.isPackaged;

export function isSupported() {
    return !isDev;
}

export function isEnabled(): boolean {
    if (isDev) {
        return false;
    }
    return app.getLoginItemSettings().openAtLogin;
}

/**
 * 设置开关，返回系统实际生效的状态。
 * macOS 13+ 首次注册可能要用户在「系统设置 → 登录项」里批准，批准前
 * 这里返回的可能是 false，调用方（设置页）要据此给出提示。
 */
export function setEnabled(enabled: boolean): boolean {
    if (isDev) {
        return false;
    }
    app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
}
