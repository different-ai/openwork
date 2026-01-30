#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { hostname, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { once } from "node:events";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

type ApprovalMode = "manual" | "auto";

const VERSION = "0.1.0";
const DEFAULT_OPENWORK_PORT = 8787;
const DEFAULT_APPROVAL_TIMEOUT = 30000;
const DEFAULT_OPENCODE_USERNAME = "opencode";

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type ChildHandle = {
  name: string;
  child: ReturnType<typeof spawn>;
};

type FieldsResult<T> = {
  data?: T;
  error?: unknown;
  request?: Request;
  response?: Response;
};

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "-v") {
      flags.set("version", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    if (!trimmed) continue;

    if (trimmed.startsWith("no-")) {
      flags.set(trimmed.slice(3), false);
      continue;
    }

    const [key, inlineValue] = trimmed.split("=");
    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { positionals, flags };
}

function parseList(value?: string): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean);
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readFlag(flags: Map<string, string | boolean>, key: string): string | undefined {
  const value = flags.get(key);
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

function readBool(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: boolean,
  envKey?: string,
): boolean {
  const raw = flags.get(key);
  if (raw !== undefined) {
    if (typeof raw === "boolean") return raw;
    const normalized = String(raw).toLowerCase();
    if (["false", "0", "no"].includes(normalized)) return false;
    if (["true", "1", "yes"].includes(normalized)) return true;
  }

  const envValue = envKey ? process.env[envKey] : undefined;
  if (envValue) {
    const normalized = envValue.toLowerCase();
    if (["false", "0", "no"].includes(normalized)) return false;
    if (["true", "1", "yes"].includes(normalized)) return true;
  }

  return fallback;
}

function readNumber(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: number | undefined,
  envKey?: string,
): number | undefined {
  const raw = flags.get(key);
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (envKey) {
    const envValue = process.env[envKey];
    if (envValue) {
      const parsed = Number(envValue);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return fallback;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureWorkspace(workspace: string): Promise<string> {
  const resolved = resolve(workspace);
  await mkdir(resolved, { recursive: true });

  const configPath = join(resolved, "opencode.json");
  if (!(await fileExists(configPath))) {
    const payload = JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2);
    await writeFile(configPath, `${payload}\n`, "utf8");
  }

  return resolved;
}

async function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (err) => reject(err));
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function resolvePort(preferred: number | undefined, host: string, fallback?: number): Promise<number> {
  if (preferred && (await canBind(host, preferred))) {
    return preferred;
  }
  if (fallback && fallback !== preferred && (await canBind(host, fallback))) {
    return fallback;
  }
  return findFreePort(host);
}

function resolveLanIp(): string | null {
  const interfaces = networkInterfaces();
  for (const key of Object.keys(interfaces)) {
    const entries = interfaces[key];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      return entry.address;
    }
  }
  return null;
}

function resolveConnectUrl(port: number, overrideHost?: string): { connectUrl?: string; lanUrl?: string; mdnsUrl?: string } {
  if (overrideHost) {
    const trimmed = overrideHost.trim();
    if (trimmed) {
      const url = `http://${trimmed}:${port}`;
      return { connectUrl: url, lanUrl: url };
    }
  }

  const host = hostname().trim();
  const mdnsUrl = host ? `http://${host.replace(/\.local$/, "")}.local:${port}` : undefined;
  const lanIp = resolveLanIp();
  const lanUrl = lanIp ? `http://${lanIp}:${port}` : undefined;
  const connectUrl = lanUrl ?? mdnsUrl;
  return { connectUrl, lanUrl, mdnsUrl };
}

function encodeBasicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

function unwrap<T>(result: FieldsResult<T>): T {
  if (result.data !== undefined) {
    return result.data;
  }
  const message =
    result.error instanceof Error
      ? result.error.message
      : typeof result.error === "string"
        ? result.error
        : JSON.stringify(result.error);
  throw new Error(message || "Unknown error");
}

function prefixStream(
  stream: NodeJS.ReadableStream | null,
  label: string,
  level: "stdout" | "stderr",
): void {
  if (!stream) return;
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = `[${label}] ${line}`;
      if (level === "stderr") {
        console.error(message);
      } else {
        console.log(message);
      }
    }
  });
  stream.on("end", () => {
    if (!buffer.trim()) return;
    const message = `[${label}] ${buffer}`;
    if (level === "stderr") {
      console.error(message);
    } else {
      console.log(message);
    }
  });
}

