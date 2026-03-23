import {
  getUpdates,
  sendTextMessage,
  sendImageMessage,
  getUploadUrl,
  sendTyping,
  getConfig,
  TypingStatus,
} from "./api.js";
import fs from "node:fs";
import path from "node:path";
import type { AccountData } from "./storage.js";
import { loadSyncBuffer, saveSyncBuffer, clearSessionId, getSessionId } from "./storage.js";
import { parseMessage, markdownToPlainText, splitText } from "./message.js";
import type { MediaInfo } from "./message.js";
import { callClaude } from "./claude.js";
import { downloadAndDecrypt, downloadPlain, uploadFileToCdn } from "./cdn.js";
import { log, logError } from "./log.js";
import { execFileSync } from "node:child_process";
import {
  CHANNEL_VERSION,
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
  CDN_BASE_URL,
  MEDIA_TEMP_DIR,
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
  "调试 — 查看当前运行状态",
  "帮助 — 显示本帮助信息",
  "",
  "直接发送文字消息即可与 Claude 对话。",
  "支持发送图片、文件（Claude 自动识别）。",
  "支持语音消息（自动转文字）。",
  "支持引用回复。",
].join("\n");

let cachedClaudeVersion: string | null = null;

function getClaudeVersion(): string {
  if (cachedClaudeVersion) return cachedClaudeVersion;
  try {
    cachedClaudeVersion = execFileSync("claude", ["--version"], { timeout: 5_000 })
      .toString().trim().split("\n")[0];
  } catch {
    cachedClaudeVersion = "未知";
  }
  return cachedClaudeVersion;
}

