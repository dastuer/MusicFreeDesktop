#!/usr/bin/env bash
#
# 一条龙发版：构建双平台 → 生成签名 appcast → 提交推送 → 创建 GitHub Release。
#
# 用法：
#   bash scripts/release.sh                     # 版本号取 package.json（需先 bump）
#   bash scripts/release.sh 1.0.6               # 指定版本号，并同步写回 package.json
#   bash scripts/release.sh --skip-build        # 跳过构建，直接用现有产物发版（重传/补 appcast 用）
#   bash scripts/release.sh --dry-run           # 只打印将执行的动作，不改任何东西
#
# 前置条件：
#   - gh CLI 已登录（gh auth status）
#   - Sparkle EdDSA 私钥在本机钥匙串（generate_keys 生成过，名 https://sparkle-project.org）
#   - 工作区干净（除 package.json 的版本号改动；脚本会一并用 git 检查）
#
# 产物（全部上传到 release）：
#   release/MusicFreeDesktop-{v}-arm64.dmg        macOS 首次安装
#   release/MusicFreeDesktop-{v}-arm64-mac.zip    Sparkle 更新包
#   release-win/MusicFreeDesktop-Setup-{v}.exe    Windows 安装版
#   release-win/MusicFreeDesktop-Portable-{v}.exe Windows 便携版
#   appcast.xml                                   Sparkle 更新 feed（EdDSA 签名）
#
# appcast 说明：
#   - enclosure URL 固定指 https://github.com/<repo>/releases/download/v{v}/<zip 名>，
#     每个版本下载各自的资产，不依赖 latest 重定向
#   - 生成的 appcast 每次只含当前版本；若 release 里已有旧 appcast，会先取回合并
#     （保留旧 item，老用户的自动检查才能继续看到自己之后的所有版本）

set -euo pipefail

APP_NAME="MusicFreeDesktop"
REPO="dastuer/MusicFreeDesktop"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAC_DIR="${PROJECT_DIR}/release"
WIN_DIR="${PROJECT_DIR}/release-win"
SPARKLE_BIN="${PROJECT_DIR}/node_modules/electron-sparkle-updater/native/vendor/bin"
KEYCHAIN_SERVICE="https://sparkle-project.org"
WORK_DIR="$(mktemp -d /tmp/mfd-release.XXXXXX)"
trap 'rm -rf "${WORK_DIR}"' EXIT

DRY_RUN=0
SKIP_BUILD=0
VERSION_ARG=""
for arg in "$@"; do
    case "${arg}" in
        --dry-run)    DRY_RUN=1 ;;
        --skip-build) SKIP_BUILD=1 ;;
        [0-9]*)       VERSION_ARG="${arg}" ;;
        *) echo "未知参数: ${arg}（支持版本号 / --skip-build / --dry-run）"; exit 1 ;;
    esac
done

PKG_VERSION="$(node -p "require('${PROJECT_DIR}/package.json').version")"
VERSION="${VERSION_ARG:-${PKG_VERSION}}"
TAG="v${VERSION}"

if [ "${VERSION_ARG}" != "" ] && [ "${VERSION_ARG}" != "${PKG_VERSION}" ]; then
    echo "→ 将 package.json 版本 ${PKG_VERSION} → ${VERSION}"
    [ "${DRY_RUN}" = "1" ] || sed -i '' "s/\"version\": \"${PKG_VERSION}\"/\"version\": \"${VERSION}\"/" "${PROJECT_DIR}/package.json"
fi
echo "→ 发版版本: ${TAG}"

run() {
    if [ "${DRY_RUN}" = "1" ]; then
        echo "  [dry-run] $*"
    else
        "$@"
    fi
}

# ---------- 前置检查 ----------

command -v gh > /dev/null || { echo "✗ 需要 gh CLI"; exit 1; }
gh auth status > /dev/null 2>&1 || { echo "✗ gh 未登录（gh auth login）"; exit 1; }
[ -x "${SPARKLE_BIN}/generate_appcast" ] || {
    echo "✗ 缺 generate_appcast，先跑: npx electron-sparkle-updater rebuild"; exit 1;
}

# EdDSA 私钥必须能从钥匙串取到（App Store 沙盒里签不出有效 appcast）
PRIVATE_KEY_FILE="${WORK_DIR}/ed_private_key"
if security find-generic-password -s "${KEYCHAIN_SERVICE}" -w > "${PRIVATE_KEY_FILE}" 2> /dev/null; then
    chmod 600 "${PRIVATE_KEY_FILE}"
    echo "→ 已从钥匙串取到 EdDSA 私钥"
else
    echo "✗ 钥匙串取不到私钥（服务名 ${KEYCHAIN_SERVICE}）。先跑 generate_keys 生成"; exit 1
fi

# 工作区必须干净：发版产物要与 tag 严格对应
if [ "${SKIP_BUILD}" = "0" ] && [ "${DRY_RUN}" = "0" ]; then
    if ! git -C "${PROJECT_DIR}" diff --quiet || ! git -C "${PROJECT_DIR}" diff --cached --quiet; then
        echo "✗ 工作区有未提交改动，先 commit（package.json 版本号改动除外——上面已代写）"
        git -C "${PROJECT_DIR}" status --short
        exit 1
    fi
fi

if gh release view "${TAG}" --repo "${REPO}" > /dev/null 2>&1; then
    echo "✗ release ${TAG} 已存在；要重发先删掉（gh release delete ${TAG} --cleanup-tag）"; exit 1
fi

# ---------- 构建 ----------

