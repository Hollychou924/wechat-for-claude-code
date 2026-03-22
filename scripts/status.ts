#!/usr/bin/env bun
/**
 * Check the status of the WeChat bridge service (cross-platform).
 */

import fs from "node:fs";
import { execSync } from "node:child_process";
import { CREDENTIALS_FILE } from "../src/config.js";
import { getServiceStatus, getServiceConfigPath } from "../src/service.js";

function main() {
  console.log("=== Claude Code WeChat Bridge 状态 ===\n");

  // Check credentials
  if (fs.existsSync(CREDENTIALS_FILE)) {
    try {
      const creds = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
      console.log(`微信账号: ${creds.accountId}`);
      console.log(`登录时间: ${creds.savedAt}`);
    } catch {
      console.log("微信账号: 凭据文件损坏（运行 bun setup.ts 重新登录）");
    }
  } else {
    console.log("微信账号: 未登录（运行 bun setup.ts 扫码登录）");
  }

  // Check service
  const status = getServiceStatus();
  if (status.installed) {
    if (status.running) {
      console.log(`服务状态: 运行中${status.pid ? ` (PID: ${status.pid})` : ""}`);
    } else {
      console.log("服务状态: 已停止");
    }
    console.log(`服务配置: ${getServiceConfigPath()}`);
  } else {
    console.log("服务状态: 未安装（运行 bun setup.ts 安装）");
  }

  // Check claude CLI
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    const claudePath = execSync(cmd, { encoding: "utf-8" }).trim().split("\n")[0];
    console.log(`Claude CLI: ${claudePath}`);
  } catch {
    console.log("Claude CLI: 未找到（请先安装 Claude Code）");
  }

  // Check latest log
  try {
    const files = fs.readdirSync(".").filter((f) => f.startsWith("bridge-") && f.endsWith(".log"));
    if (files.length > 0) {
      const latest = files.sort().pop()!;
      const stat = fs.statSync(latest);
      const ago = Math.round((Date.now() - stat.mtimeMs) / 1000);
      const agoStr = ago < 60 ? `${ago}秒前` : ago < 3600 ? `${Math.round(ago / 60)}分钟前` : `${Math.round(ago / 3600)}小时前`;
      console.log(`最新日志: ${latest} (更新于 ${agoStr})`);
    }
  } catch { /* ignore */ }

  console.log();
}

main();
