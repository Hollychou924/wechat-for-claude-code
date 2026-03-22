import { spawn } from "node:child_process";
import { CLAUDE_TIMEOUT_MS } from "./config.js";
import { getSessionId, saveSessionId } from "./storage.js";
import { log, logError } from "./log.js";

/**
 * Call Claude Code CLI in pipe mode with session persistence per user.
 * Uses --output-format json to extract session_id for conversation continuity.
 */
export async function callClaude(text: string, senderId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sessionId = getSessionId(senderId);
    const args = ["-p", "--output-format", "json"];
    if (sessionId) {
      args.push("--resume", sessionId);
    }

    log(`claude (session: ${sessionId ?? "new"})`);

    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Claude 响应超时"));
    }, CLAUDE_TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude 退出码 ${code}: ${stderr}`));
        return;
      }

      try {
        const json = JSON.parse(stdout);
        const result = json.result ?? "";
        const newSessionId = json.session_id;

        if (newSessionId) {
          saveSessionId(senderId, newSessionId);
          log(`会话已保存: ${newSessionId}`);
        }

        resolve(result);
      } catch {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.stdin.write(text);
    proc.stdin.end();
  });
}
