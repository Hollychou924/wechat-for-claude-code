import type { WeixinMessage, MessageItem } from "./api.js";
import { MessageType, MessageItemType, MessageState } from "./api.js";
import { MAX_SEND_CHUNK } from "./config.js";

export interface MediaInfo {
  type: "image" | "file" | "video";
  encryptQueryParam: string;
  aesKey: string | null;
  fileName?: string;
}

export interface ParsedMessage {
  senderId: string;
  text: string;
  contextToken: string | undefined;
  hasMedia: boolean;
  mediaItems: MediaInfo[];
}

export function parseMessage(msg: WeixinMessage): ParsedMessage | null {
  if (msg.message_type !== MessageType.USER) return null;

  const text = extractText(msg.item_list);
  const hasMedia = hasMediaItems(msg.item_list);
  const mediaItems = extractMediaItems(msg.item_list);

  if (!text && !hasMedia) return null;

  return {
    senderId: msg.from_user_id ?? "unknown",
    text,
    contextToken: msg.context_token,
    hasMedia,
    mediaItems,
  };
}

function hasMediaItems(items?: MessageItem[]): boolean {
  if (!items?.length) return false;
  return items.some((item) =>
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VIDEO
  );
}

function extractText(items?: MessageItem[]): string {
  if (!items?.length) return "";
  for (const item of items) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      const text = item.text_item.text;
      const ref = item.ref_msg;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refText = extractText([ref.message_item]);
        if (refText) parts.push(refText);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

function extractMediaItems(items?: MessageItem[]): MediaInfo[] {
  if (!items?.length) return [];
  const result: MediaInfo[] = [];
  for (const item of items) {
    if (item.type === MessageItemType.IMAGE && item.image_item?.media?.encrypt_query_param) {
      const img = item.image_item;
      const aesKey = img.aeskey
        ? Buffer.from(img.aeskey, "hex").toString("base64")
        : img.media!.aes_key ?? null;
      result.push({ type: "image", encryptQueryParam: img.media!.encrypt_query_param!, aesKey });
    } else if (item.type === MessageItemType.FILE && item.file_item?.media?.encrypt_query_param && item.file_item.media.aes_key) {
      result.push({
        type: "file",
        encryptQueryParam: item.file_item.media.encrypt_query_param,
        aesKey: item.file_item.media.aes_key,
        fileName: item.file_item.file_name,
      });
    } else if (item.type === MessageItemType.VIDEO && item.video_item?.media?.encrypt_query_param) {
      result.push({
        type: "video",
        encryptQueryParam: item.video_item.media.encrypt_query_param,
        aesKey: item.video_item.media.aes_key ?? null,
      });
    }
  }
  return result;
}

/**
 * Convert markdown-formatted Claude output to plain text for WeChat.
 * Mirrors the approach from @tencent-weixin/openclaw-weixin.
 */
export function markdownToPlainText(text: string): string {
  let result = text;
  // Code blocks: strip fences, keep code content
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  // Images: remove entirely
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // Links: keep display text only
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Tables: remove separator rows, strip pipes
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell: string) => cell.trim()).join("  "),
  );
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, "$1");
  // Bold/italic
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  // Inline code
  result = result.replace(/`([^`]+)`/g, "$1");
  // Headers: remove # prefix
  result = result.replace(/^#{1,6}\s+/gm, "");
  // Blockquotes
  result = result.replace(/^>\s?/gm, "");
  // Horizontal rules
  result = result.replace(/^[-*_]{3,}$/gm, "");
  // Unordered list markers
  result = result.replace(/^(\s*)[*+-]\s/gm, "$1• ");
  // Collapse multiple blank lines
  result = result.replace(/\n{3,}/g, "\n\n");
  return result.trim();
}

/**
 * Split text into chunks that fit within WeChat's message size limit.
 * Breaks at paragraph boundaries, then newlines, then spaces.
 */
export function splitText(text: string, maxLen: number = MAX_SEND_CHUNK): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf("\n\n", maxLen);
    if (breakAt <= 0) breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt <= 0) breakAt = remaining.lastIndexOf(" ", maxLen);
    if (breakAt <= 0) breakAt = maxLen;
    chunks.push(remaining.substring(0, breakAt));
    remaining = remaining.substring(breakAt).trimStart();
  }
  return chunks;
}
