import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
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

export type EnterpriseTlsEdgeDaytonaOptions = {
  sandboxId: string;
  upstream: string;
  candidatePort?: number;
  negativePort?: number;
  adminPort?: number;
  manifestPath?: string;
};

export type EnterpriseTlsEdgeDaytonaCommands = {
  candidateUrl: string;
  negativeUrl: string;
  adminUrl: string;
  manifestPath: string;
  prepare: string[][];
  start: string[];
  probe: string[];
  requests: string[];
  installRoot: string[];
  removeRoot: string[];
  stop: string[];
};

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
const ENTERPRISE_TLS_RUNTIME_ROOT = "/tmp/openwork-enterprise-tls-runtime";
const MAX_ENTERPRISE_TLS_RUNTIME_SOURCE_BYTES = 64 * 1024;
const ENTERPRISE_TLS_BASE64_CHUNK_LENGTH = 8 * 1024;
/** Conservative ceiling for each complete Daytona argv command string. */
export const MAX_ENTERPRISE_TLS_DAYTONA_COMMAND_LENGTH = 12 * 1024;
const ENTERPRISE_TLS_RUNTIME_SOURCES = [
  {
    local: new URL("../../../scripts/enterprise-tls-edge.mts", import.meta.url),
    remote: `${ENTERPRISE_TLS_RUNTIME_ROOT}/evals/scripts/enterprise-tls-edge.mts`,
  },
  {
    local: new URL("../../labs/src/egress.ts", import.meta.url),
    remote: `${ENTERPRISE_TLS_RUNTIME_ROOT}/evals/packages/labs/src/egress.ts`,
  },
];

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function defaultDaytonaExec(
  args: string[],
  opts: { input?: string; timeoutMs?: number } = {},
  command = "daytona",
): Promise<DaytonaExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
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
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({
        stdout,
        stderr: timedOut ? `${stderr}\nTimed out after ${opts.timeoutMs}ms.` : stderr,
        code: timedOut ? 124 : code ?? 1,
      });
    });
    child.stdin.on("error", (error) => {
      if (("code" in error && error.code === "EPIPE") || settled) return;
      if (timer) clearTimeout(timer);
      settled = true;
      reject(error);
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

/**
 * Daytona CLI transport failures print `level=fatal msg="..."` (HTML error
 * pages, EOFs, resets from the Daytona API) and mean the remote command never
 * executed, so retrying is always safe. Remote command failures — a non-zero
 * exit without a CLI fatal transport message — are never retried.
 */
const TRANSIENT_DAYTONA_CLI_MESSAGES = [
  /invalid character '<'/i,
  /unexpected EOF/i,
  /^EOF$/,
  /unexpected end of JSON input/i,
  /connection reset/i,
  /bad gateway/i,
  /service unavailable/i,
  /too many requests/i,
];

function transientDaytonaCliFailure(result: DaytonaExecResult): boolean {
  if (result.code === 0) return false;
  const fatalMessages = [...`${result.stderr}\n${result.stdout}`.matchAll(/level=fatal msg="((?:[^"\\]|\\.)*)"/g)]
    .map((match) => match[1]);
  return fatalMessages.some((message) => TRANSIENT_DAYTONA_CLI_MESSAGES.some((pattern) => pattern.test(message)));
}

export async function checkedExec(exec: DaytonaExec, args: string[], context: string, opts: { input?: string; timeoutMs?: number; retryDelayMs?: number } = {}): Promise<DaytonaExecResult> {
  const attempts = 3;
  const { retryDelayMs, ...execOpts } = opts;
  let result = await exec(args, execOpts);
  for (let attempt = 1; attempt < attempts && transientDaytonaCliFailure(result); attempt += 1) {
    await setTimeout(retryDelayMs ?? attempt * 2_000);
    result = await exec(args, execOpts);
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    const stdout = result.stdout.trim();
    const details = [stderr ? `stderr:\n${stderr}` : "", stdout ? `stdout:\n${stdout}` : ""].filter(Boolean).join("\n\n");
    throw new Error(`${context} failed with exit ${result.code}${details ? `:\n${details}` : ""}`);
  }
  return result;
}

/** Daytona exec argv for a co-located enterprise TLS edge lifecycle. */
export function enterpriseTlsEdgeDaytonaCommands(options: EnterpriseTlsEdgeDaytonaOptions): EnterpriseTlsEdgeDaytonaCommands {
  const sandbox = options.sandboxId.trim();
  if (!sandbox) throw new Error("Enterprise TLS edge Daytona sandboxId is required.");
  const upstream = new URL(options.upstream);
  if ((upstream.protocol !== "http:" && upstream.protocol !== "https:")
    || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash) {
    throw new Error("Enterprise TLS edge upstream must be an HTTP(S) origin.");
  }
  const candidatePort = options.candidatePort ?? 8443;
  const negativePort = options.negativePort ?? 9443;
  const adminPort = options.adminPort ?? 8445;
  for (const port of [candidatePort, negativePort, adminPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid enterprise TLS edge port: ${port}`);
  }
  if (new Set([candidatePort, negativePort, adminPort]).size !== 3) {
    throw new Error("Enterprise TLS edge candidate, negative, and admin ports must be distinct.");
  }
  const manifestPath = options.manifestPath ?? "/tmp/openwork-enterprise-tls-edge.json";
  if (!manifestPath.startsWith("/")) throw new Error("Enterprise TLS edge manifestPath must be absolute.");
  const sources = ENTERPRISE_TLS_RUNTIME_SOURCES.map(({ local, remote }) => ({
    content: readFileSync(fileURLToPath(local)),
    remote,
  }));
  const sourceBytes = sources.reduce((total, source) => total + source.content.byteLength, 0);
  if (sourceBytes > MAX_ENTERPRISE_TLS_RUNTIME_SOURCE_BYTES) {
    throw new Error(`Enterprise TLS runtime source is ${sourceBytes} bytes; maximum is ${MAX_ENTERPRISE_TLS_RUNTIME_SOURCE_BYTES}.`);
  }
  const script = ENTERPRISE_TLS_RUNTIME_SOURCES[0].remote;
  const log = "/tmp/openwork-enterprise-tls-edge.log";
  const adminToken = randomBytes(32).toString("hex");
  if (!/^[a-f0-9]{32,}$/.test(adminToken)) throw new Error("Enterprise TLS admin token must be at least 32 hex characters.");
  const remote = (command: string) => {
    const args = ["exec", sandbox, "--", `bash -lc ${shellQuote(command)}`];
    const commandLength = args.join(" ").length;
    if (commandLength > MAX_ENTERPRISE_TLS_DAYTONA_COMMAND_LENGTH) {
      throw new Error(`Enterprise TLS Daytona command is ${commandLength} characters; maximum is ${MAX_ENTERPRISE_TLS_DAYTONA_COMMAND_LENGTH}.`);
    }
    return args;
  };
  const directories = sources.map((source) => source.remote.slice(0, source.remote.lastIndexOf("/")));
  const prepare = [remote([
    `/usr/bin/rm -rf ${ENTERPRISE_TLS_RUNTIME_ROOT}`,
    `/usr/bin/mkdir -p ${directories.join(" ")}`,
    `/usr/bin/touch ${sources.map((source) => `${source.remote}.b64`).join(" ")}`,
  ].join(" && "))];
  for (const source of sources) {
    const encoded = source.content.toString("base64");
    for (let offset = 0; offset < encoded.length; offset += ENTERPRISE_TLS_BASE64_CHUNK_LENGTH) {
      const chunk = encoded.slice(offset, offset + ENTERPRISE_TLS_BASE64_CHUNK_LENGTH);
      prepare.push(remote(`/usr/bin/printf %s ${chunk} >> ${source.remote}.b64`));
    }
    prepare.push(remote([
      "decode_status=0",
      `/usr/bin/base64 -d ${source.remote}.b64 > ${source.remote} || decode_status=$?`,
      `actual_bytes=$(/usr/bin/wc -c < ${source.remote})`,
      `/usr/bin/rm -f ${source.remote}.b64`,
      'test "$decode_status" -eq 0',
      `test "$actual_bytes" -eq ${source.content.byteLength}`,
    ].join("; ")));
  }
  const serve = [
    "/usr/bin/env", "node", script, "serve",
    "--upstream", upstream.origin,
    "--candidate-port", String(candidatePort),
    "--negative-port", String(negativePort),
    "--admin-port", String(adminPort),
    "--manifest", manifestPath,
  ].map(shellQuote).join(" ");
  const action = (name: "install" | "remove") => remote([
    "node_path=$(command -v node)",
    'test -n "$node_path"',
    `/usr/bin/sudo -n "$node_path" ${[script, name, "--manifest", manifestPath].map(shellQuote).join(" ")}`,
  ].join(" && "));
  const adminUrl = `http://127.0.0.1:${adminPort}`;
  return {
    candidateUrl: `https://localhost:${candidatePort}`,
    negativeUrl: `https://localhost:${negativePort}`,
    adminUrl,
    manifestPath,
    prepare,
    start: remote([
      `rm -f ${shellQuote(manifestPath)}`,
      `ENTERPRISE_TLS_ADMIN_TOKEN=${adminToken} nohup ${serve} >${shellQuote(log)} 2>&1 </dev/null &`,
      "attempt=0",
      `until /usr/bin/curl --fail --silent -H "Authorization: Bearer ${adminToken}" ${shellQuote(`${adminUrl}/health`)} >/dev/null; do attempt=$((attempt + 1)); if [ "$attempt" -ge 120 ]; then /usr/bin/tail -c 4000 ${shellQuote(log)} >&2; exit 1; fi; sleep 0.25; done`,
    ].join("\n")),
    probe: remote(`/usr/bin/curl --fail --silent --show-error -H "Authorization: Bearer ${adminToken}" ${shellQuote(`${adminUrl}/health`)}`),
    requests: remote(`/usr/bin/curl --fail --silent --show-error -H "Authorization: Bearer ${adminToken}" ${shellQuote(`${adminUrl}/requests`)}`),
    installRoot: action("install"),
    removeRoot: action("remove"),
    stop: remote(`${[
      "/usr/bin/env", "node", script, "stop", "--manifest", manifestPath,
    ].map(shellQuote).join(" ")} && /usr/bin/rm -rf ${shellQuote(ENTERPRISE_TLS_RUNTIME_ROOT)}`),
  };
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

/**
 * Ports already listening INSIDE the sandbox.
 *
 * The local host finds a free port by binding one; this host cannot, because the
 * port has to be free on a different machine. Allocating from a local counter
 * alone silently collides: the OpenCode sidecar picks its own port at boot and
 * was observed holding 9825 — the CDP primary — so Electron's debugger never
 * bound and the preview URL timed out after 180s with no hint of the cause.
 */
async function sandboxListeningPorts(exec: DaytonaExec, sandbox: string): Promise<Set<number>> {
  const result = await exec(["exec", sandbox, "--", "bash -lc 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null'"], { timeoutMs: 30_000 });
  const ports = new Set<number>();
  if (result.code !== 0) return ports;
  for (const line of result.stdout.split(/\r?\n/)) {
    // Match the local-address column's :PORT, e.g. "127.0.0.1:9825" or "*:3005".
    const match = /[:.](\d{2,5})\s+\S+\s*$/.exec(line.trim()) ?? /[:.](\d{2,5})\s/.exec(line.trim());
    if (!match) continue;
    const port = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(port) && port > 0 && port <= 65_535) ports.add(port);
  }
  return ports;
}

/** Allocate a port that is free in the sandbox, not merely unused by this host. */
async function allocateSandboxPort(allocation: PortAllocation, exec: DaytonaExec, sandbox: string): Promise<number> {
  const taken = await sandboxListeningPorts(exec, sandbox);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const port = allocatePort(allocation);
    if (!taken.has(port)) return port;
    // Keep it marked used so we never hand it out again this session.
  }
  throw new Error(`Could not find a port free inside sandbox ${sandbox} after 64 attempts.`);
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
    if (opts.profileDir !== undefined && !opts.profileDir.trim()) {
      throw new Error("Electron profileDir must not be empty.");
    }
    const callerOwnedProfile = opts.profileDir !== undefined;
    const profileRoot = opts.profileDir ?? `/workspace/.openwork-daytona/profiles/${safeName}-${spawnStamp}`;
    const userDataDir = `${profileRoot}/electron-userdata`;
    const bootstrapPath = `${profileRoot}/bootstrap.json`;
    const port = await allocateSandboxPort(electronPorts, exec, sandbox);
    // Per-spawn log so the integrity check below can never read a previous
    // run's lines.
    const logPath = `/tmp/electron-${safeName}-${spawnStamp}.log`;

    try {
      await checkedExec(exec, ["exec", sandbox, "--", "mkdir", "-p", shellQuote(userDataDir)], `mkdir Daytona Electron profile ${userDataDir}`, { timeoutMs: 30_000 });
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
      env.set("OPENWORK_ELECTRON_USERDATA", userDataDir);
      env.set("OPENWORK_WORKSPACE_DIR", "/workspace");
      env.set("OPENWORK_GOOGLE_WORKSPACE_ALLOW_PLAINTEXT_VAULT", "1");
      const packagedBinary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
      if (packagedBinary) env.set("OPENWORK_EVAL_ELECTRON_BINARY", packagedBinary);
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
        profileDir: profileRoot,
        meta: { cdpPort: String(port), log: logPath, profileOwner: callerOwnedProfile ? "caller" : "host" },
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
    const port = await allocateSandboxPort(chromePorts, exec, sandbox);
    const profileDir = `/tmp/daytona-chrome-${safeName}`;
    const logPath = `/tmp/daytona-chrome-${safeName}.log`;
    const startUrl = opts.startUrl?.trim() || "about:blank";
    const command = [
      "set -euo pipefail",
      `mkdir -p ${shellQuote(profileDir)}`,
      "CHROME_BIN=\"$(command -v chromium || command -v google-chrome || command -v google-chrome-stable || true)\"",
      "if [ -z \"$CHROME_BIN\" ]; then echo 'No chromium/google-chrome binary found in sandbox.' >&2; exit 127; fi",
      `DISPLAY=:99 nohup "$CHROME_BIN" --headless=new --window-size=1280,900 --no-sandbox --disable-dev-shm-usage --ignore-gpu-blocklist --use-gl=swiftshader --enable-unsafe-swiftshader --disable-http2 --remote-debugging-address=0.0.0.0 --remote-debugging-port=${port} --user-data-dir=${shellQuote(profileDir)} ${shellQuote(startUrl)} >${shellQuote(logPath)} 2>&1 &`,
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
      const profilePattern = handle.profileDir
        ? electronProfilePattern(`${electronProfileRoot(handle.profileDir)}/electron-userdata`)
        : "";
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
      if (handle.profileDir && handle.meta?.profileOwner !== "caller") {
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
    workspaceRoot: "/workspace",
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
