import crypto from "node:crypto";
import { CHANNEL_VERSION } from "./config.js";
import { log, logError } from "./log.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TextItem { text?: string }
export interface CDNMedia { encrypt_query_param?: string; aes_key?: string; encrypt_type?: number }
export interface ImageItem { media?: CDNMedia; aeskey?: string; url?: string; mid_size?: number; thumb_size?: number }
export interface VoiceItem { media?: CDNMedia; text?: string; playtime?: number }
export interface FileItem { media?: CDNMedia; file_name?: string; md5?: string; len?: string }
export interface VideoItem { media?: CDNMedia; video_size?: number }
export interface RefMessage { message_item?: MessageItem; title?: string }

export interface MessageItem {
  type?: number;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: RefMessage;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  create_time_ms?: number;
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
export const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

// ── HTTP helpers ────────────────────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token?: string, body?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (body) headers["Content-Length"] = String(Buffer.byteLength(body, "utf-8"));
  if (token?.trim()) headers.Authorization = `Bearer ${token.trim()}`;
  return headers;
}

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base).toString();
  const headers = buildHeaders(params.token, params.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: params.body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
    return text;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── QR Login ────────────────────────────────────────────────────────────────

export interface QRCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

export interface QRStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

export async function fetchQRCode(baseUrl: string, botType: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return res.json() as Promise<QRCodeResponse>;
}

export async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return res.json() as Promise<QRStatusResponse>;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    throw err;
  }
}

// ── Message API ─────────────────────────────────────────────────────────────

export async function getUpdates(
  baseUrl: string,
  token: string,
  getUpdatesBuf: string,
  timeoutMs: number,
): Promise<GetUpdatesResp> {
  try {
    const raw = await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({ get_updates_buf: getUpdatesBuf, base_info: buildBaseInfo() }),
      token,
      timeoutMs,
    });
    return JSON.parse(raw) as GetUpdatesResp;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

export function generateClientId(): string {
  return `claude-wechat:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function sendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken: string,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 15_000,
  });
}

export async function getConfig(
  baseUrl: string,
  token: string,
  ilinkUserId: string,
  contextToken?: string,
): Promise<GetConfigResp> {
  const raw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: ilinkUserId,
      context_token: contextToken,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 10_000,
  });
  return JSON.parse(raw) as GetConfigResp;
}

export async function sendTyping(
  baseUrl: string,
  token: string,
  ilinkUserId: string,
  typingTicket: string,
  status: number = TypingStatus.TYPING,
): Promise<void> {
  try {
    await apiFetch({
      baseUrl,
      endpoint: "ilink/bot/sendtyping",
      body: JSON.stringify({
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: buildBaseInfo(),
      }),
      token,
      timeoutMs: 10_000,
    });
  } catch {
    // best effort — typing indicator is non-critical
  }
}

// ── CDN Upload URL ─────────────────────────────────────────────────────────

export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3 } as const;

export async function getUploadUrl(
  baseUrl: string,
  token: string,
  params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
  },
): Promise<{ upload_param?: string }> {
  const raw = await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({
      ...params,
      no_need_thumb: true,
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 15_000,
  });
  return JSON.parse(raw);
}

// ── Send Image Message ─────────────────────────────────────────────────────

export async function sendImageMessage(
  baseUrl: string,
  token: string,
  to: string,
  uploaded: {
    downloadEncryptedQueryParam: string;
    aeskey: string; // hex
    fileSizeCiphertext: number;
  },
  contextToken: string,
): Promise<void> {
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: to,
        client_id: generateClientId(),
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [{
          type: MessageItemType.IMAGE,
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadEncryptedQueryParam,
              aes_key: Buffer.from(uploaded.aeskey, "hex").toString("base64"),
              encrypt_type: 1,
            },
            mid_size: uploaded.fileSizeCiphertext,
          },
        }],
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: 15_000,
  });
}