function shouldUseBun(bin: string): boolean {
  if (!bin.endsWith(`${join("dist", "cli.js")}`)) return false;
  if (bin.includes("openwork-server")) return true;
  return bin.includes(`${join("packages", "server")}`);
}

function resolveBinCommand(bin: string): { command: string; prefixArgs: string[] } {
  if (bin.endsWith(".ts")) {
    return { command: "bun", prefixArgs: [bin, "--"] };
  }
  if (bin.endsWith(".js")) {
    if (shouldUseBun(bin)) {
      return { command: "bun", prefixArgs: [bin, "--"] };
    }
    return { command: "node", prefixArgs: [bin, "--"] };
  }
  return { command: bin, prefixArgs: [] };
}

function resolveBinPath(bin: string): string {
  if (bin.includes("/") || bin.startsWith(".")) {
    return resolve(process.cwd(), bin);
  }
  return bin;
}

async function resolveOpenworkServerBin(explicit?: string): Promise<string> {
  if (explicit) {
    return resolveBinPath(explicit);
  }

  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("openwork-server/package.json");
    const pkgDir = dirname(pkgPath);
    const cliPath = join(pkgDir, "dist", "cli.js");
    if (await isExecutable(cliPath)) {
      return cliPath;
    }
  } catch {
    // ignore
  }

  return "openwork-server";
}

async function waitForHealthy(url: string, timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for health check");
}

async function waitForOpencodeHealthy(client: ReturnType<typeof createOpencodeClient>, timeoutMs = 10_000, pollMs = 250) {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const health = unwrap(await client.global.health());
      if (health?.healthy) return health;
      lastError = "Server reported unhealthy";
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for OpenCode health");
}

function printHelp(): void {
  const message = [
    "openwrk",
    "",
    "Usage:",
    "  openwrk start [--workspace <path>] [options]",
    "  openwrk approvals list --openwork-url <url> --host-token <token>",
    "  openwrk approvals reply <id> --allow|--deny --openwork-url <url> --host-token <token>",
    "  openwrk status [--openwork-url <url>] [--opencode-url <url>]",
    "",
    "Commands:",
    "  start                   Start OpenCode + OpenWork server + Owpenbot",
    "  approvals list           List pending approval requests",
    "  approvals reply <id>     Approve or deny a request",
    "  status                  Check OpenCode/OpenWork health",
    "",
    "Options:",
    "  --workspace <path>        Workspace directory (default: cwd)",
    "  --opencode-bin <path>     Path to opencode binary (default: opencode)",
    "  --opencode-host <host>    Bind host for opencode serve (default: 0.0.0.0)",
    "  --opencode-port <port>    Port for opencode serve (default: random)",
    "  --opencode-auth           Enable OpenCode basic auth (default: true)",
    "  --no-opencode-auth        Disable OpenCode basic auth",
    "  --opencode-username <u>   OpenCode basic auth username",
    "  --opencode-password <p>   OpenCode basic auth password",
    "  --openwork-host <host>    Bind host for openwork-server (default: 0.0.0.0)",
    "  --openwork-port <port>    Port for openwork-server (default: 8787)",
    "  --openwork-token <token>  Client token for openwork-server",
    "  --openwork-host-token <t> Host token for approvals",
    "  --approval <mode>         manual | auto (default: manual)",
    "  --approval-timeout <ms>   Approval timeout in ms",
    "  --read-only               Start OpenWork server in read-only mode",
    "  --cors <origins>          Comma-separated CORS origins or *",
    "  --connect-host <host>     Override LAN host used for pairing URLs",
    "  --openwork-server-bin <p> Path to openwork-server binary",
    "  --owpenbot-bin <path>     Path to owpenbot binary (default: owpenbot)",
    "  --no-owpenbot             Disable owpenbot sidecar",
    "  --check                   Run health checks then exit",
    "  --check-events            Verify SSE events during check",
    "  --json                    Output JSON when applicable",
    "  --help                    Show help",
    "  --version                 Show version",
  ].join("\n");
  console.log(message);
}

async function stopChild(child: ReturnType<typeof spawn>, timeoutMs = 2500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
  if (exited) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
}