function buildDebugInfo(senderId: string): string {
  const sessionId = getSessionId(senderId);
  const contextToken = contextTokenCache.get(senderId);
  const ticket = typingTicketCache.get(senderId);
  const queueActive = userQueues.has(senderId);
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const mins = Math.floor((uptime % 3600) / 60);

  return [
    "-- 调试信息 --",
    `桥接版本: ${CHANNEL_VERSION}`,
    `Claude Code: ${getClaudeVersion()}`,
    `Bun: ${typeof Bun !== "undefined" ? Bun.version : process.version}`,
    `运行时长: ${hours}h ${mins}m`,
    `会话ID: ${sessionId ? sessionId.slice(0, 12) + "..." : "无"}`,
    `ContextToken: ${contextToken ? "有" : "无"}`,
    `TypingTicket: ${ticket ? "有" : "无"}`,
    `消息队列: ${queueActive ? "处理中" : "空闲"}`,
    `去重缓存: ${dedupCache.size} 条`,
    `内存: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
    `系统: ${process.platform} ${process.arch}`,
  ].join("\n");
}

function handleCommand(
  text: string,
  senderId: string,
): { reply: string; handled: boolean } {
  const trimmed = text.trim();

  if (trimmed === "新对话" || trimmed === "重置" || trimmed === "reset") {
    clearSessionId(senderId);
    return { reply: "已清除对话上下文，开始全新对话。", handled: true };
  }

  if (trimmed === "调试" || trimmed === "debug" || trimmed === "状态" || trimmed === "status") {
    return { reply: buildDebugInfo(senderId), handled: true };
  }

  if (trimmed === "帮助" || trimmed === "help" || trimmed === "?") {
    return { reply: HELP_TEXT, handled: true };
  }

  return { reply: "", handled: false };
}

// ── Media Download ──────────────────────────────────────────────────────────

const MEDIA_EXT: Record<string, string> = { image: ".png", file: "", video: ".mp4" };

async function downloadMedia(items: MediaInfo[]): Promise<{ paths: string[]; errors: string[] }> {
  fs.mkdirSync(MEDIA_TEMP_DIR, { recursive: true });
  const paths: string[] = [];
  const errors: string[] = [];

  for (const item of items) {
    if (item.type === "video") {
      errors.push("视频");
      continue;
    }
    try {
      const ext = item.fileName
        ? path.extname(item.fileName) || MEDIA_EXT[item.type]
        : MEDIA_EXT[item.type];
      const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
      const filePath = path.join(MEDIA_TEMP_DIR, fileName);

      const buf = item.aesKey
        ? await downloadAndDecrypt(item.encryptQueryParam, item.aesKey, CDN_BASE_URL)
        : await downloadPlain(item.encryptQueryParam, CDN_BASE_URL);

      fs.writeFileSync(filePath, buf);
      log(`媒体已保存: ${filePath} (${buf.length} 字节)`);
      paths.push(filePath);
    } catch (err) {
      logError(`媒体下载失败: ${String(err)}`);
      errors.push(item.type === "image" ? "图片" : "文件");
    }
  }
  return { paths, errors };
}

// ── Image Detection in Claude Response ───────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/** Match local image file paths in Claude's response */
const LOCAL_IMAGE_RE = /(?:^|\s)(\/[^\s]+\.(?:png|jpe?g|gif|webp|bmp))(?:\s|$|[,.)。，])/gi;

/** Match remote image URLs in Claude's response */
const REMOTE_IMAGE_RE = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|bmp)(?:\?[^\s"'<>]*)?/gi;

/** Extract image paths/URLs from Claude's text response */
function extractImagesFromReply(text: string): { localPaths: string[]; remoteUrls: string[] } {
  const localPaths: string[] = [];
  const remoteUrls: string[] = [];

  let m: RegExpExecArray | null;
  LOCAL_IMAGE_RE.lastIndex = 0;
  while ((m = LOCAL_IMAGE_RE.exec(text)) !== null) {
    const p = m[1];
    if (fs.existsSync(p)) localPaths.push(p);
  }

  REMOTE_IMAGE_RE.lastIndex = 0;
  while ((m = REMOTE_IMAGE_RE.exec(text)) !== null) {
    remoteUrls.push(m[0]);
  }

  return { localPaths, remoteUrls };
}

/** Download a remote image URL to a temp file */
async function downloadRemoteImage(url: string): Promise<string | null> {
  try {
    fs.mkdirSync(MEDIA_TEMP_DIR, { recursive: true });
    const res = await fetch(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) return null; // too small, probably not an image

    // Determine extension from URL or content-type
    const urlExt = path.extname(new URL(url).pathname).toLowerCase();
    const ext = IMAGE_EXTENSIONS.has(urlExt) ? urlExt : ".png";
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const filePath = path.join(MEDIA_TEMP_DIR, fileName);
    fs.writeFileSync(filePath, buf);
    log(`远程图片已下载: ${filePath} (${buf.length} 字节)`);
    return filePath;
  } catch (err) {
    logError(`远程图片下载失败: ${url} - ${String(err)}`);
    return null;
  }
}

/** Upload a local image file to WeChat CDN and send it */
async function uploadAndSendImage(
  baseUrl: string,
  token: string,
  to: string,
  imagePath: string,
  contextToken: string,
): Promise<boolean> {
  try {
    const fileBuf = fs.readFileSync(imagePath);
    const uploaded = await uploadFileToCdn(
      fileBuf,
      to,
      (params) => getUploadUrl(baseUrl, token, params),
      CDN_BASE_URL,
      1, // IMAGE
    );
    await sendImageMessage(baseUrl, token, to, uploaded, contextToken);
    log(`图片已发送: ${imagePath}`);
    return true;
  } catch (err) {
    logError(`图片上传发送失败: ${String(err)}`);
    return false;
  }
}

// ── Send Reply (with chunking + markdown strip + image extraction) ───────────

async function sendReply(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  // Extract images from Claude's response
  const { localPaths, remoteUrls } = extractImagesFromReply(text);
  const tempDownloads: string[] = [];

  // Download remote images
  for (const url of remoteUrls) {
    const localPath = await downloadRemoteImage(url);
    if (localPath) tempDownloads.push(localPath);
  }

  const allImages = [...localPaths, ...tempDownloads];

  // Send text (strip markdown)
  const plain = markdownToPlainText(text);
  if (plain.trim()) {
    const chunks = splitText(plain);
    for (const chunk of chunks) {
      await sendTextMessage(baseUrl, token, to, chunk, contextToken);
    }
  }

  // Send extracted images
  for (const imgPath of allImages) {
    await uploadAndSendImage(baseUrl, token, to, imgPath, contextToken);
  }

  // Clean up temp downloads
  for (const p of tempDownloads) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
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
  mediaItems: MediaInfo[],
  contextToken: string,
): Promise<void> {
  // Download media if present
  const downloadableMedia = mediaItems.filter((m) => m.type !== "video");
  const hasOnlyVideo = hasMedia && downloadableMedia.length === 0 && mediaItems.some((m) => m.type === "video");

  if (hasOnlyVideo && !text) {
    await sendTextMessage(baseUrl, token, senderId, "暂不支持视频消息，请发送图片、文件或文字~", contextToken);
    return;
  }

  let mediaPaths: string[] = [];
  if (downloadableMedia.length > 0) {
    const { paths, errors } = await downloadMedia(downloadableMedia);
    mediaPaths = paths;
    if (paths.length === 0 && !text) {
      await sendTextMessage(baseUrl, token, senderId, "媒体文件下载失败了，请重新发送试试~", contextToken);
      return;
    }
    if (errors.length > 0 && paths.length > 0) {
      log(`部分媒体下载失败: ${errors.join(", ")}`);
    }
  }

  // Build enhanced prompt with media file paths
  let claudeInput = text;
  if (mediaPaths.length > 0) {
    const mediaRefs = mediaPaths.map((p) => {
      const ext = path.extname(p).toLowerCase();
      const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext);
      return isImage
        ? `[用户发送的图片: ${p}]`
        : `[用户发送的文件: ${p}]`;
    }).join("\n");

    if (text) {
      claudeInput = `${mediaRefs}\n\n用户的文字消息: ${text}`;
    } else {
      claudeInput = `${mediaRefs}\n\n请查看上述文件并回复用户。`;
    }
  }

  if (!claudeInput) return;

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
    const reply = await callClaude(claudeInput, senderId);
    log(`Claude 响应: "${reply.slice(0, 100)}"`);

    await stopTyping();

    if (reply) {
      await sendReply(baseUrl, token, senderId, reply, contextToken);
      log("已发送微信回复");
    }
  } catch (err) {
    const errMsg = String(err);
    logError(`Claude 处理失败: ${errMsg}`);
    await stopTyping();

    // Build user-friendly error message
    let userMsg: string;
    if (errMsg.includes("not found") || errMsg.includes("ENOENT")) {
      userMsg = "电脑上的 Claude Code 没找到，可能还没安装或者环境变量没配好，检查一下哦~";
    } else if (errMsg.includes("响应超时")) {
      userMsg = "等了好久没收到 Claude 的回复，可能是电脑休眠了或者网络断了。确认电脑在开机联网状态，然后再试试~";
    } else if (errMsg.includes("退出码")) {
      userMsg = "Claude 处理时遇到了点问题，试试发「新对话」重置一下，然后重新提问~";
    } else {
      userMsg = "出了点小状况，可能是电脑休眠或网络波动。确认电脑在线后再试试~";
    }

    try {
      await sendTextMessage(baseUrl, token, senderId, userMsg, contextToken);
    } catch { /* best effort */ }
  } finally {
    // Clean up temp media files
    for (const p of mediaPaths) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
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
          processMessage(baseUrl, token, parsed.senderId, parsed.text, parsed.hasMedia, parsed.mediaItems, contextToken)
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
