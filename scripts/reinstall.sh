#!/usr/bin/env bash
#
# 构建 macOS 应用 → 覆盖安装到 /Applications → 启动。
#
# 用法：
#   bash scripts/reinstall.sh              默认用 dist:dir，只出 .app，快
#   bash scripts/reinstall.sh --with-dmg   额外产出 dmg（更慢，用于分发）
#   npm run reinstall                      等价于第一种
#
# 与旧的一条龙命令的区别：
#   - 用 npm 的真实退出码判断成败，不用 grep 计数（grep -c 无命中时退出码为 1，会让 && 短路）
#   - 完整构建日志落在 /tmp 下的日志文件里，不再丢弃
#   - 用 ditto 而不是 cp -R 拷贝 .app，保留权限、符号链接与扩展属性
#   - 删 /Applications 前校验路径形态，避免变量异常时误删

set -uo pipefail

APP_NAME="MusicFreeDesktop"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUILD="${PROJECT_DIR}/release/mac-arm64/${APP_NAME}.app"
APP_INSTALL="/Applications/${APP_NAME}.app"
LOG_FILE="${TMPDIR:-/tmp}/musicfree-dist.log"

WITH_DMG=0
if [ "${1:-}" = "--with-dmg" ]; then
    WITH_DMG=1
fi

VERSION="$(node -p "require('${PROJECT_DIR}/package.json').version" 2>/dev/null || echo '?')"

echo "MusicFree Desktop 重装脚本 (v${VERSION})"
echo "  工程目录：${PROJECT_DIR}"
echo "  安装目标：${APP_INSTALL}"
echo

# ---------- 1. 退出正在运行的应用 ----------

echo "==> 1/4 退出正在运行的 ${APP_NAME}"
osascript -e "quit app \"${APP_NAME}\"" 2>/dev/null || true

# 等进程真正退出，最多 10 秒（否则下一步删不掉 / 覆盖不了）
for _ in {1..20}; do
    pgrep -x "${APP_NAME}" >/dev/null 2>&1 || break
    sleep 0.5
done

if pgrep -x "${APP_NAME}" >/dev/null 2>&1; then
    echo "    应用未响应退出请求，强制结束"
    pkill -x "${APP_NAME}" >/dev/null 2>&1 || true
    sleep 1
fi
echo "    已退出"

# ---------- 2. 打包 ----------

if [ "${WITH_DMG}" -eq 1 ]; then
    echo "==> 2/4 打包（含 dmg，较慢）"
    BUILD_CMD=(npm run dist)
else
    echo "==> 2/4 打包（仅 .app，跳过 dmg）"
    BUILD_CMD=(npm run dist:dir)
fi

cd "${PROJECT_DIR}" || exit 1

# set -o pipefail 让管道的退出码取自 npm，而不是 tee
if ! "${BUILD_CMD[@]}" 2>&1 | tee "${LOG_FILE}"; then
    echo
    echo "打包失败，已中止，未改动 /Applications。"
    echo "完整日志：${LOG_FILE}"
    exit 1
fi

# ---------- 3. 覆盖安装 ----------

echo
echo "==> 3/4 覆盖安装到 /Applications"

if [ ! -d "${APP_BUILD}" ]; then
    echo "找不到构建产物：${APP_BUILD}"
    echo "请确认 package.json 里 build.mac.target 的架构（当前预期 arm64）"
    exit 1
fi

# 安全阀：路径必须是 /Applications 下的 .app，避免变量异常时误删
case "${APP_INSTALL}" in
    /Applications/*.app) ;;
    *)
        echo "安装路径形态异常，拒绝执行删除：${APP_INSTALL}"
        exit 1
        ;;
esac

if [ ! -w "/Applications" ]; then
    echo "没有 /Applications 的写权限，请修复权限后重试"
    exit 1
fi

rm -rf "${APP_INSTALL}"
ditto "${APP_BUILD}" "${APP_INSTALL}"
echo "    已安装（未签名版本，仅限本机自用）"

# ---------- 4. 启动 ----------

echo "==> 4/4 启动"
open "${APP_INSTALL}"

echo
echo "完成。应用数据仍在 ~/Library/Application Support/${APP_NAME}/，本次替换不会清除歌单与插件。"
