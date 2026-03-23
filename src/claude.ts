import { spawn } from "node:child_process";
import { CLAUDE_TIMEOUT_MS } from "./config.js";
import { getSessionId, saveSessionId, clearSessionId } from "./storage.js";
import { log, logError } from "./log.js";

/**
 * Spawn claude CLI and return { result, stdout, stderr, code }.
 */
function runClaude(text: string, sessionId: string | null): Promise<{ result: string; code: number | null; stderr: string; sessionId?: string }> {
  return new Promise((resolve, reject) => {
    const args = ["-p", "--output-format", "json", "--dangerously-skip-permissions"];
    if (sessionId) {
      args.push("--resume", sessionId);
    }

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
        resolve({ result: "", code, stderr, sessionId: undefined });
        return;
      }

      try {
        const json = JSON.parse(stdout);
        resolve({ result: json.result ?? "", code: 0, stderr, sessionId: json.session_id });
      } catch {
        resolve({ result: stdout.trim(), code: 0, stderr, sessionId: undefined });
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

/**
 * Call Claude Code CLI in pipe mode with session persistence per user.
 * If a saved session no longer exists, automatically clears it and retries as new.
 */
export async function callClaude(text: string, senderId: string): Promise<string> {
  const sessionId = getSessionId(senderId);
  log(`claude (session: ${sessionId ?? "new"})`);

  const res = await runClaude(text, sessionId);

  // Session not found — clear stale session and retry without --resume
  if (res.code !== 0 && sessionId && res.stderr.includes("No conversation found with session ID")) {
    log(`会话 ${sessionId} 已失效，清除并重试`);
    clearSessionId(senderId);
    const retry = await runClaude(text, null);
    if (retry.code !== 0) {
      throw new Error(`claude 退出码 ${retry.code}: ${retry.stderr}`);
    }
    if (retry.sessionId) {
      saveSessionId(senderId, retry.sessionId);
      log(`会话已保存: ${retry.sessionId}`);
    }
    return retry.result;
  }

  if (res.code !== 0) {
    throw new Error(`claude 退出码 ${res.code}: ${res.stderr}`);
  }

  if (res.sessionId) {
    saveSessionId(senderId, res.sessionId);
    log(`会话已保存: ${res.sessionId}`);
  }

  return res.result;
}
