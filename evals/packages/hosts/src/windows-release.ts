import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { checkedExec, defaultDaytonaExec } from "./daytona.ts";
import type { DaytonaExec } from "./daytona.ts";
import { deleteSandboxes, resolvePublishedDesktopRelease } from "./provision.ts";
import { privateSandboxId, privateWebPreview } from "./private-web-preview.ts";
import type { PublishedDesktopRelease } from "./provision.ts";
import type { DesktopRelease, ElectronStartupObservation } from "./types.ts";

const SNAPSHOT = "windows-medium";
const INSTALLER = "C:\\ow\\release.exe";
const BINARY = "C:\\Users\\Administrator\\AppData\\Local\\Programs\\@openworkdesktop\\OpenWork.exe";
const PROFILE = "C:\\Users\\Administrator\\AppData\\Roaming\\com.differentai.openwork";
const LOG = "C:\\ow\\desktop.log";
const CDP_PORT = 9223; // The packaged app overrides the requested 9222 port with 9223.
const POLL_MS = 5_000;

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Daytona exec needs one command argument. Encode PowerShell as UTF-16LE to preserve pipes and quoting. */
export function windowsPowerShellArgs(sandbox: string, script: string): string[] {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(sandbox)) throw new Error("Invalid Windows sandbox identity.");
  return ["exec", sandbox, "--", `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`];
}

