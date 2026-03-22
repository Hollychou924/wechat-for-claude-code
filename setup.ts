#!/usr/bin/env bun
/**
 * WeChat Setup — QR login + background service install.
 *
 * Usage:
 *   bun setup.ts            # Interactive: login + ask to install service
 *   bun setup.ts --auto     # Non-interactive: login + auto-install service
 *   bun setup.ts --service  # Only install/reinstall the background service
 */

import fs from "node:fs";
import { execSync } from "node:child_process";
import { CREDENTIALS_FILE } from "./src/config.js";
import { doQRLogin } from "./src/auth.js";
import { installService, getServiceConfigPath, isPlatformSupported } from "./src/service.js";

const AUTO = process.argv.includes("--auto");

function ask(question: string): Promise<string> {
  if (AUTO) return Promise.resolve("y");
  return new Promise(async (resolve) => {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

function ensureDependencies(): void {
  if (!fs.existsSync("node_modules")) {
    console.log("正在安装依赖...");
    try {
      execSync("bun install", { stdio: "inherit" });
    } catch {
      console.error("依赖安装失败，请手动运行 bun install");
      process.exit(1);
    }
  }
}

function checkClaudeCLI(): void {
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    execSync(cmd, { stdio: "pipe" });
  } catch {
    console.error("未找到 claude 命令。");
    console.error("");
    console.error("请先安装 Claude Code：");
    console.error("  npm install -g @anthropic-ai/claude-code");
    console.error("");
    console.error("安装后运行 claude 登录你的 claude.ai 账号，然后重新运行本脚本。");
    process.exit(1);
  }
}

async function main() {
  ensureDependencies();
  checkClaudeCLI();

  const serviceOnly = process.argv.includes("--service");

  if (serviceOnly) {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      console.error("未找到微信凭据，请先运行 bun setup.ts 进行扫码登录。");
      process.exit(1);
    }
    if (!isPlatformSupported()) {
      console.error(`当前平台 (${process.platform}) 不支持后台服务，请使用 bun start 手动启动。`);
      process.exit(1);
    }
    if (installService()) {
      console.log("服务已安装并启动。");
      console.log(`配置: ${getServiceConfigPath()}`);
    } else {
      console.error("服务安装失败。");
      process.exit(1);
    }
    process.exit(0);
  }

  // Full setup: login + service
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const existing = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
      console.log(`已有保存的账号: ${existing.accountId}`);
      console.log(`保存时间: ${existing.savedAt}`);
      console.log();
      const answer = await ask("是否重新登录？(y/N) ");
      if (answer.toLowerCase() !== "y" && !AUTO) {
        console.log("保持现有凭据。");
        await doServiceInstall();
        process.exit(0);
      }
    } catch { /* ignore */ }
  }

  const account = await doQRLogin();
  if (!account) {
    console.error("\n登录失败。");
    process.exit(1);
  }

  console.log(`\n账号 ID: ${account.accountId}`);
  console.log(`凭据保存至: ${CREDENTIALS_FILE}`);

  await doServiceInstall();
  process.exit(0);
}

async function doServiceInstall() {
  if (!isPlatformSupported()) {
    if (!AUTO) {
      console.log("\n启动微信桥接：");
      console.log("  bun start");
    }
    return;
  }

  const platformNames: Record<string, string> = {
    darwin: "macOS 开机自启服务 (launchd)",
    linux: "Linux 用户服务 (systemd)",
    win32: "Windows 登录自启任务 (Task Scheduler)",
  };
  const name = platformNames[process.platform] || "后台服务";

  if (!AUTO) {
    console.log();
    const answer = await ask(`是否安装为${name}？(Y/n) `);
    if (answer.toLowerCase() === "n") {
      console.log("\n手动启动：");
      console.log("  bun start");
      return;
    }
  }

  if (installService()) {
    console.log(`\n已安装${name}，微信桥接已在后台运行。`);
    console.log(`配置: ${getServiceConfigPath()}`);
    if (!AUTO) {
      console.log();
      console.log("管理命令：");
      console.log("  bun run status      — 查看服务状态");
      console.log("  bun run uninstall   — 卸载服务");
    }
  } else {
    console.log("\n服务安装失败，手动启动：");
    console.log("  bun start");
  }
}

main().catch((err) => {
  console.error(`错误: ${err}`);
  process.exit(1);
});