async function startOpencode(options: {
  bin: string;
  workspace: string;
  bindHost: string;
  port: number;
  username?: string;
  password?: string;
  corsOrigins: string[];
}) {
  const args = ["serve", "--hostname", options.bindHost, "--port", String(options.port)];
  for (const origin of options.corsOrigins) {
    args.push("--cors", origin);
  }

  const child = spawn(options.bin, args, {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_CLIENT: "openwrk",
      OPENWORK: "1",
      ...(options.username ? { OPENCODE_SERVER_USERNAME: options.username } : {}),
      ...(options.password ? { OPENCODE_SERVER_PASSWORD: options.password } : {}),
    },
  });

  prefixStream(child.stdout, "opencode", "stdout");
  prefixStream(child.stderr, "opencode", "stderr");

  return child;
}

async function startOpenworkServer(options: {
  bin: string;
  host: string;
  port: number;
  workspace: string;
  token: string;
  hostToken: string;
  approvalMode: ApprovalMode;
  approvalTimeoutMs: number;
  readOnly: boolean;
  corsOrigins: string[];
  opencodeBaseUrl?: string;
  opencodeDirectory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
}) {
  const args = [
    "--host",
    options.host,
    "--port",
    String(options.port),
    "--token",
    options.token,
    "--host-token",
    options.hostToken,
    "--workspace",
    options.workspace,
    "--approval",
    options.approvalMode,
    "--approval-timeout",
    String(options.approvalTimeoutMs),
  ];

  if (options.readOnly) {
    args.push("--read-only");
  }

  if (options.corsOrigins.length) {
    args.push("--cors", options.corsOrigins.join(","));
  }

  if (options.opencodeBaseUrl) {
    args.push("--opencode-base-url", options.opencodeBaseUrl);
  }
  if (options.opencodeDirectory) {
    args.push("--opencode-directory", options.opencodeDirectory);
  }
  if (options.opencodeUsername) {
    args.push("--opencode-username", options.opencodeUsername);
  }
  if (options.opencodePassword) {
    args.push("--opencode-password", options.opencodePassword);
  }

  const resolved = resolveBinCommand(options.bin);
  const child = spawn(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
  });

  prefixStream(child.stdout, "openwork-server", "stdout");
  prefixStream(child.stderr, "openwork-server", "stderr");

  return child;
}

async function startOwpenbot(options: {
  bin: string;
  workspace: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
}) {
  const args = ["start", options.workspace];
  if (options.opencodeUrl) {
    args.push("--opencode-url", options.opencodeUrl);
  }

  const resolved = resolveBinCommand(options.bin);
  const child = spawn(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(options.opencodeUsername ? { OPENCODE_SERVER_USERNAME: options.opencodeUsername } : {}),
      ...(options.opencodePassword ? { OPENCODE_SERVER_PASSWORD: options.opencodePassword } : {}),
    },
  });

  prefixStream(child.stdout, "owpenbot", "stdout");
  prefixStream(child.stderr, "owpenbot", "stderr");

  return child;
}

async function runChecks(input: {
  opencodeClient: ReturnType<typeof createOpencodeClient>;
  openworkUrl: string;
  openworkToken: string;
  checkEvents: boolean;
}) {
  const headers = { Authorization: `Bearer ${input.openworkToken}` };
  const workspaces = await fetchJson(`${input.openworkUrl}/workspaces`, { headers });
  if (!workspaces?.items?.length) {
    throw new Error("OpenWork server returned no workspaces");
  }

  const workspaceId = workspaces.items[0].id as string;
  await fetchJson(`${input.openworkUrl}/workspace/${workspaceId}/config`, { headers });

  const created = await input.opencodeClient.session.create({ title: "OpenWork headless check" });
  const createdSession = unwrap(created);
  unwrap(await input.opencodeClient.session.messages({ sessionID: createdSession.id, limit: 10 }));

  if (input.checkEvents) {
    const events: { type: string }[] = [];
    const controller = new AbortController();
    const subscription = await input.opencodeClient.event.subscribe(undefined, { signal: controller.signal });
    const reader = (async () => {
      try {
        for await (const raw of subscription.stream) {
          const normalized = normalizeEvent(raw);
          if (!normalized) continue;
          events.push(normalized);
          if (events.length >= 10) break;
        }
      } catch {
        // ignore
      }
    })();

    unwrap(await input.opencodeClient.session.create({ title: "OpenWork headless check events" }));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    controller.abort();
    await Promise.race([reader, new Promise((resolve) => setTimeout(resolve, 500))]);

    if (!events.length) {
      throw new Error("No SSE events observed during check");
    }
  }
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.message ? ` ${payload.message}` : "";
    throw new Error(`HTTP ${response.status}${message}`);
  }
  return payload;
}

