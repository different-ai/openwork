import { execFile } from "@openwork/child-process";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { withStartupPhase } from "./startup-log.mjs";

export const WINDOWS_SHORTCUT_TIMEOUT_MS = 15000;

export function repairWindowsShortcutTarget(shortcutPath, details, {
  execute = execFile,
  timeoutMs = WINDOWS_SHORTCUT_TIMEOUT_MS,
} = {}) {
  const payload = Buffer.from(JSON.stringify({ shortcutPath, ...details }), "utf8").toString("base64");
  const script = [
    `$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json`,
    "$ErrorActionPreference = 'Stop'",
    "$shell = New-Object -ComObject WScript.Shell",
    "$link = $shell.CreateShortcut($value.shortcutPath)",
    "$link.TargetPath = $value.target",
    "$link.WorkingDirectory = $value.cwd",
    "$link.Description = $value.description",
    "$link.IconLocation = \"$($value.icon),$($value.iconIndex)\"",
    "$link.Save()",
  ].join("\n");
  return new Promise((resolve) => {
    // execFile's timeout terminates the child on Windows; do not just race a
    // promise and leave PowerShell/COM running. No paths or child output in logs.
    try {
      execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

export async function readWindowsShortcutMarker(markerPath) {
  const text = (await readFile(markerPath, "utf8").catch(() => "")).trim();
  try {
    const value = JSON.parse(text);
    if (typeof value?.shortcutPath === "string") return value;
  } catch {
    // Older versions stored only the shortcut path. Upgrade after validation.
  }
  return { shortcutPath: text, signature: null };
}

export async function updateWindowsShortcut({ shell, shortcutPath, installedShortcutPath, markerPath, details }, {
  repair = repairWindowsShortcutTarget,
} = {}) {
  const signature = JSON.stringify(details);
  const previous = await readWindowsShortcutMarker(markerPath);
  if (previous.shortcutPath === shortcutPath && previous.signature === signature
    && await access(shortcutPath).then(() => true, () => false)) return "unchanged";

  const tempPath = `${shortcutPath}.${process.pid}.tmp.lnk`;
  await mkdir(path.dirname(shortcutPath), { recursive: true });
  try {
    // A previously successful marker must not survive a failed recreation.
    await rm(markerPath, { force: true });
    await rm(tempPath, { force: true });
    // Electron exposes only synchronous Shell APIs. Keep one write and one
    // validation, after readiness and an event-loop turn, never in startup/IPC.
    await new Promise((resolve) => setImmediate(resolve));
    if (!shell.writeShortcutLink(tempPath, "create", details)) throw new Error("shortcut-write");
    await rm(shortcutPath, { force: true });
    await rename(tempPath, shortcutPath);
    if (shell.readShortcutLink(shortcutPath).target !== details.target) {
      if (!await repair(shortcutPath, details)) throw new Error("shortcut-repair");
    }
    if (previous.shortcutPath && previous.shortcutPath !== shortcutPath) {
      await rm(previous.shortcutPath, { force: true });
    }
    if (installedShortcutPath !== shortcutPath) await rm(installedShortcutPath, { force: true });
    // Only successful work can suppress a later launch's repair.
    await writeFile(markerPath, JSON.stringify({ shortcutPath, signature }), "utf8");
    return "updated";
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

export function createWindowsShortcutScheduler({ ready, update = updateWindowsShortcut, logger = console }) {
  const attempted = new Set();
  let pending = null;
  let running = false;
  return function schedule(request) {
    const key = JSON.stringify([request.shortcutPath, request.details]);
    if (attempted.has(key)) return;
    // Latest branding wins while waiting for readiness or another operation.
    pending = { key, request };
    if (running) return;
    running = true;
    void (async () => {
      try {
        await ready();
        while (pending) {
          const next = pending;
          pending = null;
          if (attempted.has(next.key)) continue;
          attempted.add(next.key);
          await new Promise((resolve) => setImmediate(resolve));
          const started = performance.now();
          let status = "failed";
          try {
            status = await withStartupPhase("windows.shortcut", () => update(next.request));
          } catch {
            // Cosmetic work must never reject activation/startup or show UI.
          }
          const durationMs = Math.round(performance.now() - started);
          if (status === "failed") logger.warn(`[windows-shortcut] failed or timed out (${durationMs} ms)`);
          else logger.info(`[windows-shortcut] ${status} (${durationMs} ms)`);
        }
      } catch {
        pending = null;
      } finally {
        running = false;
      }
    })();
  };
}
