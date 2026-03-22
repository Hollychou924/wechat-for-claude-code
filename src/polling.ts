import {
  getUpdates,
  sendTextMessage,
  sendTyping,
  getConfig,
  TypingStatus,
} from "./api.js";
import type { AccountData } from "./storage.js";
import { loadSyncBuffer, saveSyncBuffer, clearSessionId } from "./storage.js";
import { parseMessage, markdownToPlainText, splitText } from "./message.js";
import { callClaude } from "./claude.js";
import { log, logError } from "./log.js";
import {
  LONG_POLL_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  BACKOFF_DELAY_MS,
  RETRY_DELAY_MS,
  SESSION_PAUSE_MS,
  SESSION_EXPIRED_ERRCODE,
  DEDUP_TTL_MS,
  RATE_LIMIT_MS,
  TYPING_TICKET_TTL_MS,
  MAX_SESSION_EXPIRY_COUNT,
} from "./config.js";

// ── Dedup & Rate Limiting ───────────────────────────────────────────────────

const dedupCache = new Map<string, number>();
const lastMessageTime = new Map<string, number>();

function isDuplicate(senderId: string, text: string): boolean {
  const key = `${senderId}:${text.substring(0, 80)}`;
  const now = Date.now();
  const prev = dedupCache.get(key);
  if (prev && now - prev < DEDUP_TTL_MS) return true;
  dedupCache.set(key, now);
  for (const [k, ts] of dedupCache) {
    if (now - ts > DEDUP_TTL_MS) dedupCache.delete(k);
  }
  return false;
}

function isRateLimited(senderId: string): boolean {
  const now = Date.now();
  const last = lastMessageTime.get(senderId);
  if (last && now - last < RATE_LIMIT_MS) return true;
  lastMessageTime.set(senderId, now);
  return false;
}

// ── Typing Ticket Cache (with 24h TTL) ─────────────────────────────────────

const typingTicketCache = new Map<string, { ticket: string; ts: number }>();

async function getTypingTicket(
  baseUrl: string,
  token: string,
  userId: string,
  contextToken?: string,
): Promise<string | null> {
  const cached = typingTicketCache.get(userId);
  if (cached && Date.now() - cached.ts < TYPING_TICKET_TTL_MS) return cached.ticket;
  try {
    const resp = await getConfig(baseUrl, token, userId, contextToken);
    if (resp.typing_ticket) {
      typingTicketCache.set(userId, { ticket: resp.typing_ticket, ts: Date.now() });
      return resp.typing_ticket;
    }
  } catch { /* ignore */ }
  return null;
}

// ── Context Token Cache ─────────────────────────────────────────────────────

const contextTokenCache = new Map<string, string>();

// ── WeChat Commands ─────────────────────────────────────────────────────────

const HELP_TEXT = [
  "Claude Code 微信助手 可用命令：",
  "",
  "新对话 — 清除上下文，开始全新对话",
  "帮助 — 显示本帮助信息",
  "",
  "直接发送文字消息即可与 Claude 对话。",
  "支持语音消息（自动转文字）。",
  "支持引用回复。",
].join("\n");

function handleCommand(
  text: string,
  senderId: string,
): { reply: string; handled: boolean } {
  const trimmed = text.trim();

  if (trimmed === "新对话" || trimmed === "重置" || trimmed === "reset") {
    clearSessionId(senderId);
    return { reply: "已清除对话上下文，开始全新对话。", handled: true };
  }

  if (trimmed === "帮助" || trimmed === "help" || trimmed === "?") {
    return { reply: HELP_TEXT, handled: true };
  }

  return { reply: "", handled: false };
}

// ── Send Reply (with chunking + markdown strip) ─────────────────────────────

async function sendReply(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  const plain = markdownToPlainText(text);
  const chunks = splitText(plain);
  for (const chunk of chunks) {
    await sendTextMessage(baseUrl, token, to, chunk, contextToken);
  }
}

// ── Per-User Message Queue ──────────────────────────────────────────────────
// Same user's messages are processed in order (to preserve context).
// Different users run concurrently.

const userQueues = new Map<string, Promise<void>>();

function enqueueForUser(senderId: string, task: () => Promise<void>): void {
  const prev = userQueues.get(senderId) ?? Promise.resolve();
  const next = prev.then(task, task); // always proceed to next even if current fails
  userQueues.set(senderId, next);
  // Clean up reference when queue drains
  next.then(() => {
    if (userQueues.get(senderId) === next) userQueues.delete(senderId);
  });
}

// ── Process Single Message ──────────────────────────────────────────────────