function normalizeEvent(raw: unknown): { type: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type === "string") return { type: record.type };
  const payload = record.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.type === "string") return { type: payload.type };
  return null;
}

async function runApprovals(args: ParsedArgs) {
  const subcommand = args.positionals[1];
  if (!subcommand || (subcommand !== "list" && subcommand !== "reply")) {
    throw new Error("approvals requires 'list' or 'reply'");
  }

  const openworkUrl =
    readFlag(args.flags, "openwork-url") ??
    process.env.OPENWORK_URL ??
    process.env.OPENWORK_SERVER_URL ??
    "";
  const hostToken = readFlag(args.flags, "host-token") ?? process.env.OPENWORK_HOST_TOKEN ?? "";

  if (!openworkUrl || !hostToken) {
    throw new Error("openwork-url and host-token are required for approvals");
  }

  const headers = {
    "Content-Type": "application/json",
    "X-OpenWork-Host-Token": hostToken,
  };

  if (subcommand === "list") {
    const response = await fetch(`${openworkUrl.replace(/\/$/, "")}/approvals`, { headers });
    if (!response.ok) {
      throw new Error(`Failed to list approvals: ${response.status}`);
    }
    const body = await response.json();
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const approvalId = args.positionals[2];
  if (!approvalId) {
    throw new Error("approval id is required for approvals reply");
  }

  const allow = readBool(args.flags, "allow", false);
  const deny = readBool(args.flags, "deny", false);
  if (allow === deny) {
    throw new Error("use --allow or --deny");
  }

  const payload = { reply: allow ? "allow" : "deny" };
  const response = await fetch(`${openworkUrl.replace(/\/$/, "")}/approvals/${approvalId}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Failed to reply to approval: ${response.status}`);
  }
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
}

async function runStatus(args: ParsedArgs) {
  const openworkUrl = readFlag(args.flags, "openwork-url") ?? process.env.OPENWORK_URL ?? "";
  const opencodeUrl = readFlag(args.flags, "opencode-url") ?? process.env.OPENCODE_URL ?? "";
  const username = readFlag(args.flags, "opencode-username") ?? process.env.OPENCODE_SERVER_USERNAME;
  const password = readFlag(args.flags, "opencode-password") ?? process.env.OPENCODE_SERVER_PASSWORD;
  const outputJson = readBool(args.flags, "json", false);

  const status: Record<string, unknown> = {};

  if (openworkUrl) {
    try {
      await waitForHealthy(openworkUrl, 5000, 400);
      status.openwork = { ok: true, url: openworkUrl };
    } catch (error) {
      status.openwork = { ok: false, url: openworkUrl, error: String(error) };
    }
  }

  if (opencodeUrl) {
    try {
      const headers: Record<string, string> = {};
      if (username && password) {
        headers.Authorization = `Basic ${encodeBasicAuth(username, password)}`;
      }
      const client = createOpencodeClient({
        baseUrl: opencodeUrl,
        headers,
      });
      const health = await waitForOpencodeHealthy(client, 5000, 400);
      status.opencode = { ok: true, url: opencodeUrl, health };
    } catch (error) {
      status.opencode = { ok: false, url: opencodeUrl, error: String(error) };
    }
  }

  if (outputJson) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    if (status.openwork) {
      const openwork = status.openwork as { ok: boolean; url: string; error?: string };
      console.log(`OpenWork server: ${openwork.ok ? "ok" : "error"} (${openwork.url})`);
      if (openwork.error) console.log(`  ${openwork.error}`);
    }
    if (status.opencode) {
      const opencode = status.opencode as { ok: boolean; url: string; error?: string };
      console.log(`OpenCode server: ${opencode.ok ? "ok" : "error"} (${opencode.url})`);
      if (opencode.error) console.log(`  ${opencode.error}`);
    }
  }
}

