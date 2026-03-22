#!/usr/bin/env bun
/**
 * WeChat ↔ Claude Code Bridge
 *
 * Polls WeChat messages via the official ilink API and processes them
 * with Claude Code CLI (claude -p). Uses the existing claude.ai login.
 *
 * Usage: bun src/index.ts
 */

import { execSync } from "node:child_process";
import { loadCredentials, cleanOldSessions } from "./storage.js";
import { doQRLogin } from "./auth.js";
import { startPolling } from "./polling.js";
import { log, logError } from "./log.js";

const abortController = new AbortController();

// Graceful shutdown
process.on("SIGTERM", () => {
  log("收到 SIGTERM，正在停止...");
  abortController.abort();
});
process.on("SIGINT", () => {
  log("收到 SIGINT，正在停止...");
  abortController.abort();
});

function checkClaudeCLI(): boolean {
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    execSync(cmd, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Pre-flight check: claude CLI must be available
  if (!checkClaudeCLI()) {
    logError("未找到 claude 命令。请先安装 Claude Code：npm install -g @anthropic-ai/claude-code");
    logError("安装后运行 claude 登录你的 claude.ai 账号。");
    process.exit(1);
  }

  let account = loadCredentials();

  if (!account) {
    log("未找到微信凭据，启动扫码登录...");
    account = await doQRLogin();
    if (!account) {
      logError("登录失败，退出。");
      process.exit(1);
    }
  } else {
    log(`已加载账号: ${account.accountId}`);
  }

  // Clean up old session files on startup
  cleanOldSessions();

  await startPolling(account, abortController.signal);
  log("已停止。");
}

main().catch((err) => {
  logError(`Fatal: ${String(err)}`);
  process.exit(1);
});
