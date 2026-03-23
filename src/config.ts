import path from "node:path";
import os from "node:os";

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

export const CHANNEL_VERSION = "0.3.0";
export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const BOT_TYPE = "3";

export const CREDENTIALS_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".claude",
  "channels",
  "wechat",
);
export const CREDENTIALS_FILE = path.join(CREDENTIALS_DIR, "account.json");
export const SYNC_BUF_FILE = path.join(CREDENTIALS_DIR, "sync_buf.txt");
export const SESSION_DIR = path.join(CREDENTIALS_DIR, "sessions");

// All timeouts can be overridden via environment variables (in seconds)
export const LONG_POLL_TIMEOUT_MS = 35_000;
export const CLAUDE_TIMEOUT_MS = envInt("CLAUDE_TIMEOUT", 300) * 1000;
export const MAX_CONSECUTIVE_FAILURES = 3;
export const BACKOFF_DELAY_MS = 30_000;
export const RETRY_DELAY_MS = 2_000;
export const SESSION_PAUSE_MS = 300_000;
export const SESSION_EXPIRED_ERRCODE = -14;
export const MAX_SEND_CHUNK = envInt("MAX_SEND_CHUNK", 4000);
export const DEDUP_TTL_MS = 660_000;
export const RATE_LIMIT_MS = envInt("RATE_LIMIT", 3) * 1000;
export const MAX_QR_REFRESH = 3;
export const TYPING_TICKET_TTL_MS = 24 * 3_600_000; // 24h
export const SESSION_MAX_AGE_MS = 30 * 86_400_000; // 30 days
export const MAX_SESSION_EXPIRY_COUNT = 5; // consecutive session expiries before warning
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const MEDIA_TEMP_DIR = path.join(os.tmpdir(), "wechat-claude-media");
