#!/bin/sh
# happy CLI 一键安装脚本
#
# 用法：
#   curl -fsSL https://open-1.kfafa.cn:30010/sunflowerfa/happy/raw/branch/main/install.sh | sh
#
# 支持平台：macOS arm64, macOS x64, Linux x64, Linux arm64, Windows x64 (via Git Bash / WSL)
#
# 装哪里：
#   ~/.local/share/happy/<version>/    解压后的 bundle
#   ~/.local/bin/happy                 symlink → bundle 里的 bin/happy.mjs
#   ~/.happy/settings.json             默认 server URL
#
# 卸载：
#   rm -rf ~/.local/share/happy ~/.local/bin/happy ~/.local/bin/happy-mcp ~/.happy

set -eu

# ====== 配置（发新版本时改 HAPPY_CLI_VERSION 即可）======
HAPPY_CLI_VERSION="${HAPPY_CLI_VERSION:-1.1.10-beta.4}"
GITHUB_OWNER="sunflowerfa"
GITHUB_REPO="happy-remote"
DEFAULT_SERVER_URL="https://open-1.kfafa.cn:33333"
# =====================================================

RELEASE_TAG="happy-cli-v${HAPPY_CLI_VERSION}"
RELEASE_BASE="https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${RELEASE_TAG}"
INSTALL_ROOT="${HOME}/.local/share/happy"
INSTALL_DIR="${INSTALL_ROOT}/${HAPPY_CLI_VERSION}"
BIN_DIR="${HOME}/.local/bin"
SETTINGS_DIR="${HOME}/.happy"

# ---------- 终端颜色（兼容无 tty 环境） ----------
if [ -t 1 ]; then
    BOLD="\033[1m"; RED="\033[31m"; GREEN="\033[32m"; YELLOW="\033[33m"; BLUE="\033[34m"; RESET="\033[0m"
else
    BOLD=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

die()   { printf "${RED}✖${RESET} %s\n" "$*" >&2; exit 1; }
info()  { printf "${BLUE}→${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$*"; }

# ---------- 1. 检测平台 ----------
detect_platform() {
    OS="$(uname -s 2>/dev/null || echo unknown)"
    ARCH="$(uname -m 2>/dev/null || echo unknown)"

    case "$OS" in
        Darwin)
            case "$ARCH" in
                arm64|aarch64) PLATFORM="macos-arm64"; ARCHIVE_EXT="tar.gz" ;;
                x86_64)        PLATFORM="macos-x64";   ARCHIVE_EXT="tar.gz" ;;
                *) die "不支持的 macOS 架构：$ARCH" ;;
            esac
            ;;
        Linux)
            case "$ARCH" in
                x86_64|amd64)  PLATFORM="linux-x64";   ARCHIVE_EXT="tar.gz" ;;
                aarch64|arm64) PLATFORM="linux-arm64"; ARCHIVE_EXT="tar.gz" ;;
                *) die "不支持的 Linux 架构：$ARCH" ;;
            esac
            ;;
        MINGW*|MSYS*|CYGWIN*)
            # Windows Git Bash / MSYS2
            PLATFORM="windows-x64"; ARCHIVE_EXT="zip"
            ;;
        *)
            die "不支持的操作系统：$OS （请用 macOS / Linux / Windows）"
            ;;
    esac
}

# ---------- 2. 检测依赖 ----------
check_deps() {
    # node ≥ 20 是必需的（bundle 里 vendored 了 node_modules，但 happy.mjs 仍要 node 运行时）
    if ! command -v node >/dev/null 2>&1; then
        die "需要 Node.js ≥ 20。安装：https://nodejs.org/  或  brew install node  或  curl -fsSL https://fnm.vercel.app/install | bash"
    fi
    NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
    if [ "$NODE_MAJOR" -lt 20 ]; then
        die "Node.js 版本 $(node -v) 太低，需要 ≥ 20"
    fi

    # 下载工具
    if command -v curl >/dev/null 2>&1; then
        DL="curl -fsSL -o"
    elif command -v wget >/dev/null 2>&1; then
        DL="wget -qO"
    else
        die "需要 curl 或 wget"
    fi

    # 解压工具
    if [ "$ARCHIVE_EXT" = "zip" ]; then
        command -v unzip >/dev/null 2>&1 || die "需要 unzip 命令（Windows Git Bash 自带）"
    else
        command -v tar >/dev/null 2>&1 || die "需要 tar 命令"
    fi
}

