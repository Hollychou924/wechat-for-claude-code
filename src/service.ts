/**
 * Cross-platform background service management.
 * - macOS: launchd (LaunchAgents plist)
 * - Linux: systemd user service
 * - Windows: Task Scheduler (schtasks)
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const SERVICE_NAME = "com.claude.wechat-bridge";
const SERVICE_DISPLAY = "Claude Code WeChat Bridge";

function getProjectDir(): string {
  const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(dir, "..");
}

function detectBunPath(): string {
  try {
    const output = execSync("which bun 2>/dev/null || where bun 2>nul", {
      encoding: "utf-8",
    }).trim();
    return output.split("\n")[0] ?? output;
  } catch {
    const home = process.env.HOME || process.env.USERPROFILE || "~";
    if (process.platform === "win32") {
      return path.join(home, ".bun", "bin", "bun.exe");
    }
    return path.join(home, ".bun", "bin", "bun");
  }
}

function detectClaudePath(): string {
  try {
    const cmd = process.platform === "win32" ? "where claude" : "which claude";
    const output = execSync(cmd, { encoding: "utf-8" }).trim();
    return path.dirname(output.split("\n")[0] ?? output);
  } catch {
    return "";
  }
}

// ── macOS: launchd ──────────────────────────────────────────────────────────

function macPlistPath(): string {
  return path.join(
    process.env.HOME || "~",
    "Library",
    "LaunchAgents",
    `${SERVICE_NAME}.plist`,
  );
}

function macInstall(): boolean {
  const projectDir = getProjectDir();
  const bunPath = detectBunPath();
  const claudeDir = detectClaudePath();
  const home = process.env.HOME || `/Users/${process.env.USER}`;

  const pathParts = [claudeDir, path.dirname(bunPath), "/usr/local/bin", "/usr/bin", "/bin"].filter(Boolean);

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bunPath}</string>
        <string>${path.join(projectDir, "src", "index.ts")}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(projectDir, "bridge.log")}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(projectDir, "bridge.log")}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>${pathParts.join(":")}</string>
    </dict>
</dict>
</plist>`;

  try {
    const plistPath = macPlistPath();
    try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`); } catch { /* ok */ }
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist, "utf-8");
    execSync(`launchctl load "${plistPath}"`);
    return true;
  } catch {
    return false;
  }
}

function macUninstall(): boolean {
  const plistPath = macPlistPath();
  if (!fs.existsSync(plistPath)) return false;
  try { execSync(`launchctl unload "${plistPath}" 2>/dev/null`); } catch { /* ok */ }
  fs.unlinkSync(plistPath);
  return true;
}

function macStatus(): { installed: boolean; running: boolean; pid?: number } {
  try {
    const output = execSync(`launchctl list "${SERVICE_NAME}" 2>&1`, { encoding: "utf-8" });
    const pidMatch = output.match(/"PID"\s*=\s*(\d+)/);
    return {
      installed: true,
      running: !!pidMatch,
      pid: pidMatch?.[1] ? parseInt(pidMatch[1]) : undefined,
    };
  } catch {
    return { installed: false, running: false };
  }
}

// ── Linux: systemd user service ─────────────────────────────────────────────

function linuxServiceDir(): string {
  return path.join(process.env.HOME || "~", ".config", "systemd", "user");
}

function linuxServicePath(): string {
  return path.join(linuxServiceDir(), "claude-wechat-bridge.service");
}

function linuxInstall(): boolean {
  const projectDir = getProjectDir();
  const bunPath = detectBunPath();
  const claudeDir = detectClaudePath();
  const pathExtra = [claudeDir, path.dirname(bunPath)].filter(Boolean).join(":");

  const unit = `[Unit]
Description=${SERVICE_DISPLAY}
After=network.target

[Service]
Type=simple
WorkingDirectory=${projectDir}
ExecStart=${bunPath} ${path.join(projectDir, "src", "index.ts")}
Restart=always
RestartSec=5
Environment="PATH=${pathExtra}:/usr/local/bin:/usr/bin:/bin"
Environment="HOME=${process.env.HOME}"

[Install]
WantedBy=default.target
`;

  try {
    const serviceDir = linuxServiceDir();
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(linuxServicePath(), unit, "utf-8");
    execSync("systemctl --user daemon-reload");
    execSync("systemctl --user enable claude-wechat-bridge.service");
    execSync("systemctl --user start claude-wechat-bridge.service");
    return true;
  } catch {
    return false;
  }
}

