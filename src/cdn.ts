/**
 * CDN media download/upload + AES-128-ECB encryption/decryption.
 * Adapted from @tencent-weixin/openclaw-weixin.
 */
import crypto from "node:crypto";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { log, logError } from "./log.js";

/** Encrypt buffer with AES-128-ECB (PKCS7 padding). */
function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** Decrypt buffer with AES-128-ECB (PKCS7 padding). */
function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Compute AES-128-ECB ciphertext size (PKCS7 padding to 16-byte boundary). */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
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

// ── CDN Upload ─────────────────────────────────────────────────────────────

export type UploadedFileInfo = {
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string; // hex
  fileSize: number;
  fileSizeCiphertext: number;
};

/** Build CDN upload URL. */
function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

const UPLOAD_MAX_RETRIES = 3;

/** Upload buffer to CDN with AES-128-ECB encryption. */
async function uploadBufferToCdn(
  buf: Buffer,
  uploadParam: string,
  filekey: string,
  cdnBaseUrl: string,
  aeskey: Buffer,
): Promise<string> {
  const ciphertext = encryptAesEcb(buf, aeskey);
  const url = buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey);

  let downloadParam: string | undefined;
  for (let attempt = 1; attempt <= UPLOAD_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`CDN 上传客户端错误 ${res.status}`);
      }
      if (res.status !== 200) {
        throw new Error(`CDN 上传服务端错误 ${res.status}`);
      }
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) throw new Error("CDN 响应缺少 x-encrypted-param");
      break;
    } catch (err) {
      if (attempt === UPLOAD_MAX_RETRIES || (err instanceof Error && err.message.includes("客户端"))) {
        throw err;
      }
      log(`CDN 上传重试 ${attempt}/${UPLOAD_MAX_RETRIES}: ${String(err)}`);
    }
  }
  return downloadParam!;
}

/** Upload a local file to WeChat CDN. Returns info needed for sendImageMessage. */
export async function uploadFileToCdn(
  fileBuf: Buffer,
  toUserId: string,
  getUploadUrlFn: (params: {
    filekey: string;
    media_type: number;
    to_user_id: string;
    rawsize: number;
    rawfilemd5: string;
    filesize: number;
    aeskey: string;
  }) => Promise<{ upload_param?: string }>,
  cdnBaseUrl: string,
  mediaType: number = 1, // 1=IMAGE
): Promise<UploadedFileInfo> {
  const rawsize = fileBuf.length;
  const rawfilemd5 = crypto.createHash("md5").update(fileBuf).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  log(`CDN 上传准备: size=${rawsize} md5=${rawfilemd5.slice(0, 8)}...`);

  const resp = await getUploadUrlFn({
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskey.toString("hex"),
  });

  if (!resp.upload_param) throw new Error("getUploadUrl 未返回 upload_param");

  const downloadEncryptedQueryParam = await uploadBufferToCdn(
    fileBuf, resp.upload_param, filekey, cdnBaseUrl, aeskey,
  );

  log(`CDN 上传完成: filekey=${filekey.slice(0, 8)}...`);

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
