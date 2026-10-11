#!/usr/bin/env bash
#
# 指定版本号构建并覆盖安装到 /Applications。
#
# 用途：想在安装形态下验证「设置 → 关于」里显示的版本、升级判断逻辑等
# 与版本号相关的行为，又不想真的去改 package.json 再改回来。
#
# 用法：
#   bash scripts/reinstall-version.sh 0.9.9     # 以版本 0.9.9 构建并安装
#   bash scripts/reinstall-version.sh 0.9.9 --with-dmg
#   npm run reinstall:version -- 0.9.9          # 等价于第一种
#
# 原理：electron-builder 与应用内显示的版本都取自 package.json，所以
# 先把指定版本写进 package.json 再跑 reinstall.sh，跑完（无论成败）还原。
# 版本号本身不提交、不改动 git 记录，只是构建期临时状态。

set -uo pipefail

APP_NAME="MusicFreeDesktop"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG_FILE="${PROJECT_DIR}/package.json"

usage() {
    echo "用法: bash scripts/reinstall-version.sh <版本号> [--with-dmg]"
    echo "  <版本号>  形如 0.9.9 的 semver，构建产物与「关于」页将显示该版本"
    echo "  --with-dmg  额外产出 dmg（慢，用于分发验证）"
    exit 1
}

[ $# -ge 1 ] || usage

TARGET_VERSION="$1"
shift

WITH_DMG=0
for arg in "$@"; do
    case "${arg}" in
        --with-dmg) WITH_DMG=1 ;;
            *) usage ;;
    esac
done

# semver 校验（宽松：主.次.补丁，每段数字）
if ! echo "${TARGET_VERSION}" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+].+)?$'; then
    echo "✗ 版本号格式不对：${TARGET_VERSION}（应为 x.y.z，如 0.9.9）"
    exit 1
fi

PKG_VERSION="$(node -p "require('${PKG_FILE}').version" 2>/dev/null || echo '')"
[ -n "${PKG_VERSION}" ] || { echo "✗ 读不到 package.json 的 version"; exit 1; }

if [ "${TARGET_VERSION}" = "${PKG_VERSION}" ]; then
    echo "→ 指定版本与 package.json 当前版本一致（${PKG_VERSION}），直接走常规重装"
    ARGS=()
    [ "${WITH_DMG}" = "1" ] && ARGS+=(--with-dmg)
    exec bash "${PROJECT_DIR}/scripts/reinstall.sh" "${ARGS[@]+"${ARGS[@]}"}"
fi

# ---------- 改版本号（含还原兜底） ----------

# 用 node 只改顶层 version 字段（比 sed 稳：不会误伤依赖里的版本串，
# 也不会像 sed -i 那样在某些沙盒下静默失败）
set_version() {
    node -e "
const fs = require('fs');
const f = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
pkg.version = process.argv[2];
fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n');
" "${PKG_FILE}" "$1"
}

# 还原函数：无论后面哪一步失败、甚至被 Ctrl-C，都要把 package.json 改回来
restore_version() {
    set_version "${PKG_VERSION}"
}
trap restore_version EXIT INT TERM

set_version "${TARGET_VERSION}"

# 必须确认真的改上了：改不上就中止，否则装出来的还是旧版本，容易误判
CURRENT_VERSION="$(node -p "require('${PKG_FILE}').version" 2>/dev/null || echo '')"
if [ "${CURRENT_VERSION}" != "${TARGET_VERSION}" ]; then
    echo "✗ package.json 版本号改写失败，中止"
    exit 1
fi
echo "→ 版本号 ${PKG_VERSION} → ${TARGET_VERSION}（构建完成后自动还原）"

# ---------- 复用 reinstall.sh ----------

echo
ARGS=()
[ "${WITH_DMG}" = "1" ] && ARGS+=(--with-dmg)
bash "${PROJECT_DIR}/scripts/reinstall.sh" "${ARGS[@]+"${ARGS[@]}"}"
RC=$?

# reinstall.sh 失败时以其退出码退出（trap 仍会触发还原）
exit "${RC}"