function linuxUninstall(): boolean {
  const servicePath = linuxServicePath();
  if (!fs.existsSync(servicePath)) return false;
  try {
    execSync("systemctl --user stop claude-wechat-bridge.service 2>/dev/null");
    execSync("systemctl --user disable claude-wechat-bridge.service 2>/dev/null");
  } catch { /* ok */ }
  fs.unlinkSync(servicePath);
  try { execSync("systemctl --user daemon-reload"); } catch { /* ok */ }
  return true;
}

function linuxStatus(): { installed: boolean; running: boolean; pid?: number } {
  try {
    const output = execSync("systemctl --user is-active claude-wechat-bridge.service 2>&1", {
      encoding: "utf-8",
    }).trim();
    const running = output === "active";
    let pid: number | undefined;
    if (running) {
      try {
        const pidStr = execSync(
          "systemctl --user show claude-wechat-bridge.service --property=MainPID --value 2>/dev/null",
          { encoding: "utf-8" },
        ).trim();
        pid = parseInt(pidStr) || undefined;
      } catch { /* ok */ }
    }
    return { installed: true, running, pid };
  } catch {
    // Check if service file exists but is not active
    if (fs.existsSync(linuxServicePath())) {
      return { installed: true, running: false };
    }
    return { installed: false, running: false };
  }
}

// ── Windows: Task Scheduler ─────────────────────────────────────────────────

const WIN_TASK_NAME = "ClaudeWeChatBridge";

function winInstall(): boolean {
  const projectDir = getProjectDir();
  const bunPath = detectBunPath();

  try {
    // Delete existing task if any
    try { execSync(`schtasks /Delete /TN "${WIN_TASK_NAME}" /F 2>nul`, { stdio: "pipe" }); } catch { /* ok */ }

    // Create task that runs at logon and restarts on failure
    const entryPoint = path.join(projectDir, "src", "index.ts");
    execSync(
      `schtasks /Create /TN "${WIN_TASK_NAME}" /TR "\\"${bunPath}\\" \\"${entryPoint}\\"" /SC ONLOGON /RL HIGHEST /F`,
      { stdio: "pipe" },
    );

    // Start it now
    try { execSync(`schtasks /Run /TN "${WIN_TASK_NAME}"`, { stdio: "pipe" }); } catch { /* ok */ }

    return true;
  } catch {
    return false;
  }
}

function winUninstall(): boolean {
  try {
    execSync(`schtasks /Delete /TN "${WIN_TASK_NAME}" /F`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function winStatus(): { installed: boolean; running: boolean; pid?: number } {
  try {
    const output = execSync(`schtasks /Query /TN "${WIN_TASK_NAME}" /FO CSV /NH 2>nul`, {
      encoding: "utf-8",
    });
    const running = output.includes("Running") || output.includes("正在运行");
    return { installed: true, running };
  } catch {
    return { installed: false, running: false };
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export function installService(): boolean {
  switch (process.platform) {
    case "darwin": return macInstall();
    case "linux": return linuxInstall();
    case "win32": return winInstall();
    default:
      console.error(`不支持的平台: ${process.platform}，请手动运行 bun start`);
      return false;
  }
}

export function uninstallService(): boolean {
  switch (process.platform) {
    case "darwin": return macUninstall();
    case "linux": return linuxUninstall();
    case "win32": return winUninstall();
    default: return false;
  }
}

export function getServiceStatus(): { installed: boolean; running: boolean; pid?: number } {
  switch (process.platform) {
    case "darwin": return macStatus();
    case "linux": return linuxStatus();
    case "win32": return winStatus();
    default: return { installed: false, running: false };
  }
}

export function getServiceConfigPath(): string {
  switch (process.platform) {
    case "darwin": return macPlistPath();
    case "linux": return linuxServicePath();
    case "win32": return `Task Scheduler: ${WIN_TASK_NAME}`;
    default: return "";
  }
}

export function isPlatformSupported(): boolean {
  return ["darwin", "linux", "win32"].includes(process.platform);
}
