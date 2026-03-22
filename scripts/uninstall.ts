#!/usr/bin/env bun
/**
 * Uninstall the WeChat bridge service and optionally clean up data (cross-platform).
 */

import fs from "node:fs";
import { CREDENTIALS_DIR } from "../src/config.js";
import { uninstallService, getServiceStatus } from "../src/service.js";

function ask(question: string): Promise<string> {
  return new Promise(async (resolve) => {
    const readline = await import("node:readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

async function main() {
  console.log("=== 卸载 Claude Code WeChat Bridge ===\n");

  // Remove service
  const status = getServiceStatus();
  if (status.installed) {
    if (uninstallService()) {
      console.log("已移除后台服务");
    } else {
      console.log("移除服务失败，请手动清理");
    }
  } else {
    console.log("未找到已安装的服务");
  }

  // Ask about credentials
  if (fs.existsSync(CREDENTIALS_DIR)) {
    const answer = await ask("\n是否同时删除微信凭据和会话数据？(y/N) ");
    if (answer.toLowerCase() === "y") {
      fs.rmSync(CREDENTIALS_DIR, { recursive: true, force: true });
      console.log("已删除凭据和会话数据");
    } else {
      console.log("保留凭据数据");
    }
  }

  // Clean up log files
  try {
    const logFiles = fs.readdirSync(".").filter(
      (f) => (f.startsWith("bridge-") && f.endsWith(".log")) || f === "bridge.log",
    );
    if (logFiles.length > 0) {
      const answer = await ask(`\n是否删除日志文件？(${logFiles.length} 个) (y/N) `);
      if (answer.toLowerCase() === "y") {
        for (const f of logFiles) {
          try { fs.unlinkSync(f); } catch { /* ignore */ }
        }
        console.log("已删除日志文件");
      }
    }
  } catch { /* ignore */ }

  console.log("\n卸载完成。如需重新使用，运行 bun setup.ts");
  process.exit(0);
}

main().catch((err) => {
  console.error(`错误: ${err}`);
  process.exit(1);
});