async function runPowerShell(exec: DaytonaExec, sandbox: string, script: string, context: string, timeoutMs = 60_000): Promise<string> {
  const checked = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\ntry {\n${script}\n} catch { Write-Error $_; exit 1 }`;
  const result = await checkedExec(exec, windowsPowerShellArgs(sandbox, checked), context, { timeoutMs });
  return result.stdout.trim();
}

function commandFile(path: string, lines: readonly string[]): string {
  return `Set-Content -LiteralPath ${literal(path)} -Encoding Ascii -Value @(${lines.map(literal).join(", ")})`;
}

function task(name: string, file: string): string {
  return `& schtasks.exe /create /tn ${literal(name)} /tr ${literal(file)} /sc once /st 23:59 /ru Administrator /it /f\nif ($LASTEXITCODE -ne 0) { throw 'Could not register the interactive task' }\n& schtasks.exe /run /tn ${literal(name)}\nif ($LASTEXITCODE -ne 0) { throw 'Could not run the interactive task' }`;
}

async function pollWindowsUntil<T>(read: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(POLL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`${label} timed out: ${lastError instanceof Error ? lastError.message : "no response"}`);
}

export interface WindowsReleaseSandbox extends AsyncDisposable {
  sandbox: string;
  release: PublishedDesktopRelease;
  installPath: string;
  installerPath: string;
  profilePath: string;
  logPath: string;
  viewerUrl: string;
  cdpUrl: string | undefined;
  startup: ElectronStartupObservation;
}

/**
 * Owns a private Windows VM and a published installer. Never reuses an existing
 * sandbox, mounts a shared secrets volume, builds source, or launches GUI as SYSTEM.
 */
export async function provisionWindowsReleaseSandbox(options: {
  release: DesktopRelease;
  lifetimeMinutes: number;
  exec?: DaytonaExec;
  releaseFetch?: typeof fetch;
  request?: typeof fetch;
  onCreated?: (sandbox: string, name: string) => Promise<void>;
  log?: (message: string) => void;
  startupTimeoutMs?: number;
}): Promise<WindowsReleaseSandbox> {
  const exec = options.exec ?? defaultDaytonaExec;
  const log = options.log ?? console.error;
  const release = await resolvePublishedDesktopRelease(options.release, options.releaseFetch, "windows");
  if (!Number.isSafeInteger(options.lifetimeMinutes) || options.lifetimeMinutes < 0 || options.lifetimeMinutes > 1410) {
    throw new Error("Windows world lifetime must be 0-1410 minutes (30 minutes reserved for startup and provider cleanup).");
  }
  const name = `openwork-world-win-${randomBytes(8).toString("hex")}`;
  let sandbox = name;
  let created = false;
  try {
    await checkedExec(exec, ["create", "--name", name, "--snapshot", SNAPSHOT,
      "--auto-pause", "0", "--auto-delete", "-1",
      "--ttl", String(options.lifetimeMinutes === 0 ? 0 : options.lifetimeMinutes + 30),
      "--target", "us"], "private Windows world sandbox creation", { timeoutMs: 300_000 });
    created = true;
    sandbox = await privateSandboxId(name, exec);
    const identity = await checkedExec(exec, ["info", sandbox, "-f", "json"], "Windows world ownership", { timeoutMs: 30_000 });
    let info: unknown;
    try { info = JSON.parse(identity.stdout); } catch { throw new Error("Windows VM returned invalid ownership information."); }
    if (typeof info !== "object" || info === null || !("id" in info) || info.id !== sandbox
      || !("name" in info) || info.name !== name || !("snapshot" in info) || info.snapshot !== SNAPSHOT
      || !("public" in info) || info.public !== false) {
      throw new Error("Windows VM ownership or private snapshot mismatch.");
    }
    await options.onCreated?.(sandbox, name);
    await pollWindowsUntil(async () => {
      try { await runPowerShell(exec, sandbox, "Write-Output 'EXEC_READY'", "Windows exec readiness", 30_000); return true; }
      catch { return undefined; }
    }, 300_000, "Windows exec readiness");

    // The GitHub API digest and byte count are both checked inside the VM.
    const digest = release.digest.slice("sha256:".length);
    const download = `New-Item -ItemType Directory -Path 'C:\\ow' -Force | Out-Null\n` +
      `& curl.exe --fail --location --silent --show-error --output ${literal(INSTALLER)} ${literal(release.browserDownloadUrl)}\n` +
      `if ($LASTEXITCODE -ne 0) { throw 'Published Windows download failed' }\n` +
      `if ((Get-Item -LiteralPath ${literal(INSTALLER)}).Length -ne ${release.size}) { throw 'Published Windows release size mismatch' }\n` +
      `if ((Get-FileHash -Algorithm SHA256 -LiteralPath ${literal(INSTALLER)}).Hash.ToLowerInvariant() -ne ${literal(digest)}) { throw 'Published Windows release SHA-256 mismatch' }\n` +
      `Write-Output 'WINDOWS_RELEASE_VERIFIED'`;
    const verified = await runPowerShell(exec, sandbox, download, "published Windows release digest", 900_000);
    if (!verified.includes("WINDOWS_RELEASE_VERIFIED")) throw new Error("Windows installer digest witness did not finish.");
    log("==> Windows published installer verified");

    const installCmd = "C:\\ow\\install.cmd";
    await runPowerShell(exec, sandbox,
      `${commandFile(installCmd, ["@echo off", `"${INSTALLER}" /S`])}\n${task("OpenWorkWorldInstall", installCmd)}`,
      "install Windows release as interactive Administrator");
    await pollWindowsUntil(async () => {
      const result = await runPowerShell(exec, sandbox,
        `if ((Test-Path -LiteralPath ${literal(BINARY)}) -and ((& schtasks.exe /query /tn OpenWorkWorldInstall /fo list /v | Out-String) -match 'Status:\\s+Ready')) { Write-Output 'INSTALLED' }`,
        "Windows interactive installer status", 30_000);
      return result.includes("INSTALLED") ? true : undefined;
    }, 300_000, "Windows interactive installer");

    const launchCmd = "C:\\ow\\launch.cmd";
    await runPowerShell(exec, sandbox,
      `${commandFile(launchCmd, ["@echo off", `"${BINARY}" --no-sandbox --remote-debugging-port=9222 > "${LOG}" 2>&1`])}\n${task("OpenWorkWorldLaunch", launchCmd)}`,
      "launch Windows release as interactive Administrator");
    const observed = await pollWindowsUntil(async () => {
      const output = await runPowerShell(exec, sandbox,
        `$p = Get-CimInstance Win32_Process -Filter \"name='OpenWork.exe'\" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.SessionId -eq 1 }\n` +
        `if ($p) { Write-Output 'GUI_SESSION_1' }`, "Windows interactive session witness", 30_000);
      return output.includes("GUI_SESSION_1") ? true : undefined;
    }, 120_000, "Windows GUI session");
    if (!observed) throw new Error("Windows GUI session not observed.");

    const expiresInSeconds = Math.min(86_400, (options.lifetimeMinutes || 1440) * 60 + 600);
    const viewerPreview = await privateWebPreview(sandbox, 6080, exec, expiresInSeconds);
    const viewer = new URL("/vnc.html", viewerPreview.browserOrigin);
    viewer.search = "autoconnect=1&resize=scale&reconnect=1&reconnect_delay=2000";
    const viewerResponse = await (options.request ?? fetch)(viewer.href, { signal: AbortSignal.timeout(20_000) });
    if (!viewerResponse.ok || !(await viewerResponse.text()).includes("noVNC")) throw new Error("Windows noVNC viewer is not ready.");

    let cdpUrl: string | undefined;
    try {
      await pollWindowsUntil(async () => {
        const response = await runPowerShell(exec, sandbox,
          `& curl.exe --fail --silent --max-time 4 http://127.0.0.1:${CDP_PORT}/json/version`, "Windows release CDP probe", 15_000);
        return response.includes(`OpenWork/${release.version}`) ? true : undefined;
      }, options.startupTimeoutMs ?? 180_000, "Windows release CDP");
      const privateCdp = await privateWebPreview(sandbox, CDP_PORT, exec, expiresInSeconds);
      const response = await (options.request ?? fetch)(new URL("/json/version", privateCdp.browserOrigin), { signal: AbortSignal.timeout(10_000) });
      if (!response.ok || !(await response.text()).includes(`OpenWork/${release.version}`)) throw new Error("Windows CDP is not reachable through the signed private preview.");
      cdpUrl = privateCdp.browserOrigin;
    } catch (error) {
      log(`==> Windows app not CDP-responsive: ${error instanceof Error ? error.message : String(error)}`);
    }
    const startup: ElectronStartupObservation = cdpUrl
      ? { state: "cdp-responsive", detail: "Published Windows app runs in interactive session 1 and responds through private CDP" }
      : { state: "unresponsive", detail: "Interactive app is running but private CDP did not respond; viewer retained for inspection" };
    const value: WindowsReleaseSandbox = {
      sandbox, release, installPath: BINARY, installerPath: INSTALLER, profilePath: PROFILE,
      logPath: LOG, viewerUrl: viewer.href, cdpUrl, startup,
      async [Symbol.asyncDispose](): Promise<void> { await deleteSandboxes([sandbox], { exec }); },
    };
    return value;
  } catch (error) {
    if (created) await deleteSandboxes([sandbox], { exec }).catch((cleanup: unknown) => {
      log(`==> Windows world cleanup failed: ${cleanup instanceof Error ? cleanup.message : String(cleanup)}`);
    });
    throw error;
  }
}
