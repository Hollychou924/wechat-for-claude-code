import { fetchQRCode, pollQRStatus } from "./api.js";
import { saveCredentials, type AccountData } from "./storage.js";
import { DEFAULT_BASE_URL, BOT_TYPE, MAX_QR_REFRESH } from "./config.js";
import { log, logError } from "./log.js";

/**
 * QR code login flow with automatic refresh on expiry (up to MAX_QR_REFRESH times).
 * Mirrors @tencent-weixin/openclaw-weixin auth/login-qr.ts behavior.
 */
export async function doQRLogin(baseUrl: string = DEFAULT_BASE_URL): Promise<AccountData | null> {
  let qrRefreshCount = 0;
  let qrResp = await fetchQRCode(baseUrl, BOT_TYPE);

  const showQR = async (url: string) => {
    log("\n请使用微信扫描以下二维码：\n");
    try {
      const qrterm = await import("qrcode-terminal");
      await new Promise<void>((resolve) => {
        qrterm.default.generate(url, { small: true }, (qr: string) => {
          process.stderr.write(qr + "\n");
          resolve();
        });
      });
    } catch {
      log(`二维码链接: ${url}`);
    }
  };

  await showQR(qrResp.qrcode_img_content);
  log("等待扫码...");

  const deadline = Date.now() + 480_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, qrResp.qrcode);

    switch (status.status) {
      case "wait":
        break;

      case "scaned":
        if (!scannedPrinted) {
          log("已扫码，请在微信中确认...");
          scannedPrinted = true;
        }
        break;

      case "expired":
        qrRefreshCount++;
        if (qrRefreshCount >= MAX_QR_REFRESH) {
          logError(`二维码已过期 ${MAX_QR_REFRESH} 次，请重新开始。`);
          return null;
        }
        log(`二维码已过期，正在刷新...(${qrRefreshCount}/${MAX_QR_REFRESH})`);
        try {
          qrResp = await fetchQRCode(baseUrl, BOT_TYPE);
          scannedPrinted = false;
          await showQR(qrResp.qrcode_img_content);
        } catch (err) {
          logError(`刷新二维码失败: ${String(err)}`);
          return null;
        }
        break;

      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          logError("登录确认但未返回 bot 信息");
          return null;
        }
        const account: AccountData = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        saveCredentials(account);
        log("微信连接成功！");
        return account;
      }
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  logError("登录超时");
  return null;
}
