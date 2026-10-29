// macOS grants Accessibility and Screen Recording to the *responsible* app.
// The computer use helper disclaims responsibility when it starts, so System
// Settings lists its own bundle ("OpenWork Computer Use") and a grant never
// waits for OpenWork to restart. Without the helper bundle (a raw development
// build), this falls back to the outermost app that started this process.
// Setup guidance names exactly that entry instead of asking people to guess.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const OPENWORK_BUNDLE_PREFIX = "com.differentai.openwork";

/** @typedef {{ name: string, bundleId: string | null, ours: boolean }} PermissionEntry */
/** @typedef {(file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>} Exec */

async function processInfo(pid, exec) {
  const { stdout } = await exec("/bin/ps", ["-o", "ppid=", "-o", "comm=", "-p", String(pid)], { timeout: 2_000 });
  const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
  return match ? { parent: Number(match[1]), command: match[2] } : null;
}

function bundleOf(command) {
  const marker = command.indexOf(".app/Contents/");
  return marker === -1 ? null : command.slice(0, marker + ".app".length);
}

async function plistValue(bundle, key, exec) {
  try {
    const { stdout } = await exec("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path.join(bundle, "Contents", "Info.plist")], { timeout: 2_000 });
    return stdout.trim() || null;
  } catch { return null; }
}

/**
 * @param {{ helperBundle?: string | null, pid?: number, execPath?: string, fallbackName?: string, exec?: Exec }} [options]
 * @returns {Promise<PermissionEntry>}
 */
export async function resolvePermissionEntry({ helperBundle = null, pid = process.pid, execPath = pid === process.pid ? process.execPath : "", fallbackName = "OpenWork", exec = run } = {}) {
  if (helperBundle) return bundleEntry(helperBundle, exec);
  // ps names a packaged Electron app's own process without its path
  // ("OpenWork"), so start from the executable path this process knows.
  let outermost = bundleOf(execPath);
  try {
    for (let current = pid, hops = 0; current > 1 && hops < 32; hops++) {
      const info = await processInfo(current, exec);
      if (!info) break;
      outermost = bundleOf(info.command) ?? outermost;
      current = info.parent;
    }
  } catch { /* Fall back to the app's own name below. */ }
  if (!outermost) return { name: fallbackName, bundleId: null, ours: false };
  return bundleEntry(outermost, exec);
}

/** @param {string} bundle @param {Exec} exec @returns {Promise<PermissionEntry>} */
async function bundleEntry(bundle, exec) {
  const [displayName, bundleName, bundleId] = await Promise.all([
    plistValue(bundle, "CFBundleDisplayName", exec),
    plistValue(bundle, "CFBundleName", exec),
    plistValue(bundle, "CFBundleIdentifier", exec),
  ]);
  return {
    name: displayName ?? bundleName ?? path.basename(bundle, ".app"),
    bundleId,
    ours: Boolean(bundleId?.startsWith(OPENWORK_BUNDLE_PREFIX)),
  };
}

/**
 * Clears this app's own stale macOS entry so the next request asks again.
 * Only for OpenWork's own bundle: never another app's permissions.
 * @param {PermissionEntry} entry
 * @param {"accessibility" | "screenRecording"} permission
 */
export async function resetPermissionEntry(entry, permission) {
  if (!entry.ours || !entry.bundleId) throw new Error(`Remove ${entry.name} from the list in System Settings, then add it again.`);
  await run("/usr/bin/tccutil", ["reset", permission === "accessibility" ? "Accessibility" : "ScreenCapture", entry.bundleId], { timeout: 5_000 });
}
