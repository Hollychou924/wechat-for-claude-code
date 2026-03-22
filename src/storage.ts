import fs from "node:fs";
import path from "node:path";
import { CREDENTIALS_DIR, CREDENTIALS_FILE, SYNC_BUF_FILE, SESSION_DIR, SESSION_MAX_AGE_MS } from "./config.js";

export type AccountData = {
  token: string;
  baseUrl: string;
  accountId: string;
  userId?: string;
  savedAt: string;
};

export function loadCredentials(): AccountData | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
    if (!data.token || !data.baseUrl || !data.accountId) {
      process.stderr.write("[wechat-bridge] 凭据文件损坏或不完整，请重新运行 bun setup.ts\n");
      return null;
    }
    return data;
  } catch {
    process.stderr.write("[wechat-bridge] 凭据文件解析失败，请重新运行 bun setup.ts\n");
    return null;
  }
}

export function saveCredentials(data: AccountData): void {
  fs.mkdirSync(CREDENTIALS_DIR, { recursive: true });
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), "utf-8");
  try { fs.chmodSync(CREDENTIALS_FILE, 0o600); } catch { /* best-effort */ }
}

export function loadSyncBuffer(): string {
  try {
    if (fs.existsSync(SYNC_BUF_FILE)) return fs.readFileSync(SYNC_BUF_FILE, "utf-8");
  } catch { /* ignore */ }
  return "";
}

export function saveSyncBuffer(buf: string): void {
  try { fs.writeFileSync(SYNC_BUF_FILE, buf, "utf-8"); } catch { /* ignore */ }
}

export function getSessionId(senderId: string): string | null {
  const cached = sessionCache.get(senderId);
  if (cached) return cached;
  const file = `${SESSION_DIR}/${senderId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`;
  try {
    if (fs.existsSync(file)) {
      const id = fs.readFileSync(file, "utf-8").trim();
      if (id) sessionCache.set(senderId, id);
      return id || null;
    }
  } catch { /* ignore */ }
  return null;
}

export function saveSessionId(senderId: string, sessionId: string): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  const file = `${SESSION_DIR}/${senderId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`;
  fs.writeFileSync(file, sessionId, "utf-8");
  sessionCache.set(senderId, sessionId);
}

export function clearSessionId(senderId: string): void {
  const file = `${SESSION_DIR}/${senderId.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`;
  try { fs.unlinkSync(file); } catch { /* ignore */ }
  sessionCache.delete(senderId);
}

// ── In-memory session cache ─────────────────────────────────────────────────

const sessionCache = new Map<string, string>();

// ── Session cleanup ─────────────────────────────────────────────────────────

export function cleanOldSessions(): void {
  try {
    if (!fs.existsSync(SESSION_DIR)) return;
    const files = fs.readdirSync(SESSION_DIR);
    const cutoff = Date.now() - SESSION_MAX_AGE_MS;
    let cleaned = 0;
    for (const f of files) {
      const filePath = path.join(SESSION_DIR, f);
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch { /* ignore */ }
    }
    if (cleaned > 0) {
      process.stderr.write(`[wechat-bridge] 已清理 ${cleaned} 个过期会话文件\n`);
    }
  } catch { /* ignore */ }
}
