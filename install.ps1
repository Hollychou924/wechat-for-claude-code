# WeChat for Claude Code — Windows 一键安装脚本
# 用法: irm https://raw.githubusercontent.com/Hollychou924/wechat-for-claude-code/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
$InstallDir = "$env:USERPROFILE\.wechat-for-claude-code"
$Repo = "https://github.com/Hollychou924/wechat-for-claude-code.git"

Write-Host ""
Write-Host "=============================="
Write-Host " WeChat for Claude Code 安装器"
Write-Host "=============================="
Write-Host ""

# ── 1. 检测 / 安装 Bun ────────────────────────────────────────

$bunPath = Get-Command bun -ErrorAction SilentlyContinue
if ($bunPath) {
    Write-Host "[OK] Bun 已安装: $($bunPath.Source)"
} else {
    Write-Host "[..] 正在安装 Bun..."
    irm bun.sh/install.ps1 | iex
    # Refresh PATH
    $env:BUN_INSTALL = "$env:USERPROFILE\.bun"
    $env:PATH = "$env:BUN_INSTALL\bin;$env:PATH"
    $bunPath = Get-Command bun -ErrorAction SilentlyContinue
    if ($bunPath) {
        Write-Host "[OK] Bun 安装成功"
    } else {
        Write-Host "[FAIL] Bun 安装失败，请手动安装: https://bun.sh"
        exit 1
    }
}

# ── 2. 检测 Claude Code ──────────────────────────────────────

$claudePath = Get-Command claude -ErrorAction SilentlyContinue
if ($claudePath) {
    Write-Host "[OK] Claude Code 已安装: $($claudePath.Source)"
} else {
    Write-Host ""
    Write-Host "[FAIL] 未找到 claude 命令。"
    Write-Host ""
    Write-Host "    请先安装 Claude Code 并登录："
    Write-Host "      npm install -g @anthropic-ai/claude-code"
    Write-Host "      claude"
    Write-Host ""
    Write-Host "    登录完成后重新运行本脚本。"
    exit 1
}

# ── 3. 下载 / 更新项目 ───────────────────────────────────────

if (Test-Path "$InstallDir\.git") {
    Write-Host "[..] 更新项目..."
    git -C $InstallDir pull --ff-only 2>$null
} else {
    if (Test-Path $InstallDir) {
        Remove-Item -Recurse -Force $InstallDir
    }
    Write-Host "[..] 下载项目..."
    git clone --depth 1 $Repo $InstallDir
}

# ── 4. 安装依赖 + 扫码 + 自启服务 ────────────────────────────

Set-Location $InstallDir
bun install

Write-Host ""
Write-Host "=============================="
Write-Host " 请准备好微信，等待二维码出现"
Write-Host "=============================="
Write-Host ""

bun setup.ts --auto

Write-Host ""
Write-Host "=============================="
Write-Host " 安装完成！"
Write-Host "=============================="
Write-Host ""
Write-Host "现在打开微信，找到 ClawBot 对话，发条消息试试。"
Write-Host ""
Write-Host "管理命令："
Write-Host "  cd $InstallDir; bun run status      # 查看状态"
Write-Host "  cd $InstallDir; bun run uninstall   # 卸载"
Write-Host ""