async function processMessage(
  baseUrl: string,
  token: string,
  senderId: string,
  text: string,
  hasMedia: boolean,
  contextToken: string,
): Promise<void> {
  // Handle unsupported media
  if (hasMedia && !text) {
    await sendTextMessage(baseUrl, token, senderId, "暂不支持图片、文件和视频消息，请发送文字。", contextToken);
    return;
  }

  // Text + media: process text but notify about media
  if (hasMedia && text) {
    log("消息含媒体附件，仅处理文字部分");
  }

  // Handle built-in commands
  const cmd = handleCommand(text, senderId);
  if (cmd.handled) {
    await sendTextMessage(baseUrl, token, senderId, cmd.reply, contextToken);
    log(`命令处理: ${text.trim()}`);
    return;
  }

  // Send typing indicator (loop every 3s until Claude responds)
  const ticket = await getTypingTicket(baseUrl, token, senderId, contextToken);
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  if (ticket) {
    await sendTyping(baseUrl, token, senderId, ticket, TypingStatus.TYPING);
    typingInterval = setInterval(async () => {
      try {
        await sendTyping(baseUrl, token, senderId, ticket, TypingStatus.TYPING);
      } catch { /* ignore typing errors */ }
    }, 3_000);
  }

  const stopTyping = async () => {
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
    if (ticket) {
      try {
        await sendTyping(baseUrl, token, senderId, ticket, TypingStatus.CANCEL);
      } catch { /* ignore */ }
    }
  };

  // Call Claude
  try {
    log("调用 claude ...");
    const reply = await callClaude(text, senderId);
    log(`Claude 响应: "${reply.slice(0, 100)}"`);

    await stopTyping();

    if (reply) {
      await sendReply(baseUrl, token, senderId, reply, contextToken);
      log("已发送微信回复");
    }
  } catch (err) {
    logError(`Claude 处理失败: ${String(err)}`);
    await stopTyping();
    try {
      await sendTextMessage(baseUrl, token, senderId, "抱歉，处理消息时出错了，请稍后再试。", contextToken);
    } catch { /* best effort */ }
  }
}

// ── Main Polling Loop ───────────────────────────────────────────────────────

export async function startPolling(
  account: AccountData,
  abortSignal?: AbortSignal,
): Promise<void> {
  const { baseUrl, token } = account;
  let getUpdatesBuf = loadSyncBuffer();

  if (getUpdatesBuf) {
    log(`恢复同步状态 (${getUpdatesBuf.length} bytes)`);
  }

  log("开始监听微信消息...");

  let consecutiveFailures = 0;
  let sessionExpiryCount = 0;
  let nextTimeoutMs = LONG_POLL_TIMEOUT_MS;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates(baseUrl, token, getUpdatesBuf, nextTimeoutMs);

      // Adaptive timeout from server
      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isError) {
        // Session expired
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          sessionExpiryCount++;
          if (sessionExpiryCount >= MAX_SESSION_EXPIRY_COUNT) {
            logError(`微信会话已连续过期 ${sessionExpiryCount} 次，token 可能已失效。请重新运行 bun setup.ts 扫码登录。`);
          }
          logError(`微信会话已过期 (${sessionExpiryCount}/${MAX_SESSION_EXPIRY_COUNT})，暂停 ${SESSION_PAUSE_MS / 60_000} 分钟`);
          consecutiveFailures = 0;
          await sleep(SESSION_PAUSE_MS, abortSignal);
          continue;
        }

        consecutiveFailures++;
        logError(`getUpdates 失败: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;
      sessionExpiryCount = 0;

      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        saveSyncBuffer(getUpdatesBuf);
      }

      // Process messages concurrently (don't block polling loop)
      for (const msg of resp.msgs ?? []) {
        const parsed = parseMessage(msg);
        if (!parsed) continue;

        log(`收到消息: from=${parsed.senderId} text="${parsed.text.slice(0, 80)}"`);

        if (isDuplicate(parsed.senderId, parsed.text)) {
          log("重复消息，跳过");
          continue;
        }

        if (isRateLimited(parsed.senderId)) {
          log("频率限制，跳过");
          continue;
        }

        if (parsed.contextToken) {
          contextTokenCache.set(parsed.senderId, parsed.contextToken);
        }

        const contextToken = contextTokenCache.get(parsed.senderId);
        if (!contextToken) {
          logError("无 context_token，无法回复");
          continue;
        }

        // Queue per user: same user's messages run in order, different users run concurrently
        enqueueForUser(parsed.senderId, () =>
          processMessage(baseUrl, token, parsed.senderId, parsed.text, parsed.hasMedia, contextToken)
            .catch((err) => logError(`消息处理异常: ${String(err)}`)),
        );
      }
    } catch (err) {
      if (abortSignal?.aborted) return;
      consecutiveFailures++;
      logError(`轮询异常: ${String(err)}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
