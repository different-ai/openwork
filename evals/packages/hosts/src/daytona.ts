import { spawn } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import type { ChromeSurfaceOptions, DenServiceHandle, DenServiceOptions, ElectronSurfaceOptions, Host, ShareLinks, SurfaceHandle } from "./types.ts";

export interface DaytonaExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type DaytonaExec = (
  args: string[],
  opts?: { input?: string; timeoutMs?: number },
) => Promise<DaytonaExecResult>;

export interface DaytonaHostOptions {
  sandboxId?: string;
  log: (msg: string) => void;
  exec?: DaytonaExec;
  repoRoot: string;
  reservedChromePorts?: number[];
  reservedElectronPorts?: number[];
  serverScript?: boolean;
  waitForCdp?: (url: string, timeoutMs: number, label: string) => Promise<void>;
}

export interface DaytonaHost extends Host, AsyncDisposable {
  previewUrl(port: number): Promise<string>;
  startDen(opts?: DenServiceOptions): Promise<DenServiceHandle>;
  share(): Promise<ShareLinks>;
  stop(): Promise<void>;
}

interface PortAllocation {
  primary: number;
  next: number;
  used: Set<number>;
}

interface ProcessRunOptions {
  cwd: string;
  timeoutMs: number;
  onOutput: (text: string) => void;
}

const ELECTRON_CDP_WAIT_MS = 180_000;
const CHROME_CDP_WAIT_MS = 60_000;
const CDP_POLL_INTERVAL_MS = 1_000;
const SERVER_SCRIPT_TIMEOUT_MS = 20 * 60 * 1_000;
const STANDARD_NOVNC_PORT = 6080;
const STANDARD_ARTIFACTS_PORT = 8090;
const HTTPS_URL = /https:\/\/[^\s"'<>)]+/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultDaytonaExec(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<DaytonaExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("daytona", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? globalThis.setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, opts.timeoutMs)
      : null;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr: timedOut ? `${stderr}\nTimed out after ${opts.timeoutMs}ms.` : stderr,
        code: timedOut ? 124 : code ?? 1,
      });
    });
    child.stdin.end(opts.input ?? "");
  });
}

function runProcess(command: string, args: string[], opts: ProcessRunOptions): Promise<DaytonaExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = globalThis.setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      opts.onOutput(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      opts.onOutput(text);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: timedOut ? `${stderr}\nTimed out after ${opts.timeoutMs}ms.` : stderr,
        code: timedOut ? 124 : code ?? 1,
      });
    });
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertEnvName(name: string): void {
  if (!ENV_NAME.test(name)) {
    throw new Error(`Invalid environment variable name for Daytona surface: ${name}`);
  }
}

function shellExport(assignments: Map<string, string>): string {
  const parts: string[] = [];
  for (const [name, value] of assignments) {
    assertEnvName(name);
    parts.push(`${name}=${shellQuote(value)}`);
  }
  return `export ${parts.join(" ")};`;
}

function sanitizeName(name: string): string {
  const normalized: string[] = [];
  let invalidRun = false;
  for (const character of name.trim()) {
    const code = character.codePointAt(0) ?? 0;
    const allowed = (code >= 48 && code <= 57)
      || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || character === "."
      || character === "_"
      || character === "-";
    if (allowed) {
      normalized.push(character);
      invalidRun = false;
    } else if (!invalidRun) {
      normalized.push("-");
      invalidRun = true;
    }
  }
  let start = 0;
  let end = normalized.length;
  while (start < end && normalized[start] === "-") start += 1;
  while (end > start && normalized[end - 1] === "-") end -= 1;
  return normalized.slice(start, end).join("") || "surface";
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
}

function firstHttpsUrl(text: string): string | null {
  const match = HTTPS_URL.exec(text);
  return match ? match[0].replace(/[.,;:]+$/, "") : null;
}

function cleanBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function isOrgMode(value: unknown): value is "single_org" | "multi_org" {
  return value === "single_org" || value === "multi_org";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function runtimeOrgMode(webUrl: string): Promise<"single_org" | "multi_org"> {
  const response = await fetch(`${cleanBaseUrl(webUrl)}/api/runtime-config`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (isRecord(body) && isOrgMode(body.orgMode)) return body.orgMode;
  throw new Error("response did not include orgMode");
}

async function orgModeOrDefault(webUrl: string, log: (msg: string) => void): Promise<"single_org" | "multi_org"> {
  try {
    return await runtimeOrgMode(webUrl);
  } catch (error) {
    log(`Could not read Den runtime config from ${cleanBaseUrl(webUrl)}/api/runtime-config; assuming multi_org: ${messageText(error)}`);
    return "multi_org";
  }
}

async function checkedExec(exec: DaytonaExec, args: string[], context: string, opts: { input?: string; timeoutMs?: number } = {}): Promise<DaytonaExecResult> {
  const result = await exec(args, opts);
  if (result.code !== 0) {
    const details = (result.stderr || result.stdout).trim();
    throw new Error(`${context} failed with exit ${result.code}${details ? `: ${details}` : ""}`);
  }
  return result;
}

async function waitForHttpOk(url: string, timeoutMs: number, label: string): Promise<void> {
  const startedAt = Date.now();
  let lastError = "not attempted";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = messageText(error);
    }
    await setTimeout(CDP_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label} at ${url} (last error: ${lastError}).`);
}

function allocatePort(allocation: PortAllocation): number {
  if (!allocation.used.has(allocation.primary)) {
    allocation.used.add(allocation.primary);
    return allocation.primary;
  }
  let port = allocation.next;
  while (allocation.used.has(port)) port += 1;
  allocation.used.add(port);
  allocation.next = port + 1;
  return port;
}

function releasePort(allocation: PortAllocation, port: number): void {
  allocation.used.delete(port);
}

function cdpPort(handle: SurfaceHandle): number | null {
  const raw = handle.meta?.cdpPort;
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

function regexEscape(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function charClassEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\]/g, "\\]").replace(/\^/g, "\\^").replace(/-/g, "\\-");
}

function selfMatchSafeLiteral(value: string): string {
  if (!value) return "";
  const first = value[0] ?? "";
  return `[${charClassEscape(first)}]${regexEscape(value.slice(1))}`;
}

function selfMatchSafePortPattern(processPrefix: string, port: number): string {
  const value = String(port);
  return `${selfMatchSafeLiteral(processPrefix)}.*remote-debugging-port=${selfMatchSafeLiteral(value)}`;
}

function electronProfilePattern(profileDir: string): string {
  return `([e]lectron|[/]proc/self/exe).*--user-data-dir=${selfMatchSafeLiteral(profileDir)}`;
}

function electronProfileRoot(profileDir: string): string {
  const suffix = "/electron-userdata";
  return profileDir.endsWith(suffix) ? profileDir.slice(0, -suffix.length) : profileDir;
}

function killGroupsForPatternCommand(pattern: string, signal: "TERM" | "KILL"): string {
  return `for pid in $(pgrep -f ${shellQuote(pattern)} || true); do pgid=$(ps -o pgid= -p "$pid" | tr -d ' '); if [ -n "$pgid" ]; then kill -${signal} -"$pgid" 2>/dev/null || true; fi; done`;
}

function parseUrlAfterLabels(output: string, labels: string[]): string | null {
  for (const line of output.split(/\r?\n/)) {
    for (const label of labels) {
      if (line.includes(label)) {
        const url = firstHttpsUrl(line);
        if (url) return url;
      }
    }
  }
  return null;
}

function serverRefArg(): string | null {
  const explicit = process.env.OPENWORK_EVAL_DAYTONA_REF?.trim() || process.env.OPENWORK_EVAL_REF?.trim() || "";
  return explicit || null;
}

function portSet(values: number[] | undefined): Set<number> {
  const ports = new Set<number>();
  for (const value of values ?? []) {
    if (Number.isInteger(value) && value > 0 && value <= 65_535) ports.add(value);
  }
  return ports;
}

function appendExtraEnv(assignments: Map<string, string>, env: Record<string, string> | undefined): void {
  if (!env) return;
  for (const [name, value] of Object.entries(env).sort(([left], [right]) => left.localeCompare(right))) {
    assignments.set(name, value);
  }
}

export function createDaytonaHost(options: DaytonaHostOptions): DaytonaHost {
  const exec = options.exec ?? defaultDaytonaExec;
  const previewCache = new Map<number, string>();
  const electronPorts: PortAllocation = { primary: 9825, next: 9830, used: portSet(options.reservedElectronPorts) };
  const chromePorts: PortAllocation = { primary: 9222, next: 9230, used: portSet(options.reservedChromePorts) };
  const surfacePorts = new Map<number, string>();
  const waitForCdp = options.waitForCdp ?? waitForHttpOk;
  const spawnedSurfaces = new Set<SurfaceHandle>();

  function requireSandbox(): string {
    const sandbox = options.sandboxId?.trim() || process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim() || "";
    if (!sandbox) {
      throw new Error("Daytona sandbox required: create one with bash .devcontainer/test-on-daytona.sh <ref> or pass sandboxId.");
    }
    return sandbox;
  }

  async function previewUrl(port: number): Promise<string> {
    const cached = previewCache.get(port);
    if (cached) return cached;
    const sandbox = requireSandbox();
    const result = await checkedExec(exec, ["preview-url", sandbox, "-p", String(port)], `daytona preview-url ${sandbox} -p ${port}`);
    const url = firstHttpsUrl(result.stdout);
    if (!url) {
      throw new Error(`daytona preview-url ${sandbox} -p ${port} did not print an https URL: ${result.stdout.trim()}`);
    }
    previewCache.set(port, url);
    return url;
  }

  async function spawnElectron(name: string, opts: ElectronSurfaceOptions = {}): Promise<SurfaceHandle> {
    const sandbox = requireSandbox();
    const safeName = sanitizeName(name);
    const spawnStamp = timestamp();
    const profileRoot = `/workspace/.openwork-daytona/profiles/${safeName}-${spawnStamp}`;
    const profileDir = `${profileRoot}/electron-userdata`;
    const bootstrapPath = `${profileRoot}/bootstrap.json`;
    const port = allocatePort(electronPorts);
    // Per-spawn log so the integrity check below can never read a previous
    // run's lines.
    const logPath = `/tmp/electron-${safeName}-${spawnStamp}.log`;

    try {
      await checkedExec(exec, ["exec", sandbox, "--", "mkdir", "-p", shellQuote(profileDir)], `mkdir Daytona Electron profile ${profileDir}`, { timeoutMs: 30_000 });
      if (opts.bootstrap) {
        const bootstrapJson = `${JSON.stringify(opts.bootstrap, null, 2)}\n`;
        const encoded = Buffer.from(bootstrapJson, "utf8").toString("base64");
        await checkedExec(
          exec,
          ["exec", sandbox, "--", "echo", encoded, "|", "base64", "-d", ">", shellQuote(bootstrapPath)],
          `write Daytona Electron bootstrap ${bootstrapPath}`,
          { timeoutMs: 30_000 },
        );
      }

      const env = new Map<string, string>();
      appendExtraEnv(env, opts.env);
      env.set("DAYTONA_ELECTRON_LOG", logPath);
      env.set("OPENWORK_ELECTRON_REMOTE_DEBUG_PORT", String(port));
      env.set("OPENWORK_ELECTRON_USERDATA", profileDir);
      env.set("OPENWORK_WORKSPACE_DIR", "/workspace");
      env.set("OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT", "1");
      if (opts.bootstrap) env.set("OPENWORK_DESKTOP_BOOTSTRAP_PATH", bootstrapPath);

      const startCommand = `set -euo pipefail; cd /workspace; ${shellExport(env)} bash /workspace/.devcontainer/start-daytona-electron.sh --detach`;
      await checkedExec(
        exec,
        ["exec", sandbox, "--", `bash -lc ${shellQuote(startCommand)}`],
        `start Daytona Electron surface ${name}`,
        { timeoutMs: 60_000 },
      );

      const cdpUrl = await previewUrl(port);
      // SurfaceRegistry also waits 30s before attaching, but Daytona preview URLs
      // can route before cold Electron CDP is actually responsive; give remote
      // sandboxes a longer preflight here so attach remains a normal fast probe.
      await waitForCdp(`${cleanBaseUrl(cdpUrl)}/json/list`, ELECTRON_CDP_WAIT_MS, `Electron CDP ${name}`);
      // Spawn integrity: the port serving CDP must belong to THIS spawn, not a
      // pre-existing instance. electron-dev.mjs logs the resolved CDP port; if
      // it differs from the one we exported, the bind failed (port collision)
      // and attaching would silently drive the wrong app.
      const spawnLog = await checkedExec(
        exec,
        ["exec", sandbox, "--", "tail", "-c", "4000", logPath],
        `read Daytona Electron log ${logPath}`,
        { timeoutMs: 30_000 },
      );
      const exposed = /Electron CDP exposed at http:\/\/127\.0\.0\.1:(\d+)/.exec(spawnLog.stdout);
      if (exposed && exposed[1] !== String(port)) {
        throw new Error(
          `Daytona Electron surface ${name} resolved CDP port ${exposed[1]} instead of ${port} (port collision?). Log tail:\n${spawnLog.stdout.slice(-1200)}`,
        );
      }
      if (spawnLog.stdout.includes("Cannot start http server for devtools")) {
        throw new Error(
          `Daytona Electron surface ${name} could not bind its devtools port ${port}. Log tail:\n${spawnLog.stdout.slice(-1200)}`,
        );
      }
      surfacePorts.set(port, `electron:${name} CDP`);
      const handle: SurfaceHandle = {
        name,
        kind: "electron",
        hostKind: "daytona",
        cdpUrl,
        sandboxId: sandbox,
        profileDir,
        meta: { cdpPort: String(port), log: logPath },
      };
      spawnedSurfaces.add(handle);
      return handle;
    } catch (error) {
      releasePort(electronPorts, port);
      surfacePorts.delete(port);
      throw error;
    }
  }

  async function spawnChrome(name: string, opts: ChromeSurfaceOptions = {}): Promise<SurfaceHandle> {
    const sandbox = requireSandbox();
    const safeName = sanitizeName(name);
    const port = allocatePort(chromePorts);
    const profileDir = `/tmp/daytona-chrome-${safeName}`;
    const logPath = `/tmp/daytona-chrome-${safeName}.log`;
    const startUrl = opts.startUrl?.trim() || "about:blank";
    const command = [
      "set -euo pipefail",
      `mkdir -p ${shellQuote(profileDir)}`,
      "CHROME_BIN=\"$(command -v chromium || command -v google-chrome || command -v google-chrome-stable || true)\"",
      "if [ -z \"$CHROME_BIN\" ]; then echo 'No chromium/google-chrome binary found in sandbox.' >&2; exit 127; fi",
      `DISPLAY=:99 nohup "$CHROME_BIN" --headless=new --window-size=1280,900 --no-sandbox --disable-dev-shm-usage --ignore-gpu-blocklist --use-gl=swiftshader --enable-unsafe-swiftshader --remote-debugging-address=0.0.0.0 --remote-debugging-port=${port} --user-data-dir=${shellQuote(profileDir)} ${shellQuote(startUrl)} >${shellQuote(logPath)} 2>&1 &`,
    ].join("; ");

    try {
      await checkedExec(exec, ["exec", sandbox, "--", `bash -lc ${shellQuote(command)}`], `start Daytona Chrome surface ${name}`, { timeoutMs: 30_000 });
      const cdpUrl = await previewUrl(port);
      await waitForCdp(`${cleanBaseUrl(cdpUrl)}/json/version`, CHROME_CDP_WAIT_MS, `Chrome CDP ${name}`);
      surfacePorts.set(port, `chrome:${name} CDP`);
      const handle: SurfaceHandle = {
        name,
        kind: "chrome",
        hostKind: "daytona",
        cdpUrl,
        sandboxId: sandbox,
        profileDir,
        meta: { cdpPort: String(port), log: logPath },
      };
      spawnedSurfaces.add(handle);
      return handle;
    } catch (error) {
      releasePort(chromePorts, port);
      surfacePorts.delete(port);
      throw error;
    }
  }

  async function startDen(opts: DenServiceOptions = {}): Promise<DenServiceHandle> {
    const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim();
    const webUrl = process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim();
    if (apiUrl && webUrl) {
      return {
        webUrl,
        apiUrl,
        orgMode: await orgModeOrDefault(webUrl, options.log),
        hostKind: "daytona",
      };
    }

    if (!options.serverScript) {
      throw new Error("No Den URLs in OPENWORK_EVAL_DEN_API_URL/OPENWORK_EVAL_DEN_WEB_URL. Set them, or create the server with bash .devcontainer/test-server-on-daytona.sh <ref> and rerun with serverScript enabled.");
    }

    const args = [".devcontainer/test-server-on-daytona.sh"];
    const ref = serverRefArg();
    // The provisioning script can take several minutes because it may create a
    // Daytona sandbox and build/install the Den stack; keep the timeout generous.
    if (ref) args.push(ref);
    const result = await runProcess("bash", args, {
      cwd: options.repoRoot,
      timeoutMs: SERVER_SCRIPT_TIMEOUT_MS,
      onOutput: options.log,
    });
    if (result.code !== 0) {
      const details = (result.stderr || result.stdout).trim();
      throw new Error(`Daytona Den server script failed with exit ${result.code}${details ? `: ${details}` : ""}`);
    }
    const parsedWebUrl = parseUrlAfterLabels(result.stdout, ["DEN_WEB_URL", "Den Web:"]);
    const parsedApiUrl = parseUrlAfterLabels(result.stdout, ["DEN_API_URL", "Den API:"]);
    if (!parsedWebUrl || !parsedApiUrl) {
      throw new Error("Daytona Den server script did not print Den Web and Den API URLs.");
    }
    return {
      webUrl: parsedWebUrl,
      apiUrl: parsedApiUrl,
      orgMode: opts.orgMode ?? await orgModeOrDefault(parsedWebUrl, options.log),
      hostKind: "daytona",
    };
  }

  async function disposeSurface(handle: SurfaceHandle): Promise<void> {
    if (handle.hostKind !== "daytona") return;
    const sandbox = handle.sandboxId?.trim() || requireSandbox();
    const port = cdpPort(handle);

    if (handle.kind === "electron" && port !== null) {
      const pattern = selfMatchSafePortPattern("electron", port);
      const profilePattern = handle.profileDir ? electronProfilePattern(handle.profileDir) : "";
      const stopCommand = [
        profilePattern ? killGroupsForPatternCommand(profilePattern, "TERM") : "true",
        `pkill -f ${shellQuote(pattern)} || true`,
        "sleep 1",
        profilePattern ? killGroupsForPatternCommand(profilePattern, "KILL") : "true",
        `pkill -f ${shellQuote(pattern)} || true`,
      ].join("; ");
      await checkedExec(
        exec,
        ["exec", sandbox, "--", `bash -lc ${shellQuote(stopCommand)}`],
        `stop Daytona Electron surface ${handle.name}`,
        { timeoutMs: 15_000 },
      );
      await checkedExec(
        exec,
        ["exec", sandbox, "--", `bash -lc ${shellQuote(`sleep 1; curl -sf http://127.0.0.1:${port}/json/list >/dev/null 2>&1 || true`)}`],
        `verify Daytona Electron CDP stopped ${handle.name}`,
        { timeoutMs: 15_000 },
      );
      if (handle.profileDir) {
        await checkedExec(
          exec,
          ["exec", sandbox, "--", `bash -lc ${shellQuote(`rm -rf ${shellQuote(electronProfileRoot(handle.profileDir))}`)}`],
          `remove Daytona Electron profile ${handle.name}`,
          { timeoutMs: 15_000 },
        );
      }
      releasePort(electronPorts, port);
      surfacePorts.delete(port);
      spawnedSurfaces.delete(handle);
      return;
    }

    if (handle.kind === "chrome") {
      const profileDir = handle.profileDir ?? `/tmp/daytona-chrome-${sanitizeName(handle.name)}`;
      const pattern = `(chromium|chrome).*--user-data-dir=${selfMatchSafeLiteral(profileDir)}`;
      await checkedExec(
        exec,
        ["exec", sandbox, "--", `bash -lc ${shellQuote(`pkill -f ${shellQuote(pattern)} || true`)}`],
        `stop Daytona Chrome surface ${handle.name}`,
        { timeoutMs: 15_000 },
      );
      if (port !== null) {
        await checkedExec(
          exec,
          ["exec", sandbox, "--", `bash -lc ${shellQuote(`sleep 1; curl -sf http://127.0.0.1:${port}/json/version >/dev/null 2>&1 || true`)}`],
          `verify Daytona Chrome CDP stopped ${handle.name}`,
          { timeoutMs: 15_000 },
        );
        await checkedExec(
          exec,
          ["exec", sandbox, "--", `bash -lc ${shellQuote(`rm -rf ${shellQuote(profileDir)}`)}`],
          `remove Daytona Chrome profile ${handle.name}`,
          { timeoutMs: 15_000 },
        );
        releasePort(chromePorts, port);
        surfacePorts.delete(port);
      }
      spawnedSurfaces.delete(handle);
    }
  }

  async function share() {
    const links: { label: string; url: string }[] = [];
    for (const [port, label] of surfacePorts) {
      links.push({ label, url: await previewUrl(port) });
    }
    links.push({ label: "noVNC visual", url: await previewUrl(STANDARD_NOVNC_PORT) });
    links.push({ label: "artifacts", url: await previewUrl(STANDARD_ARTIFACTS_PORT) });
    return links;
  }

  async function stop(): Promise<void> {
    for (const handle of [...spawnedSurfaces]) await disposeSurface(handle);
  }

  return {
    kind: "daytona",
    previewUrl,
    spawnElectron,
    spawnChrome,
    startDen,
    share,
    disposeSurface,
    stop,
    async [Symbol.asyncDispose](): Promise<void> {
      for (const handle of [...spawnedSurfaces]) {
        await disposeSurface(handle)
          .catch((error: unknown) => options.log(`Daytona surface ${handle.name} cleanup failed: ${messageText(error)}`));
      }
    },
  };
}
