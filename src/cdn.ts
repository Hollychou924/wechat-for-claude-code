/**
 * CDN media download + AES-128-ECB decryption.
 * Adapted from @tencent-weixin/openclaw-weixin (cdn/aes-ecb.ts, cdn/pic-decrypt.ts, cdn/cdn-url.ts).
 */
import { createDecipheriv } from "node:crypto";
import { log, logError } from "./log.js";

/** Decrypt buffer with AES-128-ECB (PKCS7 padding). */
function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings exist:
 *   - base64(raw 16 bytes)           → images (aes_key from media field)
 *   - base64(hex string of 16 bytes) → file / voice / video
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(`aes_key 解码后长度异常: ${decoded.length} 字节`);
}

/** Build CDN download URL. */
function buildCdnDownloadUrl(encryptQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
}

/** Download raw bytes from CDN. */
async function fetchCdnBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CDN 下载失败: ${res.status} ${res.statusText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Download and AES-128-ECB decrypt a CDN media file. */
export async function downloadAndDecrypt(
  encryptQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl: string,
): Promise<Buffer> {
  const key = parseAesKey(aesKeyBase64);
  const url = buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl);
  log(`CDN 下载: ${url.slice(0, 80)}...`);
  const encrypted = await fetchCdnBytes(url);
  log(`CDN 已下载 ${encrypted.byteLength} 字节，解密中...`);
  const decrypted = decryptAesEcb(encrypted, key);
  log(`解密完成: ${decrypted.length} 字节`);
  return decrypted;
}

/** Download plain (unencrypted) bytes from CDN. */
export async function downloadPlain(
  encryptQueryParam: string,
  cdnBaseUrl: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl);
  log(`CDN 下载(无加密): ${url.slice(0, 80)}...`);
  return fetchCdnBytes(url);
}
