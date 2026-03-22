import fs from "node:fs";
import path from "node:path";

const LOG_DIR = path.dirname(new URL(import.meta.url).pathname) + "/..";
const LOG_RETAIN_DAYS = 7;

function timestamp(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function todayDateStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let currentDateStr = "";
let logStream: fs.WriteStream | null = null;

function getLogStream(): fs.WriteStream | null {
  const today = todayDateStr();
  if (currentDateStr === today && logStream) return logStream;

  if (logStream) {
    try { logStream.end(); } catch { /* ignore */ }
  }

  const logDir = path.resolve(LOG_DIR);
  const logFile = path.join(logDir, `bridge-${today}.log`);

  try {
    logStream = fs.createWriteStream(logFile, { flags: "a" });
    currentDateStr = today;
    cleanOldLogs(logDir);
    return logStream;
  } catch {
    logStream = null;
    return null;
  }
}

function cleanOldLogs(dir: string): void {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("bridge-") && f.endsWith(".log"));
    const cutoff = Date.now() - LOG_RETAIN_DAYS * 86_400_000;
    for (const f of files) {
      const filePath = path.join(dir, f);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
      }
    }
  } catch { /* ignore */ }
}

function writeLog(level: string, msg: string): void {
  const line = `[${timestamp()}] [${level}] ${msg}\n`;
  process.stderr.write(`[wechat-bridge] ${line}`);
  const stream = getLogStream();
  if (stream) stream.write(line);
}

export function log(msg: string) {
  writeLog("INFO", msg);
}

export function logError(msg: string) {
  writeLog("ERROR", msg);
}