# ---------- 3. 下载 + 解压 ----------
download_and_extract() {
    TARBALL_NAME="happy-cli-${HAPPY_CLI_VERSION}-${PLATFORM}.${ARCHIVE_EXT}"
    URL="${RELEASE_BASE}/${TARBALL_NAME}"
    TMP=$(mktemp -d)
    trap 'rm -rf "$TMP"' EXIT

    info "下载 ${TARBALL_NAME}"
    info "  ← ${URL}"
    $DL "${TMP}/${TARBALL_NAME}" "${URL}" || die "下载失败 — 请检查 Release 是否存在该资产（${RELEASE_TAG} / ${TARBALL_NAME}）"

    info "解压到 ${INSTALL_DIR}"
    rm -rf "${INSTALL_DIR}"
    mkdir -p "${INSTALL_DIR}"
    if [ "$ARCHIVE_EXT" = "zip" ]; then
        unzip -q "${TMP}/${TARBALL_NAME}" -d "${TMP}/extract"
    else
        mkdir -p "${TMP}/extract"
        tar -xzf "${TMP}/${TARBALL_NAME}" -C "${TMP}/extract"
    fi

    # tarball 顶层是 happy-cli-${VERSION}-${PLATFORM}/，把里面的内容平铺到 INSTALL_DIR
    INNER=$(find "${TMP}/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)
    if [ -z "$INNER" ]; then die "tarball 结构异常"; fi
    cp -R "${INNER}/." "${INSTALL_DIR}/"

    # 关键文件存在性检查
    [ -f "${INSTALL_DIR}/bin/happy.mjs" ] || die "bundle 缺少 bin/happy.mjs"
    [ -d "${INSTALL_DIR}/node_modules" ] || die "bundle 缺少 vendored node_modules"
    NATIVE=$(find "${INSTALL_DIR}/node_modules/node-pty" -name "*.node" 2>/dev/null | head -1 || true)
    [ -n "$NATIVE" ] || die "bundle 缺少 node-pty native binding（构建时未在 ${PLATFORM} 编译）"
    ok "解压完成 + 完整性校验通过"
}

# ---------- 4. 安装 symlink 到 ~/.local/bin ----------
link_bin() {
    mkdir -p "${BIN_DIR}"
    ln -sfn "${INSTALL_DIR}/bin/happy.mjs" "${BIN_DIR}/happy"
    chmod +x "${INSTALL_DIR}/bin/happy.mjs"
    if [ -f "${INSTALL_DIR}/bin/happy-mcp.mjs" ]; then
        ln -sfn "${INSTALL_DIR}/bin/happy-mcp.mjs" "${BIN_DIR}/happy-mcp"
        chmod +x "${INSTALL_DIR}/bin/happy-mcp.mjs"
    fi
    ok "symlink: ${BIN_DIR}/happy → ${INSTALL_DIR}/bin/happy.mjs"
}

# ---------- 5. 写入默认 server URL ----------
write_settings() {
    mkdir -p "${SETTINGS_DIR}"
    SETTINGS_FILE="${SETTINGS_DIR}/settings.json"
    if [ -f "${SETTINGS_FILE}" ]; then
        # 已有设置，不覆盖
        if grep -q "${DEFAULT_SERVER_URL}" "${SETTINGS_FILE}" 2>/dev/null; then
            ok "settings.json 已指向 ${DEFAULT_SERVER_URL}"
        else
            warn "${SETTINGS_FILE} 已存在且未指向 ${DEFAULT_SERVER_URL}，未覆盖。如需切换，手动编辑或删除该文件后重跑。"
        fi
    else
        printf '{\n  "serverUrl": "%s"\n}\n' "${DEFAULT_SERVER_URL}" > "${SETTINGS_FILE}"
        ok "settings.json 写入：serverUrl = ${DEFAULT_SERVER_URL}"
    fi
}

# ---------- 6. PATH 检查 + 收尾 ----------
post_install() {
    if ! echo ":${PATH}:" | grep -q ":${BIN_DIR}:"; then
        warn "${BIN_DIR} 不在你的 PATH 中。把下面一行加到 ~/.zshrc 或 ~/.bashrc："
        printf "\n  ${BOLD}export PATH=\"\$HOME/.local/bin:\$PATH\"${RESET}\n\n"
        warn "然后 source 或重开终端"
    fi

    printf "\n${GREEN}${BOLD}✓ happy 已安装${RESET}  (版本 ${HAPPY_CLI_VERSION}，平台 ${PLATFORM})\n"
    printf "\n开始用：\n"
    printf "  ${BOLD}happy claude${RESET}\n\n"
    printf "服务器：${BLUE}${DEFAULT_SERVER_URL}${RESET}\n"
    printf "切换服务器：${BOLD}HAPPY_SERVER_URL=https://your-server happy claude${RESET}\n"
    printf "卸载：${BOLD}rm -rf ${INSTALL_ROOT} ${BIN_DIR}/happy ${BIN_DIR}/happy-mcp${RESET}\n\n"
}

# ---------- main ----------
echo
printf "${BOLD}happy CLI installer${RESET}  (v${HAPPY_CLI_VERSION})\n"
echo
detect_platform
info "检测到平台：${PLATFORM}"
check_deps
ok "依赖检查通过 (node $(node -v))"
download_and_extract
link_bin
write_settings
post_install