async function runStart(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const checkOnly = readBool(args.flags, "check", false);
  const checkEvents = readBool(args.flags, "check-events", false);

  const workspace = readFlag(args.flags, "workspace") ?? process.env.OPENWORK_WORKSPACE ?? process.cwd();
  const resolvedWorkspace = await ensureWorkspace(workspace);

  const opencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.OPENWORK_OPENCODE_BIN ?? "opencode";
  const opencodeBindHost = readFlag(args.flags, "opencode-host") ?? process.env.OPENWORK_OPENCODE_BIND_HOST ?? "0.0.0.0";
  const opencodePort = await resolvePort(
    readNumber(args.flags, "opencode-port", undefined, "OPENWORK_OPENCODE_PORT"),
    "127.0.0.1",
  );
  const opencodeAuth = readBool(args.flags, "opencode-auth", true, "OPENWORK_OPENCODE_AUTH");
  const opencodeUsername = opencodeAuth
    ? readFlag(args.flags, "opencode-username") ?? process.env.OPENWORK_OPENCODE_USERNAME ?? DEFAULT_OPENCODE_USERNAME
    : undefined;
  const opencodePassword = opencodeAuth
    ? readFlag(args.flags, "opencode-password") ?? process.env.OPENWORK_OPENCODE_PASSWORD ?? randomUUID()
    : undefined;

  const openworkHost = readFlag(args.flags, "openwork-host") ?? process.env.OPENWORK_HOST ?? "0.0.0.0";
  const openworkPort = await resolvePort(
    readNumber(args.flags, "openwork-port", undefined, "OPENWORK_PORT"),
    "127.0.0.1",
    DEFAULT_OPENWORK_PORT,
  );
  const openworkToken = readFlag(args.flags, "openwork-token") ?? process.env.OPENWORK_TOKEN ?? randomUUID();
  const openworkHostToken = readFlag(args.flags, "openwork-host-token") ?? process.env.OPENWORK_HOST_TOKEN ?? randomUUID();
  const approvalMode =
    (readFlag(args.flags, "approval") as ApprovalMode | undefined) ??
    (process.env.OPENWORK_APPROVAL_MODE as ApprovalMode | undefined) ??
    "manual";
  const approvalTimeoutMs = readNumber(
    args.flags,
    "approval-timeout",
    DEFAULT_APPROVAL_TIMEOUT,
    "OPENWORK_APPROVAL_TIMEOUT_MS",
  ) as number;
  const readOnly = readBool(args.flags, "read-only", false, "OPENWORK_READONLY");
  const corsValue = readFlag(args.flags, "cors") ?? process.env.OPENWORK_CORS_ORIGINS ?? "*";
  const corsOrigins = parseList(corsValue);
  const connectHost = readFlag(args.flags, "connect-host");

  const openworkServerBin = await resolveOpenworkServerBin(
    readFlag(args.flags, "openwork-server-bin") ?? process.env.OPENWORK_SERVER_BIN,
  );
  const owpenbotBin = resolveBinPath(readFlag(args.flags, "owpenbot-bin") ?? process.env.OWPENBOT_BIN ?? "owpenbot");
  const owpenbotEnabled = readBool(args.flags, "owpenbot", true);

  const opencodeBaseUrl = `http://127.0.0.1:${opencodePort}`;
  const opencodeConnect = resolveConnectUrl(opencodePort, connectHost);
  const opencodeConnectUrl = opencodeConnect.connectUrl ?? opencodeBaseUrl;

  const openworkBaseUrl = `http://127.0.0.1:${openworkPort}`;
  const openworkConnect = resolveConnectUrl(openworkPort, connectHost);
  const openworkConnectUrl = openworkConnect.connectUrl ?? openworkBaseUrl;

  const children: ChildHandle[] = [];
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await Promise.all(children.map((handle) => stopChild(handle.child)));
  };

  const handleExit = (name: string, code: number | null, signal: NodeJS.Signals | null) => {
    if (shuttingDown) return;
    const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
    console.error(`[${name}] exited (${reason})`);
    void shutdown().then(() => process.exit(code ?? 1));
  };

  const handleSpawnError = (name: string, error: unknown) => {
    if (shuttingDown) return;
    console.error(`[${name}] failed to start: ${String(error)}`);
    void shutdown().then(() => process.exit(1));
  };

  const opencodeChild = await startOpencode({
    bin: opencodeBin,
    workspace: resolvedWorkspace,
    bindHost: opencodeBindHost,
    port: opencodePort,
    username: opencodeUsername,
    password: opencodePassword,
    corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
  });
  children.push({ name: "opencode", child: opencodeChild });
  opencodeChild.on("exit", (code, signal) => handleExit("opencode", code, signal));
  opencodeChild.on("error", (error) => handleSpawnError("opencode", error));

  const authHeaders: Record<string, string> = {};
  if (opencodeUsername && opencodePassword) {
    authHeaders.Authorization = `Basic ${encodeBasicAuth(opencodeUsername, opencodePassword)}`;
  }
  const opencodeClient = createOpencodeClient({
    baseUrl: opencodeBaseUrl,
    directory: resolvedWorkspace,
    headers: Object.keys(authHeaders).length ? authHeaders : undefined,
  });

  await waitForOpencodeHealthy(opencodeClient);

  const openworkChild = await startOpenworkServer({
    bin: openworkServerBin,
    host: openworkHost,
    port: openworkPort,
    workspace: resolvedWorkspace,
    token: openworkToken,
    hostToken: openworkHostToken,
    approvalMode: approvalMode === "auto" ? "auto" : "manual",
    approvalTimeoutMs,
    readOnly,
    corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
    opencodeBaseUrl: opencodeConnectUrl,
    opencodeDirectory: resolvedWorkspace,
    opencodeUsername,
    opencodePassword,
  });
  children.push({ name: "openwork-server", child: openworkChild });
  openworkChild.on("exit", (code, signal) => handleExit("openwork-server", code, signal));
  openworkChild.on("error", (error) => handleSpawnError("openwork-server", error));

  await waitForHealthy(openworkBaseUrl);

  if (owpenbotEnabled) {
    const owpenbotChild = await startOwpenbot({
      bin: owpenbotBin,
      workspace: resolvedWorkspace,
      opencodeUrl: opencodeConnectUrl,
      opencodeUsername,
      opencodePassword,
    });
    children.push({ name: "owpenbot", child: owpenbotChild });
    owpenbotChild.on("exit", (code, signal) => handleExit("owpenbot", code, signal));
    owpenbotChild.on("error", (error) => handleSpawnError("owpenbot", error));
  }

  const payload = {
    workspace: resolvedWorkspace,
    approval: {
      mode: approvalMode,
      timeoutMs: approvalTimeoutMs,
      readOnly,
    },
    opencode: {
      baseUrl: opencodeBaseUrl,
      connectUrl: opencodeConnectUrl,
      username: opencodeUsername,
      password: opencodePassword,
      bindHost: opencodeBindHost,
      port: opencodePort,
    },
    openwork: {
      baseUrl: openworkBaseUrl,
      connectUrl: openworkConnectUrl,
      host: openworkHost,
      port: openworkPort,
      token: openworkToken,
      hostToken: openworkHostToken,
    },
    owpenbot: {
      enabled: owpenbotEnabled,
    },
  };

  if (outputJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log("Openwrk running");
    console.log(`Workspace: ${payload.workspace}`);
    console.log(`OpenCode: ${payload.opencode.baseUrl}`);
    console.log(`OpenCode connect URL: ${payload.opencode.connectUrl}`);
    if (payload.opencode.username && payload.opencode.password) {
      console.log(`OpenCode auth: ${payload.opencode.username} / ${payload.opencode.password}`);
    }
    console.log(`OpenWork server: ${payload.openwork.baseUrl}`);
    console.log(`OpenWork connect URL: ${payload.openwork.connectUrl}`);
    console.log(`Client token: ${payload.openwork.token}`);
    console.log(`Host token: ${payload.openwork.hostToken}`);
  }

  if (checkOnly) {
    try {
      await runChecks({
        opencodeClient,
        openworkUrl: openworkBaseUrl,
        openworkToken,
        checkEvents,
      });
      if (!outputJson) {
        console.log("Checks: ok");
      }
    } catch (error) {
      console.error(`Checks failed: ${String(error)}`);
      await shutdown();
      process.exit(1);
    }
    await shutdown();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
  await new Promise(() => undefined);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (readBool(args.flags, "help", false) || args.flags.get("help") === true) {
    printHelp();
    return;
  }
  if (readBool(args.flags, "version", false) || args.flags.get("version") === true) {
    console.log(VERSION);
    return;
  }

  const command = args.positionals[0] ?? "start";
  if (command === "start") {
    await runStart(args);
    return;
  }
  if (command === "approvals") {
    await runApprovals(args);
    return;
  }
  if (command === "status") {
    await runStatus(args);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
