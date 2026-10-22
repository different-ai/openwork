import { execFile } from "node:child_process";
import { win32 } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** Pure ownership guard; never kill a reused pid or an image outside the request. */
export function windowsCleanupCandidates(rows, request) {
  if (!Number.isInteger(request.parentPid) || request.parentPid <= 4
    || !Number.isFinite(request.startedAt) || !Number.isFinite(request.endedAt)
    || request.endedAt < request.startedAt) throw new Error("Invalid broker cleanup identity");
  return rows.filter(row => {
    if (!Number.isInteger(row.pid) || row.pid <= 4 || row.parentPid !== request.parentPid
      || typeof row.executable !== "string" || !row.executable
      || !Number.isFinite(row.startedAt) || row.startedAt > request.endedAt + 1_000) return false;
    return request.children.some(child => {
      if (typeof child.command !== "string" || !child.command.trim() || !Number.isFinite(child.startedAt)) return false;
      if (child.pid !== undefined && child.pid !== row.pid) return false;
      if (row.startedAt < Math.max(request.startedAt, child.startedAt) - 1_000) return false;
      const expected = win32.normalize(child.command).toLowerCase();
      const actual = win32.normalize(row.executable).toLowerCase();
      if (win32.isAbsolute(child.command)) return actual === expected || actual === `${expected}.exe`;
      const name = win32.basename(expected);
      return win32.basename(actual) === name || win32.basename(actual) === `${name}.exe`;
    });
  });
}

/** Must run in a utility process. No PowerShell/taskkill admission on UI main. */
export async function reapWindowsBrokerChildren(request) {
  if (process.platform !== "win32") throw new Error("Windows cleanup requires Windows");
  windowsCleanupCandidates([], request);
  const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';@(
Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${request.parentPid}' | ForEach-Object {
  @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;executable=[string]$_.ExecutablePath;startedAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}
}) | ConvertTo-Json -Compress`;
  const system32 = win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const result = await execute(win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
  });
  const parsed = JSON.parse(result.stdout || "[]");
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const candidates = windowsCleanupCandidates(rows, request);
  const selected = new Set(candidates.map(row => row.pid));
  for (const child of request.children) {
    if (child.pid === undefined || selected.has(child.pid)) continue;
    try { process.kill(child.pid, 0); }
    catch (error) { if (error.code === "ESRCH") continue; throw new Error("Windows child identity could not be verified"); }
    // A live pid without matching parent, creation time and image is not ours
    // to terminate. Fail closed rather than using a stale pid blindly.
    throw new Error("Windows child identity could not be verified");
  }
  for (const row of candidates) {
    await execute(win32.join(system32, "taskkill.exe"), ["/PID", String(row.pid), "/T", "/F"], { windowsHide: true, timeout: 10_000 });
  }
  const deadline = Date.now() + 2_000;
  for (const row of candidates) {
    while (true) {
      try { process.kill(row.pid, 0); }
      catch (error) { if (error.code === "ESRCH") break; throw new Error("Windows child exit could not be confirmed"); }
      if (Date.now() >= deadline) throw new Error("Windows child exit could not be confirmed");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}
