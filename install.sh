#!/usr/bin/env bash
# WeChat for Claude Code — 一键安装脚本
# 用法: curl -fsSL https://raw.githubusercontent.com/Hollychou924/wechat-for-claude-code/main/install.sh | bash
set -e

INSTALL_DIR="$HOME/.wechat-for-claude-code"
REPO="https://github.com/Hollychou924/wechat-for-claude-code.git"

echo ""
echo "=============================="
echo " WeChat for Claude Code 安装器"
echo "=============================="
echo ""

# ── 1. 检测 / 安装 Bun ────────────────────────────────────────

if command -v bun &>/dev/null; then
  echo "[✓] Bun 已安装: $(bun --version)"
else
  echo "[·] 正在安装 Bun..."
  curl -fsSL https://bun.sh/install | bash
  # Source the updated profile so bun is available
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if command -v bun &>/dev/null; then
    echo "[✓] Bun 安装成功: $(bun --version)"
  else
    echo "[✗] Bun 安装失败，请手动安装: https://bun.sh"
    exit 1
  fi
fi

# ── 2. 检测 Claude Code ──────────────────────────────────────

if command -v claude &>/dev/null; then
  echo "[✓] Claude Code 已安装: $(which claude)"
else
  echo ""
  echo "[✗] 未找到 claude 命令。"
  echo ""
  echo "    请先安装 Claude Code 并登录："
  echo "      npm install -g @anthropic-ai/claude-code"
  echo "      claude"
  echo ""
  echo "    登录完成后重新运行本脚本。"
  exit 1
fi

# ── 3. 下载 / 更新项目 ───────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "[·] 更新项目..."
  git -C "$INSTALL_DIR" pull --ff-only 2>/dev/null || true
else
  if [ -d "$INSTALL_DIR" ]; then
    rm -rf "$INSTALL_DIR"
  fi
  echo "[·] 下载项目..."
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi

# ── 4. 安装依赖 + 扫码 + 自启服务 ────────────────────────────

cd "$INSTALL_DIR"
bun install --silent 2>/dev/null || bun install

echo ""
echo "=============================="
echo " 请准备好微信，等待二维码出现"
echo "=============================="
echo ""

bun setup.ts --auto

echo ""
echo "=============================="
echo " 安装完成！"
echo "=============================="
echo ""
echo "现在打开微信，找到 ClawBot 对话，发条消息试试。"
echo ""
echo "管理命令："
echo "  cd $INSTALL_DIR && bun run status      # 查看状态"
echo "  cd $INSTALL_DIR && bun run uninstall   # 卸载"
echo ""