if [ "${SKIP_BUILD}" = "0" ]; then
    echo "→ 构建渲染层 + 主进程"
    run npm --prefix "${PROJECT_DIR}" run build

    echo "→ 打包 macOS（dmg + Sparkle 更新 zip）"
    run npm --prefix "${PROJECT_DIR}" run dist:mac

    echo "→ 打包 Windows（安装版 + 便携版）"
    run npm --prefix "${PROJECT_DIR}" run dist:win
fi

DMG="${MAC_DIR}/${APP_NAME}-${VERSION}-arm64.dmg"
ZIP="${MAC_DIR}/${APP_NAME}-${VERSION}-arm64-mac.zip"
SETUP="${WIN_DIR}/${APP_NAME}-Setup-${VERSION}.exe"
PORTABLE="${WIN_DIR}/${APP_NAME}-Portable-${VERSION}.exe"

for f in "${DMG}" "${ZIP}" "${SETUP}" "${PORTABLE}"; do
    [ -f "${f}" ] || { echo "✗ 缺产物 ${f}（--skip-build 模式下先确认旧产物还在）"; exit 1; }
done
echo "→ 产物齐备：dmg / zip / Setup / Portable"

# 打包产物里的版本号必须与发版版本一致（防止忘 bump 就发版）
PLIST_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
    "${MAC_DIR}/mac-arm64/${APP_NAME}.app/Contents/Info.plist")
if [ "${PLIST_VERSION}" != "${VERSION}" ]; then
    echo "✗ 打包产物版本 ${PLIST_VERSION} ≠ 发版版本 ${VERSION}，先重新构建"; exit 1
fi

# ---------- appcast ----------

# 旧 appcast 取回来合并（老版本 item 保留，用户的 Sparkle 才能跨多级升级）
OLD_APPCAST="${WORK_DIR}/old-appcast.xml"
if gh release download "${TAG}" --repo "${REPO}" --pattern "appcast.xml" --dir "${WORK_DIR}" 2> /dev/null; then
    :
fi
# download 到的是「本 tag」的 appcast；若要把历史 item 带上，应取「上一个 tag」的。
# 这里直接查最近一个带 appcast 的 release：
PREV_APPCAST_URL="$(gh api "repos/${REPO}/releases?per_page=30" \
    --jq ".[] | select(.draft == false) | .assets[]? | select(.name == \"appcast.xml\") | .browser_download_url" 2> /dev/null \
    | head -1 || true)"
if [ -n "${PREV_APPCAST_URL}" ]; then
    echo "→ 取回上一个版本的 appcast 作合并基础: ${PREV_APPCAST_URL}"
    curl -sL -o "${OLD_APPCAST}" "${PREV_APPCAST_URL}"
fi

# generate_appcast 的规矩：目录里放本版 zip + （可选）旧 appcast.xml，跑完产出 appcast.xml
# 旧 item 的 enclosure 会被改写成 --download-url-prefix 指的 tag，所以旧 appcast 里
# 已经是绝对 GitHub URL 的 item 不受影响；用 fix-appcast 校正一次保险。
STAGE="${WORK_DIR}/stage"
mkdir -p "${STAGE}"
cp "${ZIP}" "${STAGE}/"
[ -f "${OLD_APPCAST}" ] && cp "${OLD_APPCAST}" "${STAGE}/appcast.xml"

echo "→ 生成 EdDSA 签名 appcast"
run "${SPARKLE_BIN}/generate_appcast" "${STAGE}" \
    --ed-key-file "${PRIVATE_KEY_FILE}" \
    --download-url-prefix "https://github.com/${REPO}/releases/download/${TAG}/"

if [ "${DRY_RUN}" != "1" ]; then
    # 旧 item 若被 prefix 改写跑偏，按各 item 自己的版本号纠正回对应 tag
    "${SPARKLE_BIN}/fix-appcast" "${STAGE}/appcast.xml" --repo "${REPO}" 2> /dev/null || true
    # 校验：本版本 item 必须在，且带签名
    grep -q "<sparkle:version>${VERSION}</sparkle:version>" "${STAGE}/appcast.xml" \
        || { echo "✗ appcast 里没有 ${VERSION} 的 item"; cat "${STAGE}/appcast.xml"; exit 1; }
    grep -q "sparkle:edSignature" "${STAGE}/appcast.xml" || { echo "✗ appcast 缺签名"; exit 1; }
fi

# ---------- 提交推送 ----------

if [ "${SKIP_BUILD}" = "0" ]; then
    echo "→ 推送 main 与 ${TAG}"
    run git -C "${PROJECT_DIR}" push origin main
fi
run git -C "${PROJECT_DIR}" tag "${TAG}" 2> /dev/null || true
run git -C "${PROJECT_DIR}" push origin "${TAG}" 2> /dev/null || true

# ---------- Release ----------

NOTES_FILE="${WORK_DIR}/notes.md"
cat > "${NOTES_FILE}" << EOF
## 更新内容

（发布时补写：本次改动要点）

### 安装包

- macOS：\`${APP_NAME}-${VERSION}-arm64.dmg\`（首次安装；老用户在应用内「设置 → 关于 → 检查更新」即可升级）
- Windows：\`${APP_NAME}-Setup-${VERSION}.exe\`（安装版）/ \`${APP_NAME}-Portable-${VERSION}.exe\`（便携版），均为 x64
EOF

echo "→ 创建 release ${TAG} 并上传资产"
run gh release create "${TAG}" --repo "${REPO}" \
    --title "${TAG}" \
    --notes-file "${NOTES_FILE}" \
    "${DMG}" "${ZIP}" "${SETUP}" "${PORTABLE}" "${STAGE}/appcast.xml"

echo ""
echo "✓ ${TAG} 发布完成（--dry-run 模式未实际执行）"
echo "  记得去 release 页把「更新内容」补写完整"
