#!/usr/bin/env node
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile, realpath } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { homedir, hostname, networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { once } from "node:events";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type { TuiHandle } from "./tui/app.js";

type ApprovalMode = "manual" | "auto";

type SandboxMode = "none" | "auto" | "docker" | "container";

type ResolvedSandboxMode = "none" | "docker" | "container";

type LogFormat = "pretty" | "json";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

type LoggerChild = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
  debug: (message: string, attributes?: LogAttributes) => void;
  info: (message: string, attributes?: LogAttributes) => void;
  warn: (message: string, attributes?: LogAttributes) => void;
  error: (message: string, attributes?: LogAttributes) => void;
};

type Logger = {
  format: LogFormat;
  output: "stdout" | "silent";
  log: (level: LogLevel, message: string, attributes?: LogAttributes, component?: string) => void;
  debug: (message: string, attributes?: LogAttributes, component?: string) => void;
  info: (message: string, attributes?: LogAttributes, component?: string) => void;
  warn: (message: string, attributes?: LogAttributes, component?: string) => void;
  error: (message: string, attributes?: LogAttributes, component?: string) => void;
  child: (component: string, attributes?: LogAttributes) => LoggerChild;
};

type LogEvent = {
  time: number;
  level: LogLevel;
  message: string;
  component?: string;
  attributes?: LogAttributes;
};

type OpencodeHotReload = {
  enabled: boolean;
  debounceMs: number;
  cooldownMs: number;
};

type OpenCodeRouterHealthSnapshot = {
  ok: boolean;
  opencode: {
    url: string;
    healthy: boolean;
    version?: string;
  };
  channels: {
    telegram: boolean;
    whatsapp: boolean;
    slack: boolean;
  };
  config: {
    groupsEnabled: boolean;
  };
};

const FALLBACK_VERSION = "0.1.0";

declare const __OPENWORK_ORCHESTRATOR_VERSION__: string | undefined;
const DEFAULT_OPENWORK_PORT = 8787;
const DEFAULT_APPROVAL_TIMEOUT = 30000;
const DEFAULT_OPENCODE_USERNAME = "opencode";
const DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS = 700;
const DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS = 1500;

const SANDBOX_INTERNAL_OPENCODE_PORT = 4096;
const SANDBOX_INTERNAL_OPENWORK_PORT = DEFAULT_OPENWORK_PORT;
// OpenCodeRouter defaults its health server to 3005 when not overridden. In sandbox
// mode we keep the *internal* port stable and only vary the published host
// port to avoid collisions.
const SANDBOX_INTERNAL_OPENCODE_ROUTER_HEALTH_PORT = 3005;

const SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH = "/persist/.config/opencode";
const SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH = "/persist/.openwork-host-opencode-data";

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type ChildHandle = {
  name: string;
  child: ReturnType<typeof spawn>;
};

type VersionInfo = {
  version: string;
  sha256: string;
};

type SidecarName = "openwork-server" | "opencode-router" | "opencode";

type SidecarTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64"
  | "windows-x64"
  | "windows-arm64";

type VersionManifest = {
  dir: string;
  entries: Record<string, VersionInfo>;
};

type RemoteSidecarAsset = {
  asset?: string;
  url?: string;
  sha256?: string;
  size?: number;
};

type RemoteSidecarEntry = {
  version: string;
  targets: Record<string, RemoteSidecarAsset>;
};

type RemoteSidecarManifest = {
  version: string;
  generatedAt?: string;
  entries: Record<string, RemoteSidecarEntry>;
};

type SidecarConfig = {
  dir: string;
  baseUrl: string;
  manifestUrl: string;
  target: SidecarTarget | null;
};

type BinarySource = "bundled" | "external" | "downloaded";

type BinarySourcePreference = "auto" | "bundled" | "downloaded" | "external";

type ResolvedBinary = {
  bin: string;
  source: BinarySource;
  expectedVersion?: string;
};

type BinaryDiagnostics = {
  path: string;
  source: BinarySource;
  expectedVersion?: string;
  actualVersion?: string;
};

type SidecarDiagnostics = {
  dir: string;
  baseUrl: string;
  manifestUrl: string;
  target: SidecarTarget | null;
  source: BinarySourcePreference;
  opencodeSource: BinarySourcePreference;
  allowExternal: boolean;
};

type RouterWorkspaceType = "local" | "remote";

type RouterWorkspace = {
  id: string;
  name: string;
  path: string;
  workspaceType: RouterWorkspaceType;
  baseUrl?: string;
  directory?: string;
  createdAt: number;
  lastUsedAt?: number;
};

type RouterDaemonState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

type RouterOpencodeState = {
  pid: number;
  port: number;
  baseUrl: string;
  startedAt: number;
};

type RouterBinaryInfo = {
  path: string;
  source: BinarySource;
  expectedVersion?: string;
  actualVersion?: string;
};

type RouterBinaryState = {
  opencode?: RouterBinaryInfo;
};

type RouterSidecarState = {
  dir: string;
  baseUrl: string;
  manifestUrl: string;
  target: SidecarTarget | null;
  source: BinarySourcePreference;
  opencodeSource: BinarySourcePreference;
  allowExternal: boolean;
};

type RouterState = {
  version: number;
  daemon?: RouterDaemonState;
  opencode?: RouterOpencodeState;
  cliVersion?: string;
  sidecar?: RouterSidecarState;
  binaries?: RouterBinaryState;
  activeId: string;
  workspaces: RouterWorkspace[];
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

function readOpencodeHotReload(
  flags: Map<string, string | boolean>,
  defaults?: Partial<OpencodeHotReload>,
  env?: {
    enabled?: string;
    debounceMs?: string;
    cooldownMs?: string;
  },
): OpencodeHotReload {
  const enabled = readBool(flags, "opencode-hot-reload", defaults?.enabled ?? true, env?.enabled);
  const debounceRaw = readNumber(
    flags,
    "opencode-hot-reload-debounce-ms",
    defaults?.debounceMs ?? DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
    env?.debounceMs,
  );
  const cooldownRaw = readNumber(
    flags,
    "opencode-hot-reload-cooldown-ms",
    defaults?.cooldownMs ?? DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    env?.cooldownMs,
  );
  const debounceMs =
    typeof debounceRaw === "number" && Number.isFinite(debounceRaw) && debounceRaw >= 50
      ? Math.floor(debounceRaw)
      : DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS;
  const cooldownMs =
    typeof cooldownRaw === "number" && Number.isFinite(cooldownRaw) && cooldownRaw >= 100
      ? Math.floor(cooldownRaw)
      : DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS;
  return {
    enabled,
    debounceMs,
    cooldownMs,
  };
}

function readBinarySource(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: BinarySourcePreference,
  envKey?: string,
): BinarySourcePreference {
  const raw = readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "auto" || normalized === "bundled" || normalized === "downloaded" || normalized === "external") {
    return normalized as BinarySourcePreference;
  }
  throw new Error(`Invalid ${key} value: ${raw}. Use auto|bundled|downloaded|external.`);
}

function readLogFormat(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: LogFormat,
  envKey?: string,
): LogFormat {
  const raw = readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "json") return "json";
  if (normalized === "pretty" || normalized === "text" || normalized === "human") return "pretty";
  throw new Error(`Invalid ${key} value: ${raw}. Use pretty|json.`);
}

function readSandboxMode(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: SandboxMode,
  envKey?: string,
): SandboxMode {
  const raw = readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (
    normalized === "none" ||
    normalized === "auto" ||
    normalized === "docker" ||
    normalized === "container"
  ) {
    return normalized as SandboxMode;
  }
  throw new Error(`Invalid ${key} value: ${raw}. Use none|auto|docker|container.`);
}

type SandboxAllowedRoot = {
  path: string;
  allowReadWrite?: boolean;
  description?: string;
};

type SandboxMountAllowlist = {
  allowedRoots: SandboxAllowedRoot[];
  blockedPatterns?: string[];
};

type SandboxMount = {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
};

const DEFAULT_SANDBOX_BLOCKED_PATTERNS = [
  ".ssh",
  ".gnupg",
  ".gpg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
  "credentials",
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "private_key",
  ".secret",
];

let cachedSandboxAllowlist: SandboxMountAllowlist | null | undefined;
let cachedSandboxAllowlistError: string | null = null;

function resolveSandboxAllowlistPath(): string {
  const override = process.env.OPENWORK_SANDBOX_MOUNT_ALLOWLIST?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".config", "openwork", "sandbox-mount-allowlist.json");
}

function expandTildePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

async function isDir(input: string): Promise<boolean> {
  try {
    return (await stat(input)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveHostOpencodeGlobalConfigDir(): Promise<string | null> {
  const enabled = (process.env.OPENWORK_SANDBOX_MOUNT_OPENCODE_CONFIG ?? "1").trim() !== "0";
  if (!enabled) return null;

  const candidates: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) candidates.push(join(xdg, "opencode"));
  candidates.push(join(homedir(), ".config", "opencode"));
  if (process.platform === "darwin") {
    candidates.push(join(homedir(), "Library", "Application Support", "opencode"));
  }

  const files = ["opencode.jsonc", "opencode.json", "config.json", "AGENTS.md"];
  for (const candidate of Array.from(new Set(candidates.map((item) => resolve(expandTildePath(item)))))) {
    if (!(await isDir(candidate))) continue;
    for (const file of files) {
      try {
        await access(join(candidate, file));
        return candidate;
      } catch {
        // keep looking
      }
    }

    // Fall back to any non-empty config directory. Some setups keep
    // provider/auth material in files that are not part of the strict list above.
    try {
      const entries = await readdir(candidate);
      if (entries.length > 0) return candidate;
    } catch {
      // keep looking
    }
  }

  return null;
}

async function resolveHostOpencodeGlobalDataDir(): Promise<string | null> {
  const enabled = (process.env.OPENWORK_SANDBOX_MOUNT_OPENCODE_CONFIG ?? "1").trim() !== "0";
  if (!enabled) return null;

  const candidates: string[] = [];
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  if (xdgData) candidates.push(join(xdgData, "opencode"));
  candidates.push(join(homedir(), ".local", "share", "opencode"));
  if (process.platform === "darwin") {
    candidates.push(join(homedir(), "Library", "Application Support", "opencode"));
  }

  const files = ["auth.json", "mcp-auth.json"];
  for (const candidate of Array.from(new Set(candidates.map((item) => resolve(expandTildePath(item)))))) {
    if (!(await isDir(candidate))) continue;
    for (const file of files) {
      try {
        await access(join(candidate, file));
        return candidate;
      } catch {
        // keep looking
      }
    }
  }

  return null;
}

async function realpathOrNull(input: string): Promise<string | null> {
  try {
    return await realpath(input);
  } catch {
    return null;
  }
}

function matchesBlockedPattern(real: string, patterns: string[]): string | null {
  const parts = real.split(sep);
  for (const pattern of patterns) {
    for (const part of parts) {
      if (part === pattern || part.includes(pattern)) return pattern;
    }
    if (real.includes(pattern)) return pattern;
  }
  return null;
}

async function findAllowedRoot(real: string, roots: SandboxAllowedRoot[]): Promise<SandboxAllowedRoot | null> {
  for (const root of roots) {
    const expanded = resolve(expandTildePath(root.path));
    const realRoot = await realpathOrNull(expanded);
    if (!realRoot) continue;
    const rel = relative(realRoot, real);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return root;
    }
  }
  return null;
}

async function loadSandboxAllowlist(): Promise<SandboxMountAllowlist | null> {
  if (cachedSandboxAllowlist !== undefined) return cachedSandboxAllowlist;
  if (cachedSandboxAllowlistError) return null;

  const path = resolveSandboxAllowlistPath();
  try {
    if (!(await fileExists(path))) {
      cachedSandboxAllowlistError = `Mount allowlist not found at ${path}`;
      cachedSandboxAllowlist = null;
      return null;
    }
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as SandboxMountAllowlist;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.allowedRoots)) {
      throw new Error("allowedRoots must be an array");
    }
    const blocked = Array.isArray(parsed.blockedPatterns) ? parsed.blockedPatterns : [];
    parsed.blockedPatterns = [...new Set([...DEFAULT_SANDBOX_BLOCKED_PATTERNS, ...blocked])];
    cachedSandboxAllowlist = parsed;
    return parsed;
  } catch (error) {
    cachedSandboxAllowlistError = error instanceof Error ? error.message : String(error);
    cachedSandboxAllowlist = null;
    return null;
  }
}

function isValidSandboxContainerSubPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes("..")) return false;
  if (trimmed.startsWith("/")) return false;
  if (trimmed.includes("\\")) return false;
  const parts = trimmed.split("/").filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((part) => part === "." || part === "..")) return false;
  return true;
}

function parseSandboxMountSpec(spec: string): {
  hostPath: string;
  containerSubPath: string;
  requestedReadWrite: boolean;
} {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("Empty --sandbox-mount entry");
  }

  let requestedReadWrite = true;
  let base = trimmed;
  if (trimmed.endsWith(":ro")) {
    requestedReadWrite = false;
    base = trimmed.slice(0, -3);
  } else if (trimmed.endsWith(":rw")) {
    requestedReadWrite = true;
    base = trimmed.slice(0, -3);
  }

  const idx = base.indexOf(":");
  if (idx <= 0 || idx >= base.length - 1) {
    throw new Error(`Invalid --sandbox-mount value: ${spec}. Use hostPath:subpath[:ro|rw].`);
  }

  const hostPath = base.slice(0, idx).trim();
  const containerSubPath = base.slice(idx + 1).trim();
  if (!hostPath) throw new Error(`Invalid --sandbox-mount value: ${spec}. Host path is empty.`);
  if (!containerSubPath) throw new Error(`Invalid --sandbox-mount value: ${spec}. Container subpath is empty.`);

  return { hostPath, containerSubPath, requestedReadWrite };
}

function generateSandboxAllowlistTemplate(): string {
  const template: SandboxMountAllowlist = {
    allowedRoots: [
      {
        path: "~/projects",
        allowReadWrite: true,
        description: "Development projects",
      },
      {
        path: "~/Documents",
        allowReadWrite: false,
        description: "Documents (read-only)",
      },
    ],
    blockedPatterns: ["password", "secret", "token"],
  };
  return JSON.stringify(template, null, 2);
}

async function resolveSandboxExtraMounts(
  specs: string[],
  sandboxMode: ResolvedSandboxMode,
): Promise<SandboxMount[]> {
  if (!specs.length) return [];
  const allowlistPath = resolveSandboxAllowlistPath();
  const allowlist = await loadSandboxAllowlist();
  if (!allowlist) {
    const template = generateSandboxAllowlistTemplate();
    throw new Error(
      `Additional sandbox mounts are blocked. Create ${allowlistPath} to enable.\n\nExample:\n${template}`,
    );
  }
  const blocked = allowlist.blockedPatterns ?? DEFAULT_SANDBOX_BLOCKED_PATTERNS;
  const roots = allowlist.allowedRoots;

  const mounts: SandboxMount[] = [];
  for (const spec of specs) {
    const parsed = parseSandboxMountSpec(spec);
    if (!isValidSandboxContainerSubPath(parsed.containerSubPath)) {
      throw new Error(
        `Invalid sandbox container subpath: "${parsed.containerSubPath}". Use a relative path without "/" prefix or "..".`,
      );
    }
    const expanded = resolve(expandTildePath(parsed.hostPath));
    const real = await realpathOrNull(expanded);
    if (!real) {
      throw new Error(`Sandbox mount host path does not exist: ${parsed.hostPath} (expanded: ${expanded})`);
    }
    const blockedMatch = matchesBlockedPattern(real, blocked);
    if (blockedMatch) {
      throw new Error(`Sandbox mount rejected (blocked pattern "${blockedMatch}"): ${real}`);
    }
    const allowedRoot = await findAllowedRoot(real, roots);
    if (!allowedRoot) {
      const allowedList = roots.map((root) => resolve(expandTildePath(root.path))).join(", ");
      throw new Error(`Sandbox mount rejected: ${real} is not under any allowed root. Allowed: ${allowedList}`);
    }
    const allowReadWrite = allowedRoot.allowReadWrite === true;
    const readonly = parsed.requestedReadWrite ? !allowReadWrite : true;
    if (sandboxMode === "container") {
      const info = await stat(real);
      if (!info.isDirectory()) {
        throw new Error(`Apple container sandbox mounts must be directories: ${real}`);
      }
    }
    mounts.push({
      hostPath: real,
      containerPath: `/workspace/extra/${parsed.containerSubPath}`,
      readonly,
    });
  }
  return mounts;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveCliVersion(): Promise<string> {
  if (
    typeof __OPENWORK_ORCHESTRATOR_VERSION__ === "string" &&
    __OPENWORK_ORCHESTRATOR_VERSION__.trim()
  ) {
    return __OPENWORK_ORCHESTRATOR_VERSION__.trim();
  }
  const candidates = [
    join(dirname(process.execPath), "..", "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      try {
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        // ignore
      }
    }
  }

  return FALLBACK_VERSION;
}

async function readPackageField(field: string): Promise<string | undefined> {
  const candidates = [
    join(dirname(process.execPath), "..", "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      try {
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const value = parsed[field];
        if (typeof value === "string" && value.trim()) return value.trim();
      } catch {
        // ignore
      }
    }
  }

  return undefined;
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

  const configPathJsonc = join(resolved, "opencode.jsonc");
  const configPathJson = join(resolved, "opencode.json");
  const hasJsonc = await fileExists(configPathJsonc);
  const hasJson = await fileExists(configPathJson);

  if (!hasJsonc && !hasJson) {
    const payload = JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2);
    await writeFile(configPathJsonc, `${payload}\n`, "utf8");
  }

  return resolved;
}

async function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
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
    const server = createNetServer();
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

function isCompiledBunBinary(): boolean {
  try {
    const entryPath = fileURLToPath(import.meta.url);
    return entryPath.startsWith("/$bunfs/");
  } catch {
    return false;
  }
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
  logger: Logger,
  pid?: number,
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
      if (logger.output === "stdout" && logger.format === "json" && looksLikeOtelLogLine(line)) {
        process.stdout.write(`${line}\n`);
        continue;
      }
      const severity: LogLevel = level === "stderr" ? "error" : "info";
      logger.log(severity, line, { stream: level, pid }, label);
    }
  });
  stream.on("end", () => {
    if (!buffer.trim()) return;
    if (logger.output === "stdout" && logger.format === "json" && looksLikeOtelLogLine(buffer)) {
      process.stdout.write(`${buffer}\n`);
      return;
    }
    const severity: LogLevel = level === "stderr" ? "error" : "info";
    logger.log(severity, buffer, { stream: level, pid }, label);
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

async function readVersionManifest(): Promise<VersionManifest | null> {
  const candidates = [dirname(process.execPath), dirname(fileURLToPath(import.meta.url))];
  for (const dir of candidates) {
    const manifestPath = join(dir, "versions.json");
    if (await fileExists(manifestPath)) {
      try {
        const payload = await readFile(manifestPath, "utf8");
        const entries = JSON.parse(payload) as Record<string, VersionInfo>;
        return { dir, entries };
      } catch {
        return { dir, entries: {} };
      }
    }
  }
  return null;
}

const remoteManifestCache = new Map<string, Promise<RemoteSidecarManifest | null>>();

let latestOpencodeVersionTask: Promise<string | undefined> | null = null;

function resolveSidecarTarget(): SidecarTarget | null {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "darwin-arm64";
    if (process.arch === "x64") return "darwin-x64";
    return null;
  }
  if (process.platform === "linux") {
    if (process.arch === "arm64") return "linux-arm64";
    if (process.arch === "x64") return "linux-x64";
    return null;
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "windows-arm64";
    if (process.arch === "x64") return "windows-x64";
    return null;
  }
  return null;
}

function resolveSandboxSidecarTarget(mode: ResolvedSandboxMode): SidecarTarget | null {
  if (mode === "none") return resolveSidecarTarget();
  // Sandbox runs inside Linux (docker / container).
  if (process.arch === "arm64") return "linux-arm64";
  if (process.arch === "x64") return "linux-x64";
  return null;
}

function resolveSidecarConfigForTarget(
  flags: Map<string, string | boolean>,
  cliVersion: string,
  targetOverride: SidecarTarget | null,
): SidecarConfig {
  const baseUrl = resolveSidecarBaseUrl(flags, cliVersion);
  return {
    dir: resolveSidecarDir(flags),
    baseUrl,
    manifestUrl: resolveSidecarManifestUrl(flags, baseUrl),
    target: targetOverride,
  };
}

function spawnProcess(command: string, args: string[], options: SpawnOptions = {}) {
  if (process.platform === "win32") {
    return spawn(command, args, { ...options, windowsHide: true });
  }
  return spawn(command, args, options);
}

async function probeCommand(command: string, args: string[], timeoutMs = 2500): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawnProcess(command, args, { stdio: ["ignore", "ignore", "ignore"] });
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function resolveSandboxMode(mode: SandboxMode): Promise<ResolvedSandboxMode> {
  if (mode === "none") return "none";
  if (mode === "docker") return "docker";
  if (mode === "container") return "container";

  // auto
  if (process.platform === "darwin" && process.arch === "arm64") {
    const containerOk = await probeCommand("container", ["--version"]);
    if (containerOk) return "container";
  }

  const dockerOk = await probeCommand("docker", ["version"]);
  if (dockerOk) return "docker";

  const containerOk = await probeCommand("container", ["--version"]);
  if (containerOk) return "container";
  return "none";
}

function shQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolveSidecarDir(flags: Map<string, string | boolean>): string {
  const override = readFlag(flags, "sidecar-dir") ?? process.env.OPENWORK_SIDECAR_DIR;
  if (override && override.trim()) return resolve(override.trim());
  return join(resolveRouterDataDir(flags), "sidecars");
}

function resolveSidecarBaseUrl(flags: Map<string, string | boolean>, cliVersion: string): string {
  const override = readFlag(flags, "sidecar-base-url") ?? process.env.OPENWORK_SIDECAR_BASE_URL;
  if (override && override.trim()) return override.trim();
  return `https://github.com/different-ai/openwork/releases/download/openwork-orchestrator-v${cliVersion}`;
}

function resolveSidecarManifestUrl(flags: Map<string, string | boolean>, baseUrl: string): string {
  const override = readFlag(flags, "sidecar-manifest") ?? process.env.OPENWORK_SIDECAR_MANIFEST_URL;
  if (override && override.trim()) return override.trim();
  return `${baseUrl.replace(/\/$/, "")}/openwork-orchestrator-sidecars.json`;
}

function resolveSidecarConfig(flags: Map<string, string | boolean>, cliVersion: string): SidecarConfig {
  const baseUrl = resolveSidecarBaseUrl(flags, cliVersion);
  return {
    dir: resolveSidecarDir(flags),
    baseUrl,
    manifestUrl: resolveSidecarManifestUrl(flags, baseUrl),
    target: resolveSidecarTarget(),
  };
}

async function fetchRemoteManifest(url: string): Promise<RemoteSidecarManifest | null> {
  const cached = remoteManifestCache.get(url);
  if (cached) return cached;
  const task = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return null;
      return (await response.json()) as RemoteSidecarManifest;
    } catch {
      return null;
    }
  })();
  remoteManifestCache.set(url, task);
  return task;
}

async function resolveLatestOpencodeVersion(): Promise<string | undefined> {
  if (latestOpencodeVersionTask) return latestOpencodeVersionTask;
  latestOpencodeVersionTask = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("https://api.github.com/repos/anomalyco/opencode/releases/latest", {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const data = (await response.json()) as { tag_name?: unknown };
      const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : "";
      if (!tag) return undefined;
      const normalized = tag.startsWith("v") ? tag.slice(1) : tag;
      return normalized || undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  })();
  return latestOpencodeVersionTask;
}

function resolveAssetUrl(baseUrl: string, asset?: string, url?: string): string | null {
  if (url && url.trim()) return url.trim();
  if (asset && asset.trim()) return `${baseUrl.replace(/\/$/, "")}/${asset.trim()}`;
  return null;
}

function resolveAssetName(asset?: string, url?: string): string | null {
  if (asset && asset.trim()) return asset.trim();
  if (url && url.trim()) {
    try {
      return basename(new URL(url).pathname);
    } catch {
      const parts = url.split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : null;
    }
  }
  return null;
}

async function downloadToPath(url: string, dest: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url} (HTTP ${response.status})`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  const tmpPath = `${dest}.tmp-${randomUUID()}`;
  await writeFile(tmpPath, buffer);
  await rename(tmpPath, dest);
}

async function ensureExecutable(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o755);
  } catch {
    // ignore
  }
}

async function downloadSidecarBinary(options: {
  name: SidecarName;
  sidecar: SidecarConfig;
}): Promise<ResolvedBinary | null> {
  if (!options.sidecar.target) return null;
  const manifest = await fetchRemoteManifest(options.sidecar.manifestUrl);
  if (!manifest) return null;
  const entry = manifest.entries[options.name];
  if (!entry) return null;
  const targetInfo = entry.targets[options.sidecar.target];
  if (!targetInfo) return null;

  const assetName = resolveAssetName(targetInfo.asset, targetInfo.url);
  const assetUrl = resolveAssetUrl(options.sidecar.baseUrl, targetInfo.asset, targetInfo.url);
  if (!assetName || !assetUrl) return null;

  const targetDir = join(options.sidecar.dir, entry.version, options.sidecar.target);
  const targetPath = join(targetDir, assetName);
  if (await fileExists(targetPath)) {
    if (targetInfo.sha256) {
      try {
        await verifyBinary(targetPath, { version: entry.version, sha256: targetInfo.sha256 });
        await ensureExecutable(targetPath);
        return { bin: targetPath, source: "downloaded", expectedVersion: entry.version };
      } catch {
        await rm(targetPath, { force: true });
      }
    } else {
      await ensureExecutable(targetPath);
      return { bin: targetPath, source: "downloaded", expectedVersion: entry.version };
    }
  }

  await downloadToPath(assetUrl, targetPath);
  if (targetInfo.sha256) {
    await verifyBinary(targetPath, { version: entry.version, sha256: targetInfo.sha256 });
  }
  await ensureExecutable(targetPath);
  return { bin: targetPath, source: "downloaded", expectedVersion: entry.version };
}

function resolveOpencodeAsset(target: SidecarTarget): string | null {
  const assets: Record<SidecarTarget, string> = {
    "darwin-arm64": "opencode-darwin-arm64.zip",
    "darwin-x64": "opencode-darwin-x64-baseline.zip",
    "linux-x64": "opencode-linux-x64-baseline.tar.gz",
    "linux-arm64": "opencode-linux-arm64.tar.gz",
    "windows-x64": "opencode-windows-x64-baseline.zip",
    "windows-arm64": "opencode-windows-arm64.zip",
  };
  return assets[target] ?? null;
}

async function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  const child = spawnProcess(command, args, { cwd, stdio: "inherit" });
  const result = await Promise.race([
    once(child, "exit").then(([code]) => ({ type: "exit" as const, code })),
    once(child, "error").then(([error]) => ({ type: "error" as const, error })),
  ]);
  if (result.type === "error") {
    throw new Error(`Command failed: ${command} ${args.join(" ")}: ${String(result.error)}`);
  }
  if (result.code !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function resolveOpencodeDownload(sidecar: SidecarConfig, expectedVersion?: string): Promise<string | null> {
  if (!expectedVersion) return null;
  if (!sidecar.target) return null;

  const assetOverride = process.env.OPENWORK_OPENCODE_ASSET ?? process.env.OPENCODE_ASSET;
  const asset = assetOverride?.trim() || resolveOpencodeAsset(sidecar.target);
  if (!asset) return null;

  const version = expectedVersion.startsWith("v") ? expectedVersion.slice(1) : expectedVersion;
  const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/${asset}`;
  const targetDir = join(sidecar.dir, "opencode", version, sidecar.target);
  const targetPath = join(targetDir, process.platform === "win32" ? "opencode.exe" : "opencode");

  const hostTarget = resolveSidecarTarget();
  const runnableOnHost = hostTarget !== null && sidecar.target === hostTarget;

  if (await fileExists(targetPath)) {
    if (!runnableOnHost) {
      await ensureExecutable(targetPath);
      return targetPath;
    }
    const actual = await readCliVersion(targetPath);
    if (actual === version) {
      await ensureExecutable(targetPath);
      return targetPath;
    }
  }

  await mkdir(targetDir, { recursive: true });
  const stamp = Date.now();
  const archivePath = join(tmpdir(), `openwork-orchestrator-opencode-${stamp}-${asset}`);
  const extractDir = await mkdtemp(join(tmpdir(), "openwork-orchestrator-opencode-"));

  try {
    await downloadToPath(url, archivePath);
    if (process.platform === "win32") {
      const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;
      const psScript = [
        "$ErrorActionPreference = 'Stop'",
        `Expand-Archive -Path ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`,
      ].join("; ");
      await runCommand("powershell", ["-NoProfile", "-Command", psScript]);
    } else if (asset.endsWith(".zip")) {
      await runCommand("unzip", ["-q", archivePath, "-d", extractDir]);
    } else if (asset.endsWith(".tar.gz")) {
      await runCommand("tar", ["-xzf", archivePath, "-C", extractDir]);
    } else {
      throw new Error(`Unsupported opencode asset type: ${asset}`);
    }

    const entries = await readdir(extractDir, { withFileTypes: true });
    const queue = entries.map((entry) => join(extractDir, entry.name));
    let candidate: string | null = null;
    while (queue.length) {
      const current = queue.shift();
      if (!current) break;
      const statInfo = await stat(current);
      if (statInfo.isDirectory()) {
        const nested = await readdir(current, { withFileTypes: true });
        queue.push(...nested.map((entry) => join(current, entry.name)));
        continue;
      }
      const base = basename(current);
      if (base === "opencode" || base === "opencode.exe") {
        candidate = current;
        break;
      }
    }

    if (!candidate) {
      throw new Error("OpenCode binary not found after extraction.");
    }

    await copyFile(candidate, targetPath);
    await ensureExecutable(targetPath);
    return targetPath;
  } finally {
    await rm(extractDir, { recursive: true, force: true });
    await rm(archivePath, { force: true });
  }
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function verifyBinary(path: string, expected?: VersionInfo): Promise<void> {
  if (!expected) return;
  const hash = await sha256File(path);
  if (hash !== expected.sha256) {
    throw new Error(`Integrity check failed for ${path}`);
  }
}

async function resolveBundledBinary(manifest: VersionManifest | null, name: string): Promise<string | null> {
  if (!manifest) return null;
  const candidates = [join(manifest.dir, name)];
  if (process.platform === "win32") {
    candidates.push(join(manifest.dir, `${name}.exe`));
  }
  for (const bundled of candidates) {
    if (!(await isExecutable(bundled))) continue;
    // Desktop bundles may be code-signed after we generate versions.json, which
    // mutates the on-disk bytes and makes a precomputed sha256 unstable.
    // Linux bundles remain byte-stable, so keep integrity verification there.
    if (process.platform === "linux") {
      await verifyBinary(bundled, manifest.entries[name]);
    }
    return bundled;
  }
  return null;
}

async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const payload = await readFile(path, "utf8");
    const parsed = JSON.parse(payload) as { version?: string };
    if (typeof parsed.version === "string") return parsed.version;
    return undefined;
  } catch {
    return undefined;
  }
}

async function resolveOpenCodeRouterRepoDir(): Promise<string | null> {
  const envPath = process.env.OPENCODE_ROUTER_DIR?.trim();
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const repoRoot = resolve(root, "..", "..");
  const candidates = [envPath, resolve(repoRoot, "packages", "opencode-router")].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const pkgPath = join(candidate, "package.json");
    if (await fileExists(pkgPath)) return candidate;
  }

  return null;
}

async function resolveExpectedVersion(
  manifest: VersionManifest | null,
  name: SidecarName,
): Promise<string | undefined> {
  const manifestVersion = manifest?.entries[name]?.version;
  if (manifestVersion) return manifestVersion;

  try {
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    if (name === "openwork-server") {
      const localPath = join(root, "..", "server", "package.json");
      const localVersion = await readPackageVersion(localPath);
      if (localVersion) return localVersion;
    }
    if (name === "opencode-router") {
      const repoDir = await resolveOpenCodeRouterRepoDir();
      const localPath = repoDir ? join(repoDir, "package.json") : join(root, "..", "opencode-router", "package.json");
      const localVersion = await readPackageVersion(localPath);
      if (localVersion) return localVersion;
    }
    if (name === "opencode") {
      const envVersion = process.env.OPENCODE_VERSION?.trim();
      if (envVersion && envVersion.toLowerCase() !== "latest") {
        return envVersion.startsWith("v") ? envVersion.slice(1) : envVersion;
      }
      const pkgVersion = await readPackageField("opencodeVersion");
      if (pkgVersion && pkgVersion.toLowerCase() !== "latest") {
        return pkgVersion.startsWith("v") ? pkgVersion.slice(1) : pkgVersion;
      }
      const latest = await resolveLatestOpencodeVersion();
      if (latest) return latest;
    }
  } catch {
    // ignore
  }

  const require = createRequire(import.meta.url);
  if (name === "openwork-server") {
    try {
      const pkgPath = require.resolve("openwork-server/package.json");
      const version = await readPackageVersion(pkgPath);
      if (version) return version;
    } catch {
      // ignore
    }
  }
  if (name === "opencode-router") {
    try {
      const pkgPath = require.resolve("opencode-router/package.json");
      const version = await readPackageVersion(pkgPath);
      if (version) return version;
    } catch {
      // ignore
    }
  }

  return undefined;
}

function parseVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/);
  return match?.[0];
}

async function readCliVersion(bin: string, timeoutMs = 4000): Promise<string | undefined> {
  const resolved = resolveBinCommand(bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, "--version"], {
    // Avoid picking up a local bunfig.toml preload from the caller's cwd.
    // (Notably, packages/orchestrator/bunfig.toml preloads @opentui/solid/preload which
    // breaks running bun-compiled binaries like opencodeRouter during version checks.)
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  const result = await Promise.race([
    once(child, "close").then(() => "close"),
    once(child, "error").then(() => "error"),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, "timeout")),
  ]);

  if (result === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    return undefined;
  }

  if (result === "error") {
    return undefined;
  }

  return parseVersion(output.trim());
}

async function captureCommandOutput(
  bin: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  const resolved = resolveBinCommand(bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: tmpdir(),
    stdio: ["ignore", "pipe", "pipe"],
    env: options?.env ?? process.env,
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  type CaptureResult =
    | "timeout"
    | "error"
    | {
        type: "close";
        code: number | null;
        signal: NodeJS.Signals | null;
      };

  const timeoutMs = options?.timeoutMs ?? 30_000;
  const result = await Promise.race<CaptureResult>([
    once(child, "close").then(([code, signal]) => ({
      type: "close" as const,
      code: (code ?? null) as number | null,
      signal: (signal ?? null) as NodeJS.Signals | null,
    })),
    once(child, "error").then(() => "error" as const),
    new Promise<CaptureResult>((resolve) => setTimeout(resolve, timeoutMs, "timeout")),
  ]);

  if (result === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error("Command timed out");
  }

  if (result === "error") {
    throw new Error("Command failed to run");
  }

  const code = result.code;
  if (code !== 0) {
    const suffix = output.trim() ? `\n${output.trim()}` : "";
    throw new Error(`Command failed: ${bin} ${args.join(" ")}${suffix}`);
  }

  return output.trim();
}

function assertVersionMatch(
  name: string,
  expected: string | undefined,
  actual: string | undefined,
  context: string,
): void {
  if (!expected) return;
  if (!actual) {
    throw new Error(`Unable to determine ${name} version from ${context}. Expected ${expected}.`);
  }
  if (expected !== actual) {
    throw new Error(`${name} version mismatch: expected ${expected}, got ${actual}.`);
  }
}

function resolveBinPath(bin: string): string {
  if (bin.includes("/") || bin.startsWith(".")) {
    return resolve(process.cwd(), bin);
  }
  return bin;
}

function isPathLikeBinary(bin: string): boolean {
  return bin.includes("/") || bin.startsWith(".");
}

async function assertSandboxBinaryFile(name: string, bin: string): Promise<void> {
  const lower = bin.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".ts")) {
    throw new Error(
      `Sandbox mode requires ${name} to be a native binary (got ${bin}). Use downloaded sidecars or pass a Linux binary path.`,
    );
  }
  if (!isPathLikeBinary(bin)) {
    throw new Error(
      `Sandbox mode requires ${name} to be a file path (got ${bin}). Use downloaded sidecars or pass --${name}-bin with a Linux binary path.`,
    );
  }
  const resolved = resolve(process.cwd(), bin);
  if (!(await fileExists(resolved))) {
    throw new Error(`Sandbox mode could not find ${name} binary at ${resolved}.`);
  }
}

async function resolveOpenworkServerBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("openwork-server-bin requires --allow-external");
  }
  if (options.explicit && options.source !== "auto" && options.source !== "external") {
    throw new Error("openwork-server-bin requires --sidecar-source external or auto");
  }

  const expectedVersion = await resolveExpectedVersion(options.manifest, "openwork-server");
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External openwork-server requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if ((resolved.includes("/") || resolved.startsWith(".")) && !(await fileExists(resolved))) {
        throw new Error(`openwork-server-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }

    const require = createRequire(import.meta.url);
    try {
      const pkgPath = require.resolve("openwork-server/package.json");
      const pkgDir = dirname(pkgPath);
      const binaryPath = join(pkgDir, "dist", "bin", "openwork-server");
      if (await isExecutable(binaryPath)) {
        return { bin: binaryPath, source: "external", expectedVersion };
      }
      const cliPath = join(pkgDir, "dist", "cli.js");
      if (await isExecutable(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    } catch {
      // ignore
    }

    return { bin: "openwork-server", source: "external", expectedVersion };
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "openwork-server");
    if (!bundled) {
      throw new Error(
        "Bundled openwork-server binary missing. Build with pnpm --filter openwork-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "downloaded") {
    const downloaded = await downloadSidecarBinary({ name: "openwork-server", sidecar: options.sidecar });
    if (!downloaded) {
      throw new Error("openwork-server download failed. Check sidecar manifest or base URL.");
    }
    return downloaded;
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "openwork-server");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  const downloaded = await downloadSidecarBinary({ name: "openwork-server", sidecar: options.sidecar });
  if (downloaded) return downloaded;

  if (!options.allowExternal) {
    throw new Error(
      "Bundled openwork-server binary missing and download failed. Use --allow-external or --sidecar-source external.",
    );
  }

  return resolveExternal();
}

async function resolveOpencodeBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("opencode-bin requires --allow-external");
  }
  if (options.explicit && options.source !== "auto" && options.source !== "external") {
    throw new Error("opencode-bin requires --opencode-source external or auto");
  }

  const expectedVersion = await resolveExpectedVersion(options.manifest, "opencode");
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External opencode requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if ((resolved.includes("/") || resolved.startsWith(".")) && !(await fileExists(resolved))) {
        throw new Error(`opencode-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }
    return { bin: "opencode", source: "external", expectedVersion };
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "opencode");
    if (!bundled) {
      throw new Error(
        "Bundled opencode binary missing. Build with pnpm --filter openwork-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "downloaded") {
    const downloaded = await downloadSidecarBinary({ name: "opencode", sidecar: options.sidecar });
    if (downloaded) return downloaded;
    const opencodeDownloaded = await resolveOpencodeDownload(options.sidecar, expectedVersion);
    if (opencodeDownloaded) {
      return { bin: opencodeDownloaded, source: "downloaded", expectedVersion };
    }
    throw new Error(
      "opencode download failed. Check sidecar manifest/network access, or set OPENCODE_VERSION to pin a version.",
    );
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "opencode");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  const downloaded = await downloadSidecarBinary({ name: "opencode", sidecar: options.sidecar });
  if (downloaded) return downloaded;

  const opencodeDownloaded = await resolveOpencodeDownload(options.sidecar, expectedVersion);
  if (opencodeDownloaded) {
    return { bin: opencodeDownloaded, source: "downloaded", expectedVersion };
  }

  if (!options.allowExternal) {
    throw new Error(
      "Bundled opencode binary missing and download failed. Use --allow-external or --opencode-source external.",
    );
  }

  return resolveExternal();
}

async function resolveOpenCodeRouterBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("opencode-router-bin requires --allow-external");
  }
  if (options.explicit && options.source !== "auto" && options.source !== "external") {
    throw new Error("opencode-router-bin requires --sidecar-source external or auto");
  }

  const expectedVersion = await resolveExpectedVersion(options.manifest, "opencode-router");
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External opencodeRouter requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if ((resolved.includes("/") || resolved.startsWith(".")) && !(await fileExists(resolved))) {
        throw new Error(`opencode-router-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }

    const repoDir = await resolveOpenCodeRouterRepoDir();
    if (repoDir) {
      const binPath = join(repoDir, "dist", "bin", "opencode-router");
      if (await isExecutable(binPath)) {
        return { bin: binPath, source: "external", expectedVersion };
      }
      const cliPath = join(repoDir, "dist", "cli.js");
      if (await fileExists(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    }

    const require = createRequire(import.meta.url);
    try {
      const pkgPath = require.resolve("opencode-router/package.json");
      const pkgDir = dirname(pkgPath);
      const binaryPath = join(pkgDir, "dist", "bin", "opencode-router");
      if (await isExecutable(binaryPath)) {
        return { bin: binaryPath, source: "external", expectedVersion };
      }
      const cliPath = join(pkgDir, "dist", "cli.js");
      if (await isExecutable(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    } catch {
      // ignore
    }

    throw new Error(
      "opencode-router binary not found. Install the opencode-router dependency or pass --opencode-router-bin with --allow-external.",
    );
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "opencode-router");
    if (!bundled) {
      throw new Error(
        "Bundled opencodeRouter binary missing. Build with pnpm --filter openwork-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "downloaded") {
    const downloaded = await downloadSidecarBinary({ name: "opencode-router", sidecar: options.sidecar });
    if (!downloaded) {
      throw new Error("opencodeRouter download failed. Check sidecar manifest or base URL.");
    }
    return downloaded;
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "opencode-router");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  const downloaded = await downloadSidecarBinary({ name: "opencode-router", sidecar: options.sidecar });
  if (downloaded) return downloaded;

  if (!options.allowExternal) {
    throw new Error(
      "Bundled opencodeRouter binary missing and download failed. Use --allow-external or --sidecar-source external.",
    );
  }

  return resolveExternal();
}

function resolveRouterDataDir(flags: Map<string, string | boolean>): string {
  const override = readFlag(flags, "data-dir") ?? process.env.OPENWORK_DATA_DIR;
  if (override && override.trim()) {
    return resolve(override.trim());
  }
  return join(homedir(), ".openwork", "openwork-orchestrator");
}

function routerStatePath(dataDir: string): string {
  return join(dataDir, "openwork-orchestrator-state.json");
}

function nowMs(): number {
  return Date.now();
}

async function loadRouterState(path: string): Promise<RouterState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as RouterState;
    if (!parsed.workspaces) parsed.workspaces = [];
    if (!parsed.activeId) parsed.activeId = "";
    if (!parsed.version) parsed.version = 1;
    return parsed;
  } catch {
    return {
      version: 1,
      daemon: undefined,
      opencode: undefined,
      cliVersion: undefined,
      sidecar: undefined,
      binaries: undefined,
      activeId: "",
      workspaces: [],
    };
  }
}

async function saveRouterState(path: string, state: RouterState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = JSON.stringify(state, null, 2);
  await writeFile(path, `${payload}\n`, "utf8");
}

function normalizeWorkspacePath(input: string): string {
  return resolve(input).replace(/[\\/]+$/, "");
}

function workspaceIdForLocal(path: string): string {
  return `ws-${createHash("sha1").update(path).digest("hex").slice(0, 12)}`;
}

function workspaceIdForRemote(baseUrl: string, directory?: string | null): string {
  const key = directory ? `${baseUrl}::${directory}` : baseUrl;
  return `ws-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

function opencodeRouterSendToolSource(): string {
  return [
    'import { tool } from "@opencode-ai/plugin"',
    "",
    "const redactTarget = (value) => {",
    "  const text = String(value || '').trim()",
    "  if (!text) return ''",
    "  if (text.length <= 6) return 'hidden'",
    "  return `${text.slice(0, 2)}…${text.slice(-2)}`",
    "}",
    "",
    "const buildGuidance = (result) => {",
    "  const sent = Number(result?.sent || 0)",
    "  const attempted = Number(result?.attempted || 0)",
    "  const reason = String(result?.reason || '')",
    "  const failures = Array.isArray(result?.failures) ? result.failures : []",
    "",
    "  if (sent > 0 && failures.length === 0) return 'Delivered successfully.'",
    "  if (sent > 0) return 'Delivered to at least one conversation, but some targets failed.'",
    "",
    "  const chatNotFound = failures.some((item) => /chat not found/i.test(String(item?.error || '')))",
    "  if (chatNotFound) {",
    "    return 'Delivery failed because the recipient has not started a chat with the bot yet. Ask them to send /start, then retry.'",
    "  }",
    "",
    "  if (/No bound conversations/i.test(reason)) {",
    "    return 'No linked conversation found for this workspace yet. Ask the recipient to message the bot first, then retry.'",
    "  }",
    "",
    "  if (attempted === 0) return 'No eligible delivery target found.'",
    "  return 'Delivery failed. Retry after confirming the recipient and bot linkage.'",
    "}",
    "",
    "export default tool({",
    '  description: "Send a message via opencodeRouter (Telegram/Slack) to a peer or directory bindings.",',
    "  args: {",
    '    text: tool.schema.string().describe("Message text to send"),',
    '    channel: tool.schema.enum(["telegram", "slack"]).optional().describe("Channel to send on (default: telegram)"),',
    '    identityId: tool.schema.string().optional().describe("OpenCodeRouter identity id (default: all identities)"),',
    '    directory: tool.schema.string().optional().describe("Directory to target for fan-out (default: current session directory)"),',
    '    peerId: tool.schema.string().optional().describe("Direct destination peer id (chat/thread id)"),',
    '    autoBind: tool.schema.boolean().optional().describe("When direct sending, bind peerId to directory if provided"),',
    "  },",
    "  async execute(args, context) {",
    '    const rawPort = (process.env.OPENCODE_ROUTER_HEALTH_PORT || "3005").trim()',
    "    const port = Number(rawPort)",
    "    if (!Number.isFinite(port) || port <= 0) {",
    '      throw new Error(`Invalid OPENCODE_ROUTER_HEALTH_PORT: ${rawPort}`)',
    "    }",
    '    const channel = (args.channel || "telegram").trim()',
    '    if (channel !== "telegram" && channel !== "slack") {',
    '      throw new Error("channel must be telegram or slack")',
    "    }",
    '    const text = String(args.text || "")',
    '    if (!text.trim()) throw new Error("text is required")',
    '    const directory = (args.directory || context.directory || "").trim()',
    '    const peerId = String(args.peerId || "").trim()',
    '    if (!directory && !peerId) throw new Error("Either directory or peerId is required")',
    "    const payload = {",
    "      channel,",
    "      text,",
    "      ...(args.identityId ? { identityId: String(args.identityId) } : {}),",
    "      ...(directory ? { directory } : {}),",
    "      ...(peerId ? { peerId } : {}),",
    "      ...(args.autoBind === true ? { autoBind: true } : {}),",
    "    }",
    "    const response = await fetch(`http://127.0.0.1:${port}/send`, {",
    "      method: \"POST\",",
    '      headers: { "Content-Type": "application/json" },',
    "      body: JSON.stringify(payload),",
    "    })",
    "    const body = await response.text()",
    "    let json = null",
    "    try {",
    "      json = JSON.parse(body)",
    "    } catch {",
    "      json = null",
    "    }",
    "    if (!response.ok) {",
    '      throw new Error(`opencodeRouter /send failed (${response.status}): ${body}`)',
    "    }",
    "",
    "    const sent = Number(json?.sent || 0)",
    "    const attempted = Number(json?.attempted || 0)",
    "    const reason = typeof json?.reason === 'string' ? json.reason : ''",
    "    const failuresRaw = Array.isArray(json?.failures) ? json.failures : []",
    "    const failures = failuresRaw.map((item) => ({",
    "      identityId: String(item?.identityId || ''),",
    "      error: String(item?.error || 'delivery failed'),",
    "      ...(item?.peerId ? { target: redactTarget(item.peerId) } : {}),",
    "    }))",
    "",
    "    const result = {",
    "      ok: true,",
    "      channel,",
    "      sent,",
    "      attempted,",
    "      guidance: buildGuidance({ sent, attempted, reason, failures }),",
    "      ...(reason ? { reason } : {}),",
    "      ...(failures.length ? { failures } : {}),",
    "    }",
    "    return JSON.stringify(result, null, 2)",
    "  },",
    "})",
    "",
  ].join("\n");
}

function opencodeRouterStatusToolSource(): string {
  return [
    'import { tool } from "@opencode-ai/plugin"',
    "",
    "const redactTarget = (value) => {",
    "  const text = String(value || '').trim()",
    "  if (!text) return ''",
    "  if (text.length <= 6) return 'hidden'",
    "  return `${text.slice(0, 2)}…${text.slice(-2)}`",
    "}",
    "",
    "const isNumericTelegramPeerId = (value) => /^-?\\d+$/.test(String(value || '').trim())",
    "",
    "export default tool({",
    '  description: "Check opencodeRouter messaging readiness (health, identities, bindings).",',
    "  args: {",
    '    channel: tool.schema.enum(["telegram", "slack"]).optional().describe("Channel to inspect (default: telegram)"),',
    '    identityId: tool.schema.string().optional().describe("Identity id to scope checks"),',
    '    directory: tool.schema.string().optional().describe("Directory to inspect bindings for (default: current session directory)"),',
    '    peerId: tool.schema.string().optional().describe("Peer id to inspect bindings for"),',
    '    includeBindings: tool.schema.boolean().optional().describe("Include binding details (default: false)"),',
    "  },",
    "  async execute(args, context) {",
    '    const rawPort = (process.env.OPENCODE_ROUTER_HEALTH_PORT || "3005").trim()',
    "    const port = Number(rawPort)",
    "    if (!Number.isFinite(port) || port <= 0) {",
    '      throw new Error(`Invalid OPENCODE_ROUTER_HEALTH_PORT: ${rawPort}`)',
    "    }",
    '    const channel = (args.channel || "telegram").trim()',
    '    if (channel !== "telegram" && channel !== "slack") {',
    '      throw new Error("channel must be telegram or slack")',
    "    }",
    '    const identityId = String(args.identityId || "").trim()',
    '    const directory = (args.directory || context.directory || "").trim()',
    '    const peerId = String(args.peerId || "").trim()',
    "    const targetValid = channel !== 'telegram' || !peerId || isNumericTelegramPeerId(peerId)",
    '    const includeBindings = args.includeBindings === true',
    "",
    "    const fetchJson = async (path) => {",
    "      const response = await fetch(`http://127.0.0.1:${port}${path}`)",
    "      const body = await response.text()",
    "      let json = null",
    "      try {",
    "        json = JSON.parse(body)",
    "      } catch {",
    "        json = null",
    "      }",
    "      if (!response.ok) {",
    "        return { ok: false, status: response.status, json, error: typeof json?.error === \"string\" ? json.error : body }",
    "      }",
    "      return { ok: true, status: response.status, json }",
    "    }",
    "",
    "    const health = await fetchJson('/health')",
    "    const identities = await fetchJson(`/identities/${channel}`)",
    "    let bindings = null",
    "    if (includeBindings) {",
    "      const search = new URLSearchParams()",
    "      search.set('channel', channel)",
    "      if (identityId) search.set('identityId', identityId)",
    "      bindings = await fetchJson(`/bindings?${search.toString()}`)",
    "    }",
    "",
    "    const identityItems = Array.isArray(identities?.json?.items) ? identities.json.items : []",
    "    const scopedIdentityItems = identityId",
    "      ? identityItems.filter((item) => String(item?.id || '').trim() === identityId)",
    "      : identityItems",
    "    const runningItems = scopedIdentityItems.filter((item) => item && item.enabled === true && item.running === true)",
    "    const enabledItems = scopedIdentityItems.filter((item) => item && item.enabled === true)",
    "",
    "    const bindingItems = Array.isArray(bindings?.json?.items) ? bindings.json.items : []",
    "    const filteredBindings = bindingItems.filter((item) => {",
    "      if (!item || typeof item !== 'object') return false",
    "      if (directory && String(item.directory || '').trim() !== directory) return false",
    "      if (peerId && String(item.peerId || '').trim() !== peerId) return false",
    "      return true",
    "    })",
    "    const publicBindings = filteredBindings.map((item) => ({",
    "      channel: String(item.channel || channel),",
    "      identityId: String(item.identityId || ''),",
    "      directory: String(item.directory || ''),",
    "      ...(item?.peerId ? { target: redactTarget(item.peerId) } : {}),",
    "      updatedAt: item?.updatedAt,",
    "    }))",
    "",
    "    let ready = false",
    "    let guidance = ''",
    "    let nextAction = ''",
    "    if (!health.ok) {",
    "      guidance = 'OpenCode Router health endpoint is unavailable'",
    "      nextAction = 'check_router_health'",
    "    } else if (!identities.ok) {",
    "      guidance = `Identity lookup failed for ${channel}`",
    "      nextAction = 'check_identity_config'",
    "    } else if (runningItems.length === 0) {",
    "      guidance = `No running ${channel} identity`",
    "      nextAction = 'start_identity'",
    "    } else if (!targetValid) {",
    "      guidance = 'Telegram direct targets must be numeric chat IDs. Prefer linked conversations over asking users for raw IDs.'",
    "      nextAction = 'use_linked_conversation'",
    "    } else if (peerId) {",
    "      ready = true",
    "      guidance = 'Ready for direct send'",
    "      nextAction = 'send_direct'",
    "    } else if (directory) {",
    "      ready = filteredBindings.length > 0",
    "      guidance = ready",
    "        ? 'Ready for directory fan-out send'",
    "        : channel === 'telegram'",
    "          ? 'No linked Telegram conversations yet. Ask the recipient to message your bot (for example /start), then retry.'",
    "          : 'No linked conversations found for this directory yet'",
    "      nextAction = ready ? 'send_directory' : channel === 'telegram' ? 'wait_for_recipient_start' : 'link_conversation'",
    "    } else {",
    "      ready = true",
    "      guidance = 'Ready. Provide a message target (peer or directory).'",
    "      nextAction = 'choose_target'",
    "    }",
    "",
    "    const result = {",
    "      ok: health.ok && identities.ok && (!bindings || bindings.ok),",
    "      ready,",
    "      guidance,",
    "      nextAction,",
    "      channel,",
    "      ...(identityId ? { identityId } : {}),",
    "      ...(directory ? { directory } : {}),",
    "      ...(peerId ? { targetProvided: true } : {}),",
    "      ...(peerId ? { targetValid } : {}),",
    "      health: {",
    "        ok: health.ok,",
    "        status: health.status,",
    "        error: health.ok ? undefined : health.error,",
    "        snapshot: health.ok ? health.json : undefined,",
    "      },",
    "      identities: {",
    "        ok: identities.ok,",
    "        status: identities.status,",
    "        error: identities.ok ? undefined : identities.error,",
    "        configured: scopedIdentityItems.length,",
    "        enabled: enabledItems.length,",
    "        running: runningItems.length,",
    "        items: scopedIdentityItems,",
    "      },",
    "      ...(includeBindings",
    "        ? {",
    "            bindings: {",
    "              ok: Boolean(bindings?.ok),",
    "              status: bindings?.status,",
    "              error: bindings?.ok ? undefined : bindings?.error,",
    "              count: filteredBindings.length,",
    "              items: publicBindings,",
    "            },",
    "          }",
    "        : {}),",
    "    }",
    "    return JSON.stringify(result, null, 2)",
    "  },",
    "})",
    "",
  ].join("\n");
}

async function ensureOpencodeManagedTools(configDir: string): Promise<void> {
  const toolsDir = join(configDir, "tools");
  await mkdir(toolsDir, { recursive: true });
  const writeManagedTool = async (name: string, source: string) => {
    const toolPath = join(toolsDir, name);
    const content = `${source}\n`;
    try {
      const existing = await readFile(toolPath, "utf8");
      if (existing === content) return;
    } catch {
      // ignore
    }
    await writeFile(toolPath, content, "utf8");
  };

  await writeManagedTool("opencode_router_send.ts", opencodeRouterSendToolSource());
  await writeManagedTool("opencode_router_status.ts", opencodeRouterStatusToolSource());
}

function findWorkspace(state: RouterState, input: string): RouterWorkspace | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const direct = state.workspaces.find((entry) => entry.id === trimmed || entry.name === trimmed);
  if (direct) return direct;
  const normalized = normalizeWorkspacePath(trimmed);
  return state.workspaces.find((entry) => entry.path && normalizeWorkspacePath(entry.path) === normalized);
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveSelfCommand(): { command: string; prefixArgs: string[] } {
  const arg1 = process.argv[1];
  if (!arg1) return { command: process.argv[0], prefixArgs: [] };
  if (arg1.endsWith(".js") || arg1.endsWith(".ts")) {
    return { command: process.argv[0], prefixArgs: [arg1] };
  }
  return { command: process.argv[0], prefixArgs: [] };
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

async function fetchOpenCodeRouterHealth(baseUrl: string): Promise<OpenCodeRouterHealthSnapshot> {
  return (await fetchJson(`${baseUrl.replace(/\/$/, "")}/health`)) as OpenCodeRouterHealthSnapshot;
}

async function fetchOpenCodeRouterHealthViaOpenwork(openworkUrl: string, token: string): Promise<OpenCodeRouterHealthSnapshot> {
  const url = `${openworkUrl.replace(/\/$/, "")}/opencode-router/health`;
  return (await fetchJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  })) as OpenCodeRouterHealthSnapshot;
}

async function waitForOpenCodeRouterHealthy(baseUrl: string, timeoutMs = 10_000, pollMs = 500) {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`);
      if (response.ok) {
        return (await response.json()) as OpenCodeRouterHealthSnapshot;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for opencodeRouter health");
}

async function waitForOpenCodeRouterHealthyViaOpenwork(
  openworkUrl: string,
  token: string,
  timeoutMs = 10_000,
  pollMs = 500,
): Promise<OpenCodeRouterHealthSnapshot> {
  const url = `${openworkUrl.replace(/\/$/, "")}/opencode-router/health`;
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      if (response.ok) {
        return (await response.json()) as OpenCodeRouterHealthSnapshot;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for opencodeRouter health via openwork-server");
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

/**
 * In sandbox mode the released openwork-server binary may not have our latest
 * token/proxy changes.  Instead of relying on the OpenCode SDK client (which
 * sends Bearer auth that the proxy may not understand yet), we do a simple
 * HTTP fetch through the proxy path.  The server's /opencode/* proxy already
 * forwards to the internal opencode port; we just need to check that it
 * returns a 2xx from /opencode/health (or falls through to opencode's own
 * /health endpoint).
 *
 * We try multiple path patterns because:
 * - `/opencode/health` — most common OpenCode health endpoint proxied by the
 *   server's catch-all /opencode/* route.
 * - `/health` on the openwork-server itself — already verified by the caller,
 *   but serves as a fallback signal.
 */
async function waitForHealthyViaProxy(
  proxyBaseUrl: string,
  token: string,
  timeoutMs = 10_000,
  pollMs = 250,
): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  while (Date.now() - start < timeoutMs) {
    try {
      // Try the proxied opencode health endpoint.
      const res = await fetch(`${proxyBaseUrl}/health`, { headers, signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      // Some older server versions may return 401/403 on the proxy but that
      // still proves the server is up and proxying.  Accept any non-5xx as
      // "alive" — the real auth validation happens in verifyOpenworkServer.
      if (res.status < 500) return;
      lastError = `Proxy returned ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for OpenCode health via proxy");
}

function printHelp(): void {
  const message = [
    "openwork",
    "",
    "Usage:",
    "  openwork start [--workspace <path>] [options]",
    "  openwork serve [--workspace <path>] [options]",
    "  openwork daemon [run|start|stop|status] [options]",
    "  openwork workspace <action> [options]",
    "  openwork instance dispose <id> [options]",
    "  openwork approvals list --openwork-url <url> --host-token <token>",
    "  openwork approvals reply <id> --allow|--deny --openwork-url <url> --host-token <token>",
    "  openwork status [--openwork-url <url>] [--opencode-url <url>]",
    "",
    "Commands:",
    "  start                   Start OpenCode + OpenWork server + OpenCodeRouter",
    "  serve                   Start services and stream logs (no TUI)",
    "  daemon                  Run orchestrator router daemon (multi-workspace)",
    "  workspace               Manage workspaces (add/list/switch/path)",
    "  instance                Manage workspace instances (dispose)",
    "  approvals list           List pending approval requests",
    "  approvals reply <id>     Approve or deny a request",
    "  status                  Check OpenCode/OpenWork health",
    "",
    "Options:",
    "  --workspace <path>        Workspace directory (default: cwd)",
    "  --data-dir <path>         Data dir for orchestrator router state",
    "  --daemon-host <host>      Host for orchestrator router daemon (default: 127.0.0.1)",
    "  --daemon-port <port>      Port for orchestrator router daemon (default: random)",
    "  --opencode-bin <path>     Path to opencode binary (requires --allow-external)",
    "  --opencode-host <host>    Bind host for opencode serve (default: 0.0.0.0)",
    "  --opencode-port <port>    Port for opencode serve (default: random)",
    "  --opencode-workdir <p>    Workdir for router-managed opencode serve",
    "  --opencode-auth           Enable OpenCode basic auth (default: true)",
    "  --no-opencode-auth        Disable OpenCode basic auth",
    "  --opencode-hot-reload     Enable OpenCode hot reload (default: true)",
    "  --opencode-hot-reload-debounce-ms <ms>  Debounce window for hot reload triggers (default: 700)",
    "  --opencode-hot-reload-cooldown-ms <ms>  Minimum interval between hot reloads (default: 1500)",
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
    "  --openwork-server-bin <p> Path to openwork-server binary (requires --allow-external)",
    "  --opencode-router-bin <path>     Path to opencodeRouter binary (requires --allow-external)",
    "  --opencode-router-health-port <p> Health server port for opencodeRouter (default: random)",
    "  --no-opencode-router             Disable opencodeRouter sidecar",
    "  --opencode-router-required       Exit if opencodeRouter stops",
    "  --allow-external          Allow external sidecar binaries (dev only, required for custom bins)",
    "  --sidecar-dir <path>      Cache directory for downloaded sidecars",
    "  --sidecar-base-url <url>  Base URL for sidecar downloads",
    "  --sidecar-manifest <url>  Override sidecar manifest URL",
    "  --sidecar-source <mode>   auto | bundled | downloaded | external",
    "  --opencode-source <mode>  auto | bundled | downloaded | external",
    "  --check                   Run health checks then exit",
    "  --check-events            Verify SSE events during check",
    "  --tui                     Force interactive dashboard (TTY only)",
    "  --no-tui                  Disable interactive dashboard",
    "  --detach                  Detach after start and keep services running",
    "  --sandbox <mode>          none | auto | docker | container (default: none)",
    "  --sandbox-image <ref>     Container image for sandbox mode",
    "  --sandbox-persist-dir <p> Persist dir mounted into sandbox (default: per-workspace)",
    "  --sandbox-mount <specs>   Extra mounts (validated): hostPath:subpath[:ro|rw] (requires allowlist)",
    "  --json                    Output JSON when applicable",
    "  --verbose                 Print additional diagnostics",
    "  --log-format <format>     Log output format: pretty | json",
    "  --color                   Force ANSI color output",
    "  --no-color                Disable ANSI color output",
    "  --run-id <id>             Correlation id for logs (default: random UUID)",
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
  configDir?: string;
  hotReload: OpencodeHotReload;
  bindHost: string;
  port: number;
  username?: string;
  password?: string;
  corsOrigins: string[];
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
  opencodeRouterHealthPort?: number;
}) {
  const args = ["serve", "--hostname", options.bindHost, "--port", String(options.port)];
  for (const origin of options.corsOrigins) {
    args.push("--cors", origin);
  }

  const child = spawnProcess(options.bin, args, {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENCODE_CLIENT: "openwork-orchestrator",
      OPENWORK: "1",
      OPENWORK_RUN_ID: options.runId,
      OPENWORK_LOG_FORMAT: options.logFormat,
      OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
        {
          "service.name": "opencode",
          "service.instance.id": options.runId,
        },
        process.env.OTEL_RESOURCE_ATTRIBUTES,
      ),
      ...(options.username ? { OPENCODE_SERVER_USERNAME: options.username } : {}),
      ...(options.password ? { OPENCODE_SERVER_PASSWORD: options.password } : {}),
      ...(options.configDir ? { OPENCODE_CONFIG_DIR: options.configDir } : {}),
      OPENCODE_HOT_RELOAD: options.hotReload.enabled ? "1" : "0",
      OPENCODE_HOT_RELOAD_DEBOUNCE_MS: String(options.hotReload.debounceMs),
      OPENCODE_HOT_RELOAD_COOLDOWN_MS: String(options.hotReload.cooldownMs),
      ...(options.opencodeRouterHealthPort ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.opencodeRouterHealthPort) } : {}),
    },
  });

  prefixStream(child.stdout, "opencode", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "opencode", "stderr", options.logger, child.pid ?? undefined);

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
  opencodeRouterHealthPort?: number;
  opencodeRouterDataDir?: string;
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
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
  if (options.logFormat) {
    args.push("--log-format", options.logFormat);
  }

  const resolved = resolveBinCommand(options.bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENWORK_TOKEN: options.token,
      OPENWORK_HOST_TOKEN: options.hostToken,
      OPENWORK_RUN_ID: options.runId,
      OPENWORK_LOG_FORMAT: options.logFormat,
      OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
        {
          "service.name": "openwork-server",
          "service.instance.id": options.runId,
        },
        process.env.OTEL_RESOURCE_ATTRIBUTES,
      ),
      ...(options.opencodeRouterHealthPort ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.opencodeRouterHealthPort) } : {}),
      ...(options.opencodeRouterDataDir ? { OPENCODE_ROUTER_DATA_DIR: options.opencodeRouterDataDir } : {}),
      ...(options.opencodeBaseUrl ? { OPENWORK_OPENCODE_BASE_URL: options.opencodeBaseUrl } : {}),
      ...(options.opencodeDirectory ? { OPENWORK_OPENCODE_DIRECTORY: options.opencodeDirectory } : {}),
      ...(options.opencodeUsername ? { OPENWORK_OPENCODE_USERNAME: options.opencodeUsername } : {}),
      ...(options.opencodePassword ? { OPENWORK_OPENCODE_PASSWORD: options.opencodePassword } : {}),
    },
  });

  prefixStream(child.stdout, "openwork-server", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "openwork-server", "stderr", options.logger, child.pid ?? undefined);

  return child;
}

async function startOpenCodeRouter(options: {
  bin: string;
  workspace: string;
  opencodeUrl?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  opencodeRouterHealthPort?: number;
  opencodeRouterDataDir?: string;
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
}) {
  const args = ["serve", options.workspace];
  if (options.opencodeUrl) {
    const supports = await opencodeRouterSupportsOpencodeUrl(options.bin);
    if (supports) {
      args.push("--opencode-url", options.opencodeUrl);
    }
  }

  const resolved = resolveBinCommand(options.bin);
  const child = spawnProcess(resolved.command, [...resolved.prefixArgs, ...args], {
    cwd: options.workspace,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      OPENWORK_RUN_ID: options.runId,
      OPENWORK_LOG_FORMAT: options.logFormat,
      OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
        {
          "service.name": "opencode-router",
          "service.instance.id": options.runId,
        },
        process.env.OTEL_RESOURCE_ATTRIBUTES,
      ),
      ...(options.opencodeUrl ? { OPENCODE_URL: options.opencodeUrl } : {}),
      OPENCODE_DIRECTORY: options.workspace,
      ...(options.opencodeRouterHealthPort ? { OPENCODE_ROUTER_HEALTH_PORT: String(options.opencodeRouterHealthPort) } : {}),
      ...(options.opencodeRouterDataDir ? { OPENCODE_ROUTER_DATA_DIR: options.opencodeRouterDataDir } : {}),
      ...(options.opencodeUsername ? { OPENCODE_SERVER_USERNAME: options.opencodeUsername } : {}),
      ...(options.opencodePassword ? { OPENCODE_SERVER_PASSWORD: options.opencodePassword } : {}),
    },
  });

  prefixStream(child.stdout, "opencode-router", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "opencode-router", "stderr", options.logger, child.pid ?? undefined);

  return child;
}

async function opencodeRouterSupportsOpencodeUrl(bin: string): Promise<boolean> {
  const resolved = resolveBinCommand(bin);
  return new Promise((resolve) => {
    const child = spawnProcess(resolved.command, [...resolved.prefixArgs, "--help"], {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(output.includes("--opencode-url"));
    }, 1500);

    const onChunk = (chunk: unknown) => {
      output += String(chunk ?? "");
    };

    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);

    child.on("exit", () => {
      clearTimeout(timeout);
      resolve(output.includes("--opencode-url"));
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function stopDockerContainer(name: string): Promise<void> {
  if (!name.trim()) return;
  await new Promise<void>((resolve) => {
    const child = spawnProcess("docker", ["stop", name], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

async function stopAppleContainer(name: string): Promise<void> {
  if (!name.trim()) return;
  await new Promise<void>((resolve) => {
    const child = spawnProcess("container", ["stop", name], { stdio: ["ignore", "ignore", "ignore"] });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

async function runQuiet(command: string, args: string[], timeoutMs = 60_000): Promise<void> {
  const child = spawnProcess(command, args, { stdio: ["ignore", "ignore", "ignore"] });
  type QuietResult =
    | { type: "exit"; code: number | null }
    | { type: "error"; error: unknown }
    | { type: "timeout" };

  const result = await Promise.race<QuietResult>([
    once(child, "exit").then(([code]) => ({ type: "exit" as const, code: (code ?? null) as number | null })),
    once(child, "error").then(([error]) => ({ type: "error" as const, error })),
    new Promise<QuietResult>((resolve) => setTimeout(resolve, timeoutMs, { type: "timeout" as const })),
  ]);
  if (result.type === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(`Command timed out: ${command} ${args.join(" ")}`);
  }
  if (result.type === "error") {
    throw new Error(`Command failed: ${command} ${args.join(" ")}: ${String(result.error)}`);
  }
  if (result.code !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function ensureAppleContainerSystemReady(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Apple container backend is only supported on macOS");
  }
  if (process.arch !== "arm64") {
    throw new Error("Apple container backend requires Apple silicon (arm64)");
  }
  if (!(await probeCommand("container", ["--version"]))) {
    throw new Error("Apple container CLI not found. Install https://github.com/apple/container");
  }
  // Best-effort: start the background system service.
  try {
    await runQuiet("container", ["system", "start"], 90_000);
  } catch {
    // Ignore; older versions may not require an explicit start.
  }
}

async function stageSandboxRuntime(options: {
  persistDir: string;
  containerName: string;
  sidecars: { opencode: string; openworkServer: string; opencodeRouter?: string | null };
  detach: boolean;
}): Promise<{
  baseDir: string;
  rootInContainer: string;
  entrypointHostPath: string;
  cleanup: () => Promise<void>;
}> {
  const baseDir = join(options.persistDir, "openwork-orchestrator-sandbox", options.containerName);
  await mkdir(baseDir, { recursive: true });

  const sidecarsDir = join(baseDir, "sidecars");
  await mkdir(sidecarsDir, { recursive: true });
  const entrypointHostPath = join(baseDir, "entrypoint.sh");

  const stagedOpencode = join(sidecarsDir, "opencode");
  const stagedOpenwork = join(sidecarsDir, "openwork-server");
  await copyFile(options.sidecars.opencode, stagedOpencode);
  await copyFile(options.sidecars.openworkServer, stagedOpenwork);
  await ensureExecutable(stagedOpencode);
  await ensureExecutable(stagedOpenwork);

  if (options.sidecars.opencodeRouter) {
    const stagedOpenCodeRouter = join(sidecarsDir, "opencode-router");
    await copyFile(options.sidecars.opencodeRouter, stagedOpenCodeRouter);
    await ensureExecutable(stagedOpenCodeRouter);
  }

  const rootInContainer = `/persist/openwork-orchestrator-sandbox/${options.containerName}`;
  const cleanup = async () => {
    if (options.detach) return;
    try {
      await rm(baseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { baseDir, rootInContainer, entrypointHostPath, cleanup };
}

async function writeSandboxEntrypoint(options: {
  entrypointHostPath: string;
  rootInContainer: string;
  opencodeConfigDirInContainer: string;
  backend: "docker" | "container";
  opencode: {
    corsOrigins: string[];
    username?: string;
    password?: string;
    hotReload: OpencodeHotReload;
  };
  openwork: {
    token: string;
    hostToken: string;
    approvalMode: ApprovalMode;
    approvalTimeoutMs: number;
    readOnly: boolean;
    corsOrigins: string[];
    opencodeUsername?: string;
    opencodePassword?: string;
    logFormat: LogFormat;
    opencodeRouterEnabled: boolean;
  };
  runId: string;
  logFormat: LogFormat;
}): Promise<void> {
  const opencodeBin = `${options.rootInContainer}/sidecars/opencode`;
  const openworkBin = `${options.rootInContainer}/sidecars/openwork-server`;
  const opencodeRouterBin = `${options.rootInContainer}/sidecars/opencode-router`;
  const workspaceDir = "/workspace";
  const opencodeConfigDir = options.opencodeConfigDirInContainer;
  const hostOpencodeConfigDir = SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH;
  const hostOpencodeDataDir = SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH;

  const opencodeCors = options.opencode.corsOrigins
    .map((origin) => `--cors ${shQuote(origin)}`)
    .join(" ");

  const openworkCors = options.openwork.corsOrigins.length
    ? `--cors ${shQuote(options.openwork.corsOrigins.join(","))}`
    : "";

  const opencodeAuthEnv = [
    options.opencode.username ? `export OPENCODE_SERVER_USERNAME=${shQuote(options.opencode.username)}` : "",
    options.opencode.password ? `export OPENCODE_SERVER_PASSWORD=${shQuote(options.opencode.password)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const openworkAuthArgs = [
    options.openwork.opencodeUsername ? `--opencode-username ${shQuote(options.openwork.opencodeUsername)}` : "",
    options.openwork.opencodePassword ? `--opencode-password ${shQuote(options.openwork.opencodePassword)}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const opencodeRouterEnv = options.openwork.opencodeRouterEnabled
    ? `export OPENCODE_ROUTER_HEALTH_PORT=${shQuote(String(SANDBOX_INTERNAL_OPENCODE_ROUTER_HEALTH_PORT))}`
    : "";

  const script = [
    "set -eu",
    `export HOME=${shQuote("/persist")}`,
    "export XDG_CONFIG_HOME=\"$HOME/.config\"",
    "export XDG_CACHE_HOME=\"$HOME/.cache\"",
    "export XDG_DATA_HOME=\"$HOME/.local/share\"",
    "export XDG_STATE_HOME=\"$HOME/.local/state\"",
    "mkdir -p \"$XDG_CONFIG_HOME\" \"$XDG_CACHE_HOME\" \"$XDG_DATA_HOME\" \"$XDG_STATE_HOME\"",
    // Do not `cd` into the mounted workspace: bun-compiled sidecars read bunfig.toml
    // from cwd, and user workspaces may include preloads that break startup.
    `cd ${shQuote("/persist")}`,
    `export OPENCODE_DIRECTORY=${shQuote(workspaceDir)}`,
    `export OPENCODE_CONFIG_DIR=${shQuote(opencodeConfigDir)}`,
    `mkdir -p ${shQuote(opencodeConfigDir)}`,
    `if [ -d ${shQuote(hostOpencodeConfigDir)} ]; then cp -R ${shQuote(`${hostOpencodeConfigDir}/.`)} ${shQuote(opencodeConfigDir)} 2>/dev/null || true; fi`,
    "mkdir -p \"$XDG_DATA_HOME/opencode\"",
    `if [ -d ${shQuote(hostOpencodeDataDir)} ]; then cp ${shQuote(`${hostOpencodeDataDir}/auth.json`)} \"$XDG_DATA_HOME/opencode/auth.json\" 2>/dev/null || true; cp ${shQuote(`${hostOpencodeDataDir}/mcp-auth.json`)} \"$XDG_DATA_HOME/opencode/mcp-auth.json\" 2>/dev/null || true; fi`,
    `export OPENCODE_URL=${shQuote(`http://127.0.0.1:${SANDBOX_INTERNAL_OPENCODE_PORT}`)}`,
    `export OPENCODE_CLIENT=openwork-orchestrator`,
    `export OPENCODE_HOT_RELOAD=${shQuote(options.opencode.hotReload.enabled ? "1" : "0")}`,
    `export OPENCODE_HOT_RELOAD_DEBOUNCE_MS=${shQuote(String(options.opencode.hotReload.debounceMs))}`,
    `export OPENCODE_HOT_RELOAD_COOLDOWN_MS=${shQuote(String(options.opencode.hotReload.cooldownMs))}`,
    `export OPENWORK=1`,
    `export OPENWORK_RUN_ID=${shQuote(options.runId)}`,
    `export OPENWORK_LOG_FORMAT=${shQuote(options.logFormat)}`,
    `export OPENWORK_SANDBOX_ENABLED=1`,
    `export OPENWORK_SANDBOX_BACKEND=${shQuote(options.backend)}`,
    opencodeRouterEnv,
    opencodeAuthEnv,
    "opencode_pid=\"\"",
    "opencodeRouter_pid=\"\"",
    "cleanup() {",
    "  if [ -n \"$opencodeRouter_pid\" ]; then kill \"$opencodeRouter_pid\" 2>/dev/null || true; fi",
    "  if [ -n \"$opencode_pid\" ]; then kill \"$opencode_pid\" 2>/dev/null || true; fi",
    "}",
    "trap cleanup INT TERM",
    `${shQuote(opencodeBin)} serve --hostname 127.0.0.1 --port ${shQuote(String(SANDBOX_INTERNAL_OPENCODE_PORT))} ${opencodeCors} &`,
    "opencode_pid=$!",
    options.openwork.opencodeRouterEnabled ? `${shQuote(opencodeRouterBin)} serve ${shQuote(workspaceDir)} &` : "",
    options.openwork.opencodeRouterEnabled ? "opencodeRouter_pid=$!" : "",
    `exec ${shQuote(openworkBin)} --host 0.0.0.0 --port ${shQuote(String(SANDBOX_INTERNAL_OPENWORK_PORT))}` +
      ` --token ${shQuote(options.openwork.token)} --host-token ${shQuote(options.openwork.hostToken)}` +
      ` --workspace ${shQuote(workspaceDir)}` +
      ` --approval ${shQuote(options.openwork.approvalMode)}` +
      ` --approval-timeout ${shQuote(String(options.openwork.approvalTimeoutMs))}` +
      (options.openwork.readOnly ? " --read-only" : "") +
      ` --opencode-base-url ${shQuote(`http://127.0.0.1:${SANDBOX_INTERNAL_OPENCODE_PORT}`)}` +
      ` --opencode-directory ${shQuote(workspaceDir)}` +
      ` ${openworkAuthArgs}` +
      ` --log-format ${shQuote(options.openwork.logFormat)}` +
      (options.openwork.opencodeRouterEnabled ? ` --opencode-router-health-port ${shQuote(String(SANDBOX_INTERNAL_OPENCODE_ROUTER_HEALTH_PORT))}` : "") +
      (openworkCors ? ` ${openworkCors}` : ""),
  ]
    .filter(Boolean)
    .join("\n");

  await writeFile(options.entrypointHostPath, `${script}\n`, "utf8");
}

async function startDockerSandbox(options: {
  image: string;
  containerName: string;
  workspace: string;
  persistDir: string;
  opencodeConfigDir: string;
  extraMounts: SandboxMount[];
  sidecars: { opencode: string; openworkServer: string; opencodeRouter?: string | null };
  ports: { openwork: number; opencodeRouterHealth?: number | null };
  opencode: {
    corsOrigins: string[];
    username?: string;
    password?: string;
    hotReload: OpencodeHotReload;
  };
  openwork: {
    token: string;
    hostToken: string;
    approvalMode: ApprovalMode;
    approvalTimeoutMs: number;
    readOnly: boolean;
    corsOrigins: string[];
    opencodeUsername?: string;
    opencodePassword?: string;
    logFormat: LogFormat;
  };
  runId: string;
  logFormat: LogFormat;
  detach: boolean;
  logger: Logger;
}): Promise<{ child: ReturnType<typeof spawn>; cleanup: () => Promise<void> }> {
  const staged = await stageSandboxRuntime({
    persistDir: options.persistDir,
    containerName: options.containerName,
    sidecars: options.sidecars,
    detach: options.detach,
  });

  await writeSandboxEntrypoint({
    entrypointHostPath: staged.entrypointHostPath,
    rootInContainer: staged.rootInContainer,
    opencodeConfigDirInContainer: "/opencode-config",
    backend: "docker",
    opencode: options.opencode,
    openwork: {
      token: options.openwork.token,
      hostToken: options.openwork.hostToken,
      approvalMode: options.openwork.approvalMode,
      approvalTimeoutMs: options.openwork.approvalTimeoutMs,
      readOnly: options.openwork.readOnly,
      corsOrigins: options.openwork.corsOrigins,
      opencodeUsername: options.openwork.opencodeUsername,
      opencodePassword: options.openwork.opencodePassword,
      logFormat: options.openwork.logFormat,
      opencodeRouterEnabled: !!options.sidecars.opencodeRouter,
    },
    runId: options.runId,
    logFormat: options.logFormat,
  });

  const args: string[] = [
    "run",
    "--rm",
    "--name",
    options.containerName,
    "-p",
    `${options.ports.openwork}:${SANDBOX_INTERNAL_OPENWORK_PORT}`,
    "-v",
    `${options.workspace}:/workspace`,
    "-v",
    `${options.persistDir}:/persist`,
    "-v",
    `${options.opencodeConfigDir}:/opencode-config`,
  ];

  const hostOpencodeConfig = await resolveHostOpencodeGlobalConfigDir();
  const hasOpencodeConfigMount = options.extraMounts.some(
    (mount) => mount.containerPath === SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH,
  );
  if (hostOpencodeConfig && !hasOpencodeConfigMount) {
    args.push("-v", `${hostOpencodeConfig}:${SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH}:ro`);
    options.logger.debug("sandbox: mounted host opencode config", {
      hostPath: hostOpencodeConfig,
      containerPath: SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH,
    });
  }

  const hostOpencodeData = await resolveHostOpencodeGlobalDataDir();
  const hasOpencodeDataMount = options.extraMounts.some(
    (mount) => mount.containerPath === SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH,
  );
  if (hostOpencodeData && !hasOpencodeDataMount) {
    args.push("-v", `${hostOpencodeData}:${SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH}:ro`);
    options.logger.debug("sandbox: mounted host opencode data", {
      hostPath: hostOpencodeData,
      containerPath: SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH,
    });
  }

  if (options.sidecars.opencodeRouter && options.ports.opencodeRouterHealth) {
    args.push("-p", `${options.ports.opencodeRouterHealth}:${SANDBOX_INTERNAL_OPENCODE_ROUTER_HEALTH_PORT}`);
  }

  for (const mount of options.extraMounts) {
    const suffix = mount.readonly ? ":ro" : "";
    args.push("-v", `${mount.hostPath}:${mount.containerPath}${suffix}`);
  }

  if (options.detach) {
    args.push("-d");
  }

  const scriptInContainer = `${staged.rootInContainer}/entrypoint.sh`;
  args.push(options.image, "sh", scriptInContainer);

  const child = spawnProcess("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  prefixStream(child.stdout, "sandbox", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "sandbox", "stderr", options.logger, child.pid ?? undefined);

  return { child, cleanup: staged.cleanup };
}

async function startAppleContainerSandbox(options: {
  image: string;
  containerName: string;
  workspace: string;
  persistDir: string;
  opencodeConfigDir: string;
  extraMounts: SandboxMount[];
  sidecars: { opencode: string; openworkServer: string; opencodeRouter?: string | null };
  ports: { openwork: number; opencodeRouterHealth?: number | null };
  opencode: {
    corsOrigins: string[];
    username?: string;
    password?: string;
    hotReload: OpencodeHotReload;
  };
  openwork: {
    token: string;
    hostToken: string;
    approvalMode: ApprovalMode;
    approvalTimeoutMs: number;
    readOnly: boolean;
    corsOrigins: string[];
    opencodeUsername?: string;
    opencodePassword?: string;
    logFormat: LogFormat;
  };
  runId: string;
  logFormat: LogFormat;
  detach: boolean;
  logger: Logger;
}): Promise<{ child: ReturnType<typeof spawn>; cleanup: () => Promise<void> }> {
  await ensureAppleContainerSystemReady();

  const staged = await stageSandboxRuntime({
    persistDir: options.persistDir,
    containerName: options.containerName,
    sidecars: options.sidecars,
    detach: options.detach,
  });

  await writeSandboxEntrypoint({
    entrypointHostPath: staged.entrypointHostPath,
    rootInContainer: staged.rootInContainer,
    opencodeConfigDirInContainer: "/opencode-config",
    backend: "container",
    opencode: options.opencode,
    openwork: {
      token: options.openwork.token,
      hostToken: options.openwork.hostToken,
      approvalMode: options.openwork.approvalMode,
      approvalTimeoutMs: options.openwork.approvalTimeoutMs,
      readOnly: options.openwork.readOnly,
      corsOrigins: options.openwork.corsOrigins,
      opencodeUsername: options.openwork.opencodeUsername,
      opencodePassword: options.openwork.opencodePassword,
      logFormat: options.openwork.logFormat,
      opencodeRouterEnabled: !!options.sidecars.opencodeRouter,
    },
    runId: options.runId,
    logFormat: options.logFormat,
  });

  const args: string[] = [
    "run",
    "--rm",
    "--name",
    options.containerName,
    "-p",
    `${options.ports.openwork}:${SANDBOX_INTERNAL_OPENWORK_PORT}`,
    "-v",
    `${options.workspace}:/workspace`,
    "-v",
    `${options.persistDir}:/persist`,
    "-v",
    `${options.opencodeConfigDir}:/opencode-config`,
  ];

  const hostOpencodeConfig = await resolveHostOpencodeGlobalConfigDir();
  const hasOpencodeConfigMount = options.extraMounts.some(
    (mount) => mount.containerPath === SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH,
  );
  if (hostOpencodeConfig && !hasOpencodeConfigMount) {
    args.push(
      "--mount",
      `type=bind,source=${hostOpencodeConfig},target=${SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH},readonly`,
    );
    options.logger.debug("sandbox: mounted host opencode config", {
      hostPath: hostOpencodeConfig,
      containerPath: SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH,
    });
  }

  const hostOpencodeData = await resolveHostOpencodeGlobalDataDir();
  const hasOpencodeDataMount = options.extraMounts.some(
    (mount) => mount.containerPath === SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH,
  );
  if (hostOpencodeData && !hasOpencodeDataMount) {
    args.push(
      "--mount",
      `type=bind,source=${hostOpencodeData},target=${SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH},readonly`,
    );
    options.logger.debug("sandbox: mounted host opencode data", {
      hostPath: hostOpencodeData,
      containerPath: SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH,
    });
  }

  if (options.sidecars.opencodeRouter && options.ports.opencodeRouterHealth) {
    args.push("-p", `${options.ports.opencodeRouterHealth}:${SANDBOX_INTERNAL_OPENCODE_ROUTER_HEALTH_PORT}`);
  }

  for (const mount of options.extraMounts) {
    if (mount.readonly) {
      args.push("--mount", `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`);
    } else {
      args.push("-v", `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  if (options.detach) {
    args.push("-d");
  }

  const scriptInContainer = `${staged.rootInContainer}/entrypoint.sh`;
  args.push(options.image, "sh", scriptInContainer);

  const child = spawnProcess("container", args, { stdio: ["ignore", "pipe", "pipe"] });
  prefixStream(child.stdout, "sandbox", "stdout", options.logger, child.pid ?? undefined);
  prefixStream(child.stderr, "sandbox", "stderr", options.logger, child.pid ?? undefined);

  return { child, cleanup: staged.cleanup };
}

async function verifyOpenCodeRouterVersion(binary: ResolvedBinary): Promise<string | undefined> {
  if (binary.source !== "external") {
    return binary.expectedVersion;
  }
  const actual = await readCliVersion(binary.bin);
  assertVersionMatch("opencode-router", binary.expectedVersion, actual, binary.bin);
  return actual;
}

async function verifyOpencodeVersion(binary: ResolvedBinary): Promise<string | undefined> {
  const actual = await readCliVersion(binary.bin);
  // When the binary was explicitly provided via --opencode-bin (source "external"),
  // a strict version check would break desktop app users whenever a new opencode
  // release ships on GitHub before OpenWork updates its bundled binary. Log a
  // warning instead of throwing so the caller can still proceed.
  if (binary.source === "external" && binary.expectedVersion && actual && binary.expectedVersion !== actual) {
    process.stderr.write(
      `[openwork-orchestrator] Warning: opencode version mismatch (expected ${binary.expectedVersion}, got ${actual}). Proceeding with ${binary.bin}.\n`,
    );
    return actual;
  }
  assertVersionMatch("opencode", binary.expectedVersion, actual, binary.bin);
  return actual;
}

async function verifyOpenworkServer(input: {
  baseUrl: string;
  token: string;
  hostToken: string;
  expectedVersion?: string;
  expectedWorkspace: string;
  expectedOpencodeBaseUrl?: string;
  expectedOpencodeDirectory?: string;
  expectedOpencodeUsername?: string;
  expectedOpencodePassword?: string;
}): Promise<string | undefined> {
  const health = await fetchJson(`${input.baseUrl}/health`);
  const actualVersion = typeof health?.version === "string" ? health.version : undefined;
  assertVersionMatch("openwork-server", input.expectedVersion, actualVersion, `${input.baseUrl}/health`);

  const headers = { Authorization: `Bearer ${input.token}` };
  const workspaces = await fetchJson(`${input.baseUrl}/workspaces`, { headers });
  const items = Array.isArray(workspaces?.items) ? (workspaces.items as Array<Record<string, unknown>>) : [];
  if (!items.length) {
    throw new Error("OpenWork server returned no workspaces");
  }

  const expectedPath = normalizeWorkspacePath(input.expectedWorkspace);
  const matched = items.find((item) => {
    const candidate = item as { path?: string };
    const path = typeof candidate.path === "string" ? candidate.path : "";
    return path && normalizeWorkspacePath(path) === expectedPath;
  }) as
    | {
        id?: string;
        path?: string;
        opencode?: { baseUrl?: string; directory?: string; username?: string; password?: string };
      }
    | undefined;

  if (!matched) {
    throw new Error(`OpenWork server workspace mismatch. Expected ${expectedPath}.`);
  }

  const opencode = matched.opencode;
  if (input.expectedOpencodeBaseUrl && opencode?.baseUrl !== input.expectedOpencodeBaseUrl) {
    throw new Error(
      `OpenWork server OpenCode base URL mismatch: expected ${input.expectedOpencodeBaseUrl}, got ${opencode?.baseUrl ?? "<missing>"}.`,
    );
  }
  if (input.expectedOpencodeDirectory && opencode?.directory !== input.expectedOpencodeDirectory) {
    throw new Error(
      `OpenWork server OpenCode directory mismatch: expected ${input.expectedOpencodeDirectory}, got ${opencode?.directory ?? "<missing>"}.`,
    );
  }
  if (input.expectedOpencodeUsername && opencode?.username !== input.expectedOpencodeUsername) {
    throw new Error("OpenWork server OpenCode username mismatch.");
  }
  if (input.expectedOpencodePassword && opencode?.password !== input.expectedOpencodePassword) {
    throw new Error("OpenWork server OpenCode password mismatch.");
  }

  const hostHeaders = { "X-OpenWork-Host-Token": input.hostToken };
  await fetchJson(`${input.baseUrl}/approvals`, { headers: hostHeaders });

  return actualVersion;
}

async function runChecks(input: {
  opencodeClient: ReturnType<typeof createOpencodeClient>;
  openworkUrl: string;
  openworkToken: string;
  hostToken: string;
  checkEvents: boolean;
}) {
  const baseUrl = input.openworkUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${input.openworkToken}` };
  const hostHeaders = { "X-OpenWork-Host-Token": input.hostToken };
  const workspaces = await fetchJson(`${baseUrl}/workspaces`, { headers });
  if (!workspaces?.items?.length) {
    throw new Error("OpenWork server returned no workspaces");
  }

  const workspaceId = workspaces.items[0].id as string;
  await fetchJson(`${baseUrl}/workspace/${workspaceId}/config`, { headers });

  // Smoke test: mounted opencodeRouter proxy and auth behavior.
  // - /w/:id/opencode-router/health is client-readable
  // - other /w/:id/opencode-router/* requires host/owner auth
  const owMountBase = `${baseUrl}/w/${encodeURIComponent(workspaceId)}/opencode-router`;
  const owHealthRes = await fetch(`${owMountBase}/health`, {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  if (owHealthRes.status >= 500) {
    throw new Error(`opencodeRouter mount proxy returned ${owHealthRes.status}`);
  }
  const owConfigured = owHealthRes.status !== 404;
  if (owConfigured) {
    const clientRes = await fetch(`${owMountBase}/config/groups`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (clientRes.status === 200) {
      throw new Error("opencodeRouter mount proxy /config/groups should require host auth");
    }
    if (clientRes.status !== 401 && clientRes.status !== 403) {
      throw new Error(`opencodeRouter mount proxy /config/groups unexpected status: ${clientRes.status}`);
    }

    const hostRes = await fetch(`${owMountBase}/config/groups`, {
      headers: hostHeaders,
      signal: AbortSignal.timeout(3000),
    });
    if (hostRes.status >= 500) {
      throw new Error(`opencodeRouter mount proxy (host auth) returned ${hostRes.status}`);
    }
    if (hostRes.status === 401 || hostRes.status === 403) {
      throw new Error("opencodeRouter mount proxy /config/groups rejected host auth");
    }
  }

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

/**
 * Lighter check suite for sandbox mode.  Uses only raw HTTP against the
 * openwork-server endpoints — no OpenCode SDK calls that rely on Bearer
 * auth through the proxy (since the released server binary may predate our
 * token/proxy changes).
 */
async function runSandboxChecks(input: {
  openworkUrl: string;
  openworkToken: string;
  hostToken: string;
}) {
  const baseUrl = input.openworkUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${input.openworkToken}` };
  const hostHeaders = { "X-OpenWork-Host-Token": input.hostToken };

  // 1. Server health
  const health = await fetchJson(`${baseUrl}/health`);
  if (!health || typeof health !== "object") {
    throw new Error("openwork-server /health returned invalid payload");
  }

  // 2. Workspaces list
  const workspaces = await fetchJson(`${baseUrl}/workspaces`, { headers });
  if (!workspaces?.items?.length) {
    throw new Error("openwork-server returned no workspaces");
  }
  const workspaceId = workspaces.items[0].id as string;

  // 3. Workspace config
  await fetchJson(`${baseUrl}/workspace/${workspaceId}/config`, { headers });

  // 4. Approvals endpoint (host auth)
  await fetchJson(`${baseUrl}/approvals`, { headers: hostHeaders });

  // 5. Proxy is reachable (even if auth is rejected — non-5xx proves the
  //    server is proxying to a running opencode)
  const proxyRes = await fetch(`${baseUrl}/opencode/health`, {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  if (proxyRes.status >= 500) {
    throw new Error(`opencode proxy returned ${proxyRes.status}`);
  }

  // 6. opencodeRouter proxy is reachable (if configured)
  const owRes = await fetch(`${baseUrl}/opencode-router/health`, {
    headers,
    signal: AbortSignal.timeout(3000),
  });
  if (owRes.status >= 500) {
    throw new Error(`opencodeRouter proxy returned ${owRes.status}`);
  }

  // 7. Mounted opencodeRouter proxy + auth behavior (if configured)
  if (owRes.status !== 404) {
    const owMountBase = `${baseUrl}/w/${encodeURIComponent(workspaceId)}/opencode-router`;
    const mountHealth = await fetch(`${owMountBase}/health`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (mountHealth.status >= 500) {
      throw new Error(`opencodeRouter mount proxy returned ${mountHealth.status}`);
    }
    const mountClient = await fetch(`${owMountBase}/config/groups`, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    if (mountClient.status === 200) {
      throw new Error("opencodeRouter mount proxy /config/groups should require host auth");
    }
    if (mountClient.status !== 401 && mountClient.status !== 403) {
      throw new Error(`opencodeRouter mount proxy /config/groups unexpected status: ${mountClient.status}`);
    }
    const mountHost = await fetch(`${owMountBase}/config/groups`, {
      headers: hostHeaders,
      signal: AbortSignal.timeout(3000),
    });
    if (mountHost.status >= 500) {
      throw new Error(`opencodeRouter mount proxy (host auth) returned ${mountHost.status}`);
    }
    if (mountHost.status === 401 || mountHost.status === 403) {
      throw new Error("opencodeRouter mount proxy /config/groups rejected host auth");
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

async function waitForRouterHealthy(baseUrl: string, timeoutMs = 10_000, pollMs = 250): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  const url = baseUrl.replace(/\/$/, "");
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for daemon health");
}

function outputResult(payload: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (typeof payload === "string") {
    console.log(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function outputError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    return;
  }
  console.error(message);
}

function createVerboseLogger(enabled: boolean, logger?: Logger, component = "openwork-orchestrator") {
  return (message: string) => {
    if (!enabled) return;
    if (logger) {
      logger.debug(message, undefined, component);
      return;
    }
    console.log(`[${component}] ${message}`);
  };
}

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

const ANSI = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function colorize(input: string, color: string, enabled: boolean): string {
  if (!enabled) return input;
  return `${color}${input}${ANSI.reset}`;
}

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function mergeResourceAttributes(additional: Record<string, string>, existing?: string): string {
  const entries = new Map<string, string>();
  if (existing) {
    for (const part of existing.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [key, ...rest] = trimmed.split("=");
      if (!key || rest.length === 0) continue;
      entries.set(key, rest.join("=").replace(/,/g, ";"));
    }
  }
  for (const [key, value] of Object.entries(additional)) {
    if (!key) continue;
    if (value === undefined || value === null) continue;
    entries.set(key, String(value).replace(/,/g, ";"));
  }
  return Array.from(entries.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function createLogger(options: {
  format: LogFormat;
  runId: string;
  serviceName: string;
  serviceVersion?: string;
  output?: "stdout" | "silent";
  color?: boolean;
  onLog?: (event: LogEvent) => void;
}): Logger {
  const host = hostname().trim();
  const resource: Record<string, string> = {
    "service.name": options.serviceName,
    "service.instance.id": options.runId,
  };
  if (options.serviceVersion) {
    resource["service.version"] = options.serviceVersion;
  }
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": options.runId,
    "process.pid": process.pid,
  };
  const output = options.output ?? "stdout";
  const colorEnabled = options.color ?? false;
  const componentColors: Record<string, string> = {
    "openwork-orchestrator": ANSI.gray,
    opencode: ANSI.cyan,
    "openwork-server": ANSI.green,
    opencodeRouter: ANSI.magenta,
    "openwork-orchestrator-router": ANSI.cyan,
  };
  const levelColors: Record<LogLevel, string> = {
    debug: ANSI.gray,
    info: ANSI.gray,
    warn: ANSI.yellow,
    error: ANSI.red,
  };

  const emit = (level: LogLevel, message: string, attributes?: LogAttributes, component?: string) => {
    const mergedAttributes: LogAttributes = {
      ...baseAttributes,
      ...(component ? { "service.component": component } : {}),
      ...(attributes ?? {}),
    };
    options.onLog?.({
      time: Date.now(),
      level,
      message,
      component,
      attributes: mergedAttributes,
    });
    if (output === "silent") return;
    if (options.format === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: message,
        attributes: mergedAttributes,
        resource,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const label = component ?? options.serviceName;
    const tagLabel = label ? `[${label}]` : "";
    const levelTag = level === "info" ? "" : level.toUpperCase();
    const coloredLabel = tagLabel
      ? colorize(tagLabel, componentColors[label] ?? ANSI.gray, colorEnabled)
      : "";
    const coloredLevel = levelTag
      ? colorize(levelTag, levelColors[level] ?? ANSI.gray, colorEnabled)
      : "";
    const tag = [coloredLabel, coloredLevel].filter(Boolean).join(" ");
    const line = tag ? `${tag} ${message}` : message;
    process.stdout.write(`${line}\n`);
  };

  const child = (component: string, attributes?: LogAttributes): LoggerChild => ({
    log: (level, message, attrs) => emit(level, message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    debug: (message, attrs) => emit("debug", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    info: (message, attrs) => emit("info", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    warn: (message, attrs) => emit("warn", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
    error: (message, attrs) => emit("error", message, { ...(attributes ?? {}), ...(attrs ?? {}) }, component),
  });

  return {
    format: options.format,
    output,
    log: emit,
    debug: (message, attrs, component) => emit("debug", message, attrs, component),
    info: (message, attrs, component) => emit("info", message, attrs, component),
    warn: (message, attrs, component) => emit("warn", message, attrs, component),
    error: (message, attrs, component) => emit("error", message, attrs, component),
    child,
  };
}

function looksLikeOtelLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return false;
    return typeof parsed.timeUnixNano === "string" && typeof parsed.severityText === "string";
  } catch {
    return false;
  }
}

function buildAttachCommand(input: {
  url: string;
  workspace: string;
  username?: string;
  password?: string;
}): string {
  const parts: string[] = [];
  if (input.username && input.password && input.username !== DEFAULT_OPENCODE_USERNAME) {
    parts.push(`OPENCODE_SERVER_USERNAME=${input.username}`);
  }
  if (input.password) {
    parts.push(`OPENCODE_SERVER_PASSWORD=${input.password}`);
  }
  parts.push("opencode", "attach", input.url, "--dir", input.workspace);
  return parts.join(" ");
}

async function runClipboardCommand(command: string, args: string[], text: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawnProcess(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.stdin?.write(text);
    child.stdin?.end();
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function copyToClipboard(text: string): Promise<{ copied: boolean; error?: string }> {
  const platform = process.platform;
  const commands: Array<{ command: string; args: string[] }> = [];
  if (platform === "darwin") {
    commands.push({ command: "pbcopy", args: [] });
  } else if (platform === "win32") {
    commands.push({ command: "clip", args: [] });
  } else {
    commands.push({ command: "wl-copy", args: [] });
    commands.push({ command: "xclip", args: ["-selection", "clipboard"] });
    commands.push({ command: "xsel", args: ["--clipboard", "--input"] });
  }
  for (const entry of commands) {
    try {
      const ok = await runClipboardCommand(entry.command, entry.args, text);
      if (ok) return { copied: true };
    } catch {
      // ignore
    }
  }
  return { copied: false, error: "Clipboard unavailable" };
}

async function spawnRouterDaemon(args: ParsedArgs, dataDir: string, host: string, port: number) {
  const self = resolveSelfCommand();
  const commandArgs = [
    ...self.prefixArgs,
    "daemon",
    "run",
    "--data-dir",
    dataDir,
    "--daemon-host",
    host,
    "--daemon-port",
    String(port),
  ];

  const opencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.OPENWORK_OPENCODE_BIN;
  const opencodeHost = readFlag(args.flags, "opencode-host") ?? process.env.OPENWORK_OPENCODE_HOST;
  const opencodePort = readFlag(args.flags, "opencode-port") ?? process.env.OPENWORK_OPENCODE_PORT;
  const opencodeWorkdir = readFlag(args.flags, "opencode-workdir") ?? process.env.OPENWORK_OPENCODE_WORKDIR;
  const opencodeHotReload =
    readFlag(args.flags, "opencode-hot-reload") ??
    process.env.OPENWORK_OPENCODE_HOT_RELOAD;
  const opencodeHotReloadDebounceMs =
    readFlag(args.flags, "opencode-hot-reload-debounce-ms") ??
    process.env.OPENWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS;
  const opencodeHotReloadCooldownMs =
    readFlag(args.flags, "opencode-hot-reload-cooldown-ms") ??
    process.env.OPENWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS;
  const opencodeUsername = readFlag(args.flags, "opencode-username") ?? process.env.OPENWORK_OPENCODE_USERNAME;
  const opencodePassword = readFlag(args.flags, "opencode-password") ?? process.env.OPENWORK_OPENCODE_PASSWORD;
  const corsValue = readFlag(args.flags, "cors") ?? process.env.OPENWORK_OPENCODE_CORS;
  const allowExternal = readBool(args.flags, "allow-external", false, "OPENWORK_ALLOW_EXTERNAL");
  const sidecarSource = readFlag(args.flags, "sidecar-source") ?? process.env.OPENWORK_SIDECAR_SOURCE;
  const opencodeSource = readFlag(args.flags, "opencode-source") ?? process.env.OPENWORK_OPENCODE_SOURCE;
  const verbose = readBool(args.flags, "verbose", false, "OPENWORK_VERBOSE");
  const logFormat = readFlag(args.flags, "log-format") ?? process.env.OPENWORK_LOG_FORMAT;
  const runId = readFlag(args.flags, "run-id") ?? process.env.OPENWORK_RUN_ID;

  if (opencodeBin) commandArgs.push("--opencode-bin", opencodeBin);
  if (opencodeHost) commandArgs.push("--opencode-host", opencodeHost);
  if (opencodePort) commandArgs.push("--opencode-port", String(opencodePort));
  if (opencodeWorkdir) commandArgs.push("--opencode-workdir", opencodeWorkdir);
  if (opencodeHotReload) commandArgs.push("--opencode-hot-reload", opencodeHotReload);
  if (opencodeHotReloadDebounceMs) commandArgs.push("--opencode-hot-reload-debounce-ms", String(opencodeHotReloadDebounceMs));
  if (opencodeHotReloadCooldownMs) commandArgs.push("--opencode-hot-reload-cooldown-ms", String(opencodeHotReloadCooldownMs));
  if (opencodeUsername) commandArgs.push("--opencode-username", opencodeUsername);
  if (opencodePassword) commandArgs.push("--opencode-password", opencodePassword);
  if (corsValue) commandArgs.push("--cors", corsValue);
  if (allowExternal) commandArgs.push("--allow-external");
  if (sidecarSource) commandArgs.push("--sidecar-source", sidecarSource);
  if (opencodeSource) commandArgs.push("--opencode-source", opencodeSource);
  if (verbose) commandArgs.push("--verbose");
  if (logFormat) commandArgs.push("--log-format", String(logFormat));
  if (runId) commandArgs.push("--run-id", String(runId));

  const child = spawnProcess(self.command, commandArgs, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
    },
  });
  child.unref();
}

async function ensureRouterDaemon(args: ParsedArgs, autoStart = true): Promise<{ baseUrl: string; dataDir: string }> {
  const dataDir = resolveRouterDataDir(args.flags);
  const statePath = routerStatePath(dataDir);
  const state = await loadRouterState(statePath);
  const existing = state.daemon;
  if (existing && existing.baseUrl && isProcessAlive(existing.pid)) {
    try {
      await waitForRouterHealthy(existing.baseUrl, 1500, 150);
      return { baseUrl: existing.baseUrl, dataDir };
    } catch {
      // fallthrough
    }
  }

  if (!autoStart) {
    throw new Error("orchestrator daemon is not running");
  }

  const host = readFlag(args.flags, "daemon-host") ?? "127.0.0.1";
  const port = await resolvePort(
    readNumber(args.flags, "daemon-port", undefined, "OPENWORK_DAEMON_PORT"),
    "127.0.0.1",
  );
  const baseUrl = `http://${host}:${port}`;
  await spawnRouterDaemon(args, dataDir, host, port);
  await waitForRouterHealthy(baseUrl, 10_000, 250);
  return { baseUrl, dataDir };
}

async function requestRouter(args: ParsedArgs, method: string, path: string, body?: unknown, autoStart = true) {
  const { baseUrl } = await ensureRouterDaemon(args, autoStart);
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {};
  let payload: string | undefined;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  return fetchJson(url, {
    method,
    headers,
    body: payload,
  });
}

async function runDaemonCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1] ?? "run";

  try {
    if (subcommand === "run" || subcommand === "foreground") {
      await runRouterDaemon(args);
      return;
    }
    if (subcommand === "start") {
      const { baseUrl } = await ensureRouterDaemon(args, true);
      const status = await fetchJson(`${baseUrl.replace(/\/$/, "")}/health`);
      outputResult({ ok: true, baseUrl, ...status }, outputJson);
      return;
    }
    if (subcommand === "status") {
      const { baseUrl } = await ensureRouterDaemon(args, false);
      const status = await fetchJson(`${baseUrl.replace(/\/$/, "")}/health`);
      outputResult({ ok: true, baseUrl, ...status }, outputJson);
      return;
    }
    if (subcommand === "stop") {
      const { baseUrl } = await ensureRouterDaemon(args, false);
      await fetchJson(`${baseUrl.replace(/\/$/, "")}/shutdown`, { method: "POST" });
      outputResult({ ok: true }, outputJson);
      return;
    }
    throw new Error("daemon requires start|stop|status|run");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runWorkspaceCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1];
  const id = args.positionals[2];

  try {
    if (subcommand === "add") {
      if (!id) throw new Error("workspace path is required");
      const name = readFlag(args.flags, "name");
      const result = await requestRouter(args, "POST", "/workspaces", {
        path: id,
        name: name ?? null,
      });
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "add-remote") {
      if (!id) throw new Error("baseUrl is required");
      const directory = readFlag(args.flags, "directory");
      const name = readFlag(args.flags, "name");
      const result = await requestRouter(args, "POST", "/workspaces/remote", {
        baseUrl: id,
        directory: directory ?? null,
        name: name ?? null,
      });
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "list") {
      const result = await requestRouter(args, "GET", "/workspaces");
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "switch") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "POST", `/workspaces/${encodeURIComponent(id)}/activate`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "info") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "GET", `/workspaces/${encodeURIComponent(id)}`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    if (subcommand === "path") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "GET", `/workspaces/${encodeURIComponent(id)}/path`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    throw new Error("workspace requires add|add-remote|list|switch|info|path");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runInstanceCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1];
  const id = args.positionals[2];

  try {
    if (subcommand === "dispose") {
      if (!id) throw new Error("workspace id is required");
      const result = await requestRouter(args, "POST", `/instances/${encodeURIComponent(id)}/dispose`);
      outputResult({ ok: true, ...result }, outputJson);
      return;
    }
    throw new Error("instance requires dispose");
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runRouterDaemon(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const verbose = readBool(args.flags, "verbose", false, "OPENWORK_VERBOSE");
  const logFormat = readLogFormat(args.flags, "log-format", "pretty", "OPENWORK_LOG_FORMAT");
  const colorEnabled =
    readBool(args.flags, "color", process.stdout.isTTY, "OPENWORK_COLOR") && !process.env.NO_COLOR;
  const runId = readFlag(args.flags, "run-id") ?? process.env.OPENWORK_RUN_ID ?? randomUUID();
  const cliVersion = await resolveCliVersion();
  const logger = createLogger({
    format: logFormat,
    runId,
    serviceName: "openwork-orchestrator",
    serviceVersion: cliVersion,
    output: "stdout",
    color: colorEnabled,
  });
  const logVerbose = createVerboseLogger(verbose && !outputJson, logger, "openwork-orchestrator");
  const sidecarSourceInput = readBinarySource(args.flags, "sidecar-source", "auto", "OPENWORK_SIDECAR_SOURCE");
  const opencodeSourceInput = readBinarySource(args.flags, "opencode-source", "auto", "OPENWORK_OPENCODE_SOURCE");
  const sidecarSource = sidecarSourceInput;
  const opencodeSource = opencodeSourceInput;
  const dataDir = resolveRouterDataDir(args.flags);
  const statePath = routerStatePath(dataDir);
  let state = await loadRouterState(statePath);

  const host = readFlag(args.flags, "daemon-host") ?? "127.0.0.1";
  const port = await resolvePort(
    readNumber(args.flags, "daemon-port", undefined, "OPENWORK_DAEMON_PORT"),
    "127.0.0.1",
  );

  const opencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.OPENWORK_OPENCODE_BIN;
  const opencodeHost =
    readFlag(args.flags, "opencode-host") ?? process.env.OPENWORK_OPENCODE_HOST ?? "127.0.0.1";
  const opencodePassword =
    readFlag(args.flags, "opencode-password") ??
    process.env.OPENWORK_OPENCODE_PASSWORD ??
    process.env.OPENCODE_SERVER_PASSWORD;
  const opencodeUsername =
    readFlag(args.flags, "opencode-username") ??
    process.env.OPENWORK_OPENCODE_USERNAME ??
    process.env.OPENCODE_SERVER_USERNAME ??
    DEFAULT_OPENCODE_USERNAME;
  const authHeaders = opencodePassword
    ? { Authorization: `Basic ${encodeBasicAuth(opencodeUsername, opencodePassword)}` }
    : undefined;
  const opencodePort = await resolvePort(
    readNumber(args.flags, "opencode-port", state.opencode?.port, "OPENWORK_OPENCODE_PORT"),
    "127.0.0.1",
    state.opencode?.port,
  );
  const opencodeHotReload = readOpencodeHotReload(
    args.flags,
    {
      enabled: true,
      debounceMs: DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
      cooldownMs: DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    },
    {
      enabled: "OPENWORK_OPENCODE_HOT_RELOAD",
      debounceMs: "OPENWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS",
      cooldownMs: "OPENWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS",
    },
  );
  const corsValue =
    readFlag(args.flags, "cors") ??
    process.env.OPENWORK_OPENCODE_CORS ??
    "http://localhost:5173,tauri://localhost,http://tauri.localhost";
  const corsOrigins = parseList(corsValue);
  const opencodeWorkdirFlag =
    readFlag(args.flags, "opencode-workdir") ?? process.env.OPENWORK_OPENCODE_WORKDIR;
  const activeWorkspace = state.workspaces.find((entry) => entry.id === state.activeId && entry.workspaceType === "local");
  const opencodeWorkdir = opencodeWorkdirFlag ?? activeWorkspace?.path ?? process.cwd();
  const resolvedWorkdir = await ensureWorkspace(opencodeWorkdir);
  const opencodeConfigDir = join(dataDir, "opencode-config", workspaceIdForLocal(resolvedWorkdir));
  await ensureOpencodeManagedTools(opencodeConfigDir);
  logger.info(
    "Daemon starting",
    { runId, logFormat, workdir: resolvedWorkdir, host, port },
    "openwork-orchestrator",
  );

  const sidecar = resolveSidecarConfig(args.flags, cliVersion);
  const allowExternal = readBool(args.flags, "allow-external", false, "OPENWORK_ALLOW_EXTERNAL");
  const manifest = await readVersionManifest();
  logVerbose(`cli version: ${cliVersion}`);
  logVerbose(`sidecar target: ${sidecar.target ?? "unknown"}`);
  logVerbose(`sidecar dir: ${sidecar.dir}`);
  logVerbose(`sidecar base URL: ${sidecar.baseUrl}`);
  logVerbose(`sidecar manifest: ${sidecar.manifestUrl}`);
  logVerbose(`sidecar source: ${sidecarSource}`);
  logVerbose(`opencode source: ${opencodeSource}`);
  logVerbose(
    `opencode hot reload: ${opencodeHotReload.enabled ? "on" : "off"} (debounce=${opencodeHotReload.debounceMs}ms cooldown=${opencodeHotReload.cooldownMs}ms)`,
  );
  logVerbose(`allow external: ${allowExternal ? "true" : "false"}`);
  const opencodeBinary = await resolveOpencodeBin({
    explicit: opencodeBin,
    manifest,
    allowExternal,
    sidecar,
    source: opencodeSource,
  });
  logVerbose(`opencode bin: ${opencodeBinary.bin} (${opencodeBinary.source})`);

  let opencodeChild: ReturnType<typeof spawn> | null = null;

  const updateDiagnostics = (actualVersion?: string) => {
    state.cliVersion = cliVersion;
    state.sidecar = {
      dir: sidecar.dir,
      baseUrl: sidecar.baseUrl,
      manifestUrl: sidecar.manifestUrl,
      target: sidecar.target,
      source: sidecarSource,
      opencodeSource,
      allowExternal,
    };
    state.binaries = {
      opencode: {
        path: opencodeBinary.bin,
        source: opencodeBinary.source,
        expectedVersion: opencodeBinary.expectedVersion,
        actualVersion,
      },
    };
  };

  const ensureOpencode = async () => {
    const existing = state.opencode;
    if (existing && isProcessAlive(existing.pid)) {
      const client = createOpencodeClient({
        baseUrl: existing.baseUrl,
        directory: resolvedWorkdir,
        headers: authHeaders,
      });
      try {
        await waitForOpencodeHealthy(client, 2000, 200);
        if (!state.sidecar || !state.cliVersion || !state.binaries?.opencode) {
          updateDiagnostics(state.binaries?.opencode?.actualVersion);
          await saveRouterState(statePath, state);
        }
        return { baseUrl: existing.baseUrl, client };
      } catch {
        // restart
      }
    }

    if (opencodeChild) {
      await stopChild(opencodeChild);
    }

    const opencodeActualVersion = await verifyOpencodeVersion(opencodeBinary);
    logVerbose(`opencode version: ${opencodeActualVersion ?? "unknown"}`);
    const child = await startOpencode({
      bin: opencodeBinary.bin,
      workspace: resolvedWorkdir,
      configDir: opencodeConfigDir,
      hotReload: opencodeHotReload,
      bindHost: opencodeHost,
      port: opencodePort,
      username: opencodePassword ? opencodeUsername : undefined,
      password: opencodePassword,
      corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
      logger,
      runId,
      logFormat,
    });
    opencodeChild = child;
    logger.info("Process spawned", { pid: child.pid ?? 0 }, "opencode");
    const baseUrl = `http://${opencodeHost}:${opencodePort}`;
    const client = createOpencodeClient({
      baseUrl,
      directory: resolvedWorkdir,
      headers: authHeaders,
    });
    logger.info("Waiting for health", { url: baseUrl }, "opencode");
    await waitForOpencodeHealthy(client);
    logger.info("Healthy", { url: baseUrl }, "opencode");
    state.opencode = {
      pid: child.pid ?? 0,
      port: opencodePort,
      baseUrl,
      startedAt: nowMs(),
    };
    updateDiagnostics(opencodeActualVersion);
    await saveRouterState(statePath, state);
    return { baseUrl, client };
  };

  await ensureOpencode();

  const server = createHttpServer(async (req, res) => {
    const startedAt = Date.now();
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    res.on("finish", () => {
      logger.info(
        "Router request",
        {
          method,
          path: url.pathname,
          status: res.statusCode,
          durationMs: Date.now() - startedAt,
          activeId: state.activeId,
        },
        "openwork-orchestrator-router",
      );
    });
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);

    const send = (status: number, payload: unknown) => {
      res.statusCode = status;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(payload));
    };

    const readBody = async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      if (!chunks.length) return null;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return null;
      return JSON.parse(raw);
    };

    try {
        if (req.method === "GET" && url.pathname === "/health") {
          send(200, {
            ok: true,
            daemon: state.daemon ?? null,
            opencode: state.opencode ?? null,
            activeId: state.activeId,
            workspaceCount: state.workspaces.length,
            cliVersion: state.cliVersion ?? null,
            sidecar: state.sidecar ?? null,
            binaries: state.binaries ?? null,
          });
          return;
        }

      if (req.method === "GET" && url.pathname === "/workspaces") {
        send(200, { activeId: state.activeId, workspaces: state.workspaces });
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces") {
        const body = await readBody();
        const pathInput = typeof body?.path === "string" ? body.path.trim() : "";
        if (!pathInput) {
          send(400, { error: "path is required" });
          return;
        }
        const resolved = await ensureWorkspace(pathInput);
        const id = workspaceIdForLocal(resolved);
        const name = typeof body?.name === "string" && body.name.trim()
          ? body.name.trim()
          : resolved.split(/[\\/]/).filter(Boolean).pop() ?? "Workspace";
        const existing = state.workspaces.find((entry) => entry.id === id);
        const entry: RouterWorkspace = {
          id,
          name,
          path: resolved,
          workspaceType: "local",
          createdAt: existing?.createdAt ?? nowMs(),
          lastUsedAt: nowMs(),
        };
        state.workspaces = state.workspaces.filter((item) => item.id !== id);
        state.workspaces.push(entry);
        if (!state.activeId) state.activeId = id;
        await saveRouterState(statePath, state);
        send(200, { activeId: state.activeId, workspace: entry });
        return;
      }

      if (req.method === "POST" && url.pathname === "/workspaces/remote") {
        const body = await readBody();
        const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
        if (!baseUrl || (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://"))) {
          send(400, { error: "baseUrl must start with http:// or https://" });
          return;
        }
        const directory = typeof body?.directory === "string" ? body.directory.trim() : "";
        const id = workspaceIdForRemote(baseUrl, directory || undefined);
        const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim() : baseUrl;
        const existing = state.workspaces.find((entry) => entry.id === id);
        const entry: RouterWorkspace = {
          id,
          name,
          path: directory,
          workspaceType: "remote",
          baseUrl,
          directory: directory || undefined,
          createdAt: existing?.createdAt ?? nowMs(),
          lastUsedAt: nowMs(),
        };
        state.workspaces = state.workspaces.filter((item) => item.id !== id);
        state.workspaces.push(entry);
        if (!state.activeId) state.activeId = id;
        await saveRouterState(statePath, state);
        send(200, { activeId: state.activeId, workspace: entry });
        return;
      }

      if (parts[0] === "workspaces" && parts.length === 2 && req.method === "GET") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        send(200, { workspace });
        return;
      }

      if (parts[0] === "workspaces" && parts.length === 3 && parts[2] === "activate" && req.method === "POST") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        state.activeId = workspace.id;
        workspace.lastUsedAt = nowMs();
        await saveRouterState(statePath, state);
        send(200, { activeId: state.activeId, workspace });
        return;
      }

      if (parts[0] === "workspaces" && parts.length === 3 && parts[2] === "path" && req.method === "GET") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        const isRemote = workspace.workspaceType === "remote";
        const baseUrl = isRemote ? workspace.baseUrl ?? "" : (await ensureOpencode()).baseUrl;
        if (!baseUrl) {
          send(400, { error: "workspace baseUrl missing" });
          return;
        }
        const directory = isRemote ? workspace.directory ?? "" : workspace.path;
        const client = createOpencodeClient({
          baseUrl,
          directory: directory ? directory : undefined,
          headers: authHeaders,
        });
        const pathInfo = unwrap(await client.path.get());
        workspace.lastUsedAt = nowMs();
        await saveRouterState(statePath, state);
        send(200, { workspace, path: pathInfo });
        return;
      }

      if (parts[0] === "instances" && parts.length === 3 && parts[2] === "dispose" && req.method === "POST") {
        const workspace = findWorkspace(state, decodeURIComponent(parts[1] ?? ""));
        if (!workspace) {
          send(404, { error: "workspace not found" });
          return;
        }
        const isRemote = workspace.workspaceType === "remote";
        const baseUrl = isRemote ? workspace.baseUrl ?? "" : (await ensureOpencode()).baseUrl;
        if (!baseUrl) {
          send(400, { error: "workspace baseUrl missing" });
          return;
        }
        const directory = isRemote ? workspace.directory ?? "" : workspace.path;
        const response = await fetch(
          `${baseUrl.replace(/\/$/, "")}/instance/dispose?directory=${encodeURIComponent(directory)}`,
          { method: "POST", headers: authHeaders },
        );
        const ok = response.ok ? await response.json() : false;
        workspace.lastUsedAt = nowMs();
        await saveRouterState(statePath, state);
        send(200, { disposed: ok });
        return;
      }

      if (req.method === "POST" && url.pathname === "/shutdown") {
        send(200, { ok: true });
        await shutdown();
        return;
      }

      send(404, { error: "not found" });
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const shutdown = async () => {
    logger.info("Daemon shutting down", { host, port }, "openwork-orchestrator-router");
    try {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } catch {
      // ignore
    }

    if (opencodeChild) {
      await stopChild(opencodeChild);
      opencodeChild = null;
    }

    state.daemon = undefined;
    if (state.opencode && !isProcessAlive(state.opencode.pid)) {
      state.opencode = undefined;
    }
    await saveRouterState(statePath, state);
    process.exit(0);
  };

  server.listen(port, host, async () => {
    state.daemon = {
      pid: process.pid,
      port,
      baseUrl: `http://${host}:${port}`,
      startedAt: nowMs(),
    };
    await saveRouterState(statePath, state);
    if (outputJson) {
      outputResult({ ok: true, daemon: state.daemon }, true);
    } else {
      if (logFormat === "json") {
        logger.info("Daemon running", { host, port }, "openwork-orchestrator-router");
      } else {
        console.log(`orchestrator daemon running on ${host}:${port}`);
      }
    }
  });

  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  await new Promise(() => undefined);
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
  const verbose = readBool(args.flags, "verbose", false, "OPENWORK_VERBOSE");
  const logFormat = readLogFormat(args.flags, "log-format", "pretty", "OPENWORK_LOG_FORMAT");
  const detachRequested = readBool(args.flags, "detach", false, "OPENWORK_DETACH");
  const defaultTui = process.stdout.isTTY && !outputJson && !checkOnly && !checkEvents;
  const tuiRequested = readBool(args.flags, "tui", defaultTui);
  let useTui = tuiRequested && !detachRequested && !outputJson && !checkOnly && !checkEvents && logFormat === "pretty";
  const colorPreferred =
    readBool(args.flags, "color", process.stdout.isTTY, "OPENWORK_COLOR") && !process.env.NO_COLOR;
  const runId = readFlag(args.flags, "run-id") ?? process.env.OPENWORK_RUN_ID ?? randomUUID();
  const cliVersion = await resolveCliVersion();
  const compiledBinary = isCompiledBunBinary();
  let tui: TuiHandle | undefined;
  let restoreConsoleError: (() => void) | undefined;
  const baseLoggerOptions = {
    format: logFormat,
    runId,
    serviceName: "openwork-orchestrator",
    serviceVersion: cliVersion,
    onLog: (event: LogEvent) => {
      if (!tui) return;
      const component = event.component ?? "openwork-orchestrator";
      const tuiComponent = component === "opencode-router" ? "router" : component;
      tui.pushLog({
        time: event.time,
        level: event.level,
        component: tuiComponent,
        message: event.message,
      });
    },
  };
  let logger = createLogger({
    ...baseLoggerOptions,
    output: useTui ? "silent" : "stdout",
    color: useTui ? false : colorPreferred,
  });
  let logVerbose = createVerboseLogger(verbose && !outputJson, logger, "openwork-orchestrator");
  const switchToPlainOutput = (error: string) => {
    if (!useTui) return;
    useTui = false;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    tui?.stop();
    tui = undefined;
    logger = createLogger({
      ...baseLoggerOptions,
      output: "stdout",
      color: colorPreferred,
    });
    logVerbose = createVerboseLogger(verbose && !outputJson, logger, "openwork-orchestrator");
    logger.warn(
      "TUI failed to start; falling back to plain output. Use `openwork serve` for explicit non-TUI mode.",
      { error },
      "openwork-orchestrator",
    );
  };
  const sidecarSourceInput = readBinarySource(args.flags, "sidecar-source", "auto", "OPENWORK_SIDECAR_SOURCE");
  const opencodeSourceInput = readBinarySource(args.flags, "opencode-source", "auto", "OPENWORK_OPENCODE_SOURCE");

  const workspace = readFlag(args.flags, "workspace") ?? process.env.OPENWORK_WORKSPACE ?? process.cwd();
  const resolvedWorkspace = await ensureWorkspace(workspace);
  logger.info("Run starting", { workspace: resolvedWorkspace, logFormat, runId }, "openwork-orchestrator");

  const sandboxRequested = readSandboxMode(args.flags, "sandbox", "none", "OPENWORK_SANDBOX");
  const sandboxMode = await resolveSandboxMode(sandboxRequested);
  const sandboxImage =
    readFlag(args.flags, "sandbox-image") ?? process.env.OPENWORK_SANDBOX_IMAGE ?? "debian:bookworm-slim";
  const sandboxPersistOverride =
    readFlag(args.flags, "sandbox-persist-dir") ?? process.env.OPENWORK_SANDBOX_PERSIST_DIR;
  const dataDir = resolveRouterDataDir(args.flags);
  const opencodeConfigDir = join(dataDir, "opencode-config", workspaceIdForLocal(resolvedWorkspace));
  await ensureOpencodeManagedTools(opencodeConfigDir);
  const opencodeRouterDataDir =
    sandboxMode === "none" ? join(dataDir, "opencode-router", workspaceIdForLocal(resolvedWorkspace)) : null;
  if (opencodeRouterDataDir) {
    await mkdir(opencodeRouterDataDir, { recursive: true });
  }
  const sandboxPersistDir = resolve(
    sandboxPersistOverride?.trim()
      ? sandboxPersistOverride.trim()
      : join(dataDir, "sandbox", workspaceIdForLocal(resolvedWorkspace)),
  );
  if (sandboxMode !== "none") {
    await mkdir(sandboxPersistDir, { recursive: true });
  }

  const sandboxMountValue =
    readFlag(args.flags, "sandbox-mount") ??
    process.env.OPENWORK_SANDBOX_MOUNT;
  const sandboxMountSpecs = parseList(sandboxMountValue);
  const sandboxExtraMounts =
    sandboxMode !== "none" && sandboxMountSpecs.length
      ? await resolveSandboxExtraMounts(sandboxMountSpecs, sandboxMode)
      : [];

  const explicitOpencodeBin = readFlag(args.flags, "opencode-bin") ?? process.env.OPENWORK_OPENCODE_BIN;
  const explicitOpenworkServerBin = readFlag(args.flags, "openwork-server-bin") ?? process.env.OPENWORK_SERVER_BIN;
  const explicitOpenCodeRouterBin = readFlag(args.flags, "opencode-router-bin") ?? process.env.OPENCODE_ROUTER_BIN;
  const opencodeBindHost = readFlag(args.flags, "opencode-host") ?? process.env.OPENWORK_OPENCODE_BIND_HOST ?? "0.0.0.0";
  const opencodePort =
    sandboxMode !== "none"
      ? SANDBOX_INTERNAL_OPENCODE_PORT
      : await resolvePort(
          readNumber(args.flags, "opencode-port", undefined, "OPENWORK_OPENCODE_PORT"),
          "127.0.0.1",
        );
  const opencodeHotReload = readOpencodeHotReload(
    args.flags,
    {
      enabled: true,
      debounceMs: DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
      cooldownMs: DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    },
    {
      enabled: "OPENWORK_OPENCODE_HOT_RELOAD",
      debounceMs: "OPENWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS",
      cooldownMs: "OPENWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS",
    },
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
  );
  // Always choose a free opencodeRouter health port by default (avoid conflicts with
  // other local processes using 3005).
  const opencodeRouterHealthPort = await resolvePort(
    readNumber(args.flags, "opencode-router-health-port", undefined, "OPENCODE_ROUTER_HEALTH_PORT"),
    "127.0.0.1",
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

  const manifest = await readVersionManifest();
  const allowExternal = readBool(args.flags, "allow-external", false, "OPENWORK_ALLOW_EXTERNAL");
  const sidecarTarget = resolveSandboxSidecarTarget(sandboxMode);
  const sidecar = resolveSidecarConfigForTarget(args.flags, cliVersion, sidecarTarget);

  let sidecarSource = sidecarSourceInput;
  let opencodeSource = opencodeSourceInput;
  if (sandboxMode !== "none") {
    if (sidecarSourceInput === "bundled") {
      throw new Error("Sandbox mode does not support --sidecar-source bundled");
    }
    if (opencodeSourceInput === "bundled") {
      throw new Error("Sandbox mode does not support --opencode-source bundled");
    }
    // In sandbox mode, we must run Linux binaries inside the container. When
    // custom *-bin paths are provided, treat the source as external so we don't
    // accidentally pick host (darwin) bundled binaries.
    if (sidecarSourceInput === "auto") {
      sidecarSource = explicitOpenworkServerBin || explicitOpenCodeRouterBin ? "external" : "downloaded";
    }
    if (opencodeSourceInput === "auto") {
      opencodeSource = explicitOpencodeBin ? "external" : "downloaded";
    }
  }
  logVerbose(`cli version: ${cliVersion}`);
  logVerbose(`sandbox: ${sandboxMode}`);
  if (sandboxMode !== "none") {
    logVerbose(`sandbox image: ${sandboxImage}`);
    logVerbose(`sandbox persist dir: ${sandboxPersistDir}`);
    if (sandboxExtraMounts.length) {
      logVerbose(`sandbox mounts: ${sandboxExtraMounts.length}`);
    }
  }
  logVerbose(`sidecar target: ${sidecar.target ?? "unknown"}`);
  logVerbose(`sidecar dir: ${sidecar.dir}`);
  logVerbose(`sidecar base URL: ${sidecar.baseUrl}`);
  logVerbose(`sidecar manifest: ${sidecar.manifestUrl}`);
  logVerbose(`sidecar source: ${sidecarSource}`);
  logVerbose(`opencode source: ${opencodeSource}`);
  logVerbose(
    `opencode hot reload: ${opencodeHotReload.enabled ? "on" : "off"} (debounce=${opencodeHotReload.debounceMs}ms cooldown=${opencodeHotReload.cooldownMs}ms)`,
  );
  logVerbose(`allow external: ${allowExternal ? "true" : "false"}`);
  const opencodeBinary = await resolveOpencodeBin({
    explicit: explicitOpencodeBin,
    manifest,
    allowExternal,
    sidecar,
    source: opencodeSource,
  });

  if (sandboxMode !== "none") {
    if (sandboxMode === "docker") {
      if (!(await probeCommand("docker", ["version"]))) {
        throw new Error(
          "Docker is required for --sandbox docker. Install Docker Desktop and ensure 'docker' is on PATH.",
        );
      }
    }
    if (sandboxMode === "container") {
      if (process.platform !== "darwin") {
        throw new Error("Apple container backend is only supported on macOS");
      }
      if (process.arch !== "arm64") {
        throw new Error("Apple container backend requires Apple silicon (arm64)");
      }
      if (!(await probeCommand("container", ["--version"]))) {
        throw new Error("Apple container CLI not found. Install https://github.com/apple/container");
      }
    }
  }
  const opencodeRouterEnabled = readBool(args.flags, "opencode-router", true);
  const opencodeRouterRequired = readBool(
    args.flags,
    "opencode-router-required",
    false,
    "OPENWORK_OPENCODE_ROUTER_REQUIRED",
  );
  const openworkServerBinary = await resolveOpenworkServerBin({
    explicit: explicitOpenworkServerBin,
    manifest,
    allowExternal,
    sidecar,
    source: sidecarSource,
  });
  const opencodeRouterBinary = opencodeRouterEnabled
    ? await resolveOpenCodeRouterBin({
        explicit: explicitOpenCodeRouterBin,
        manifest,
        allowExternal,
        sidecar,
        source: sidecarSource,
      })
    : null;

  if (sandboxMode !== "none") {
    // Ensure the binaries we stage into the container are actual files.
    await assertSandboxBinaryFile("opencode", opencodeBinary.bin);
    await assertSandboxBinaryFile("openwork-server", openworkServerBinary.bin);
    if (opencodeRouterBinary) {
      await assertSandboxBinaryFile("opencode-router", opencodeRouterBinary.bin);
    }
  }
  let opencodeRouterActualVersion: string | undefined;
  logVerbose(`opencode bin: ${opencodeBinary.bin} (${opencodeBinary.source})`);
  logVerbose(`openwork-server bin: ${openworkServerBinary.bin} (${openworkServerBinary.source})`);
  if (opencodeRouterBinary) {
    logVerbose(`opencodeRouter bin: ${opencodeRouterBinary.bin} (${opencodeRouterBinary.source})`);
  }

  const openworkBaseUrl = `http://127.0.0.1:${openworkPort}`;
  const openworkConnect = resolveConnectUrl(openworkPort, connectHost);
  const openworkConnectUrl = openworkConnect.connectUrl ?? openworkBaseUrl;

  const opencodeBaseUrl =
    sandboxMode !== "none" ? `${openworkBaseUrl}/opencode` : `http://127.0.0.1:${opencodePort}`;
  const opencodeConnectUrl =
    sandboxMode !== "none"
      ? `${openworkConnectUrl.replace(/\/$/, "")}/opencode`
      : (resolveConnectUrl(opencodePort, connectHost).connectUrl ?? opencodeBaseUrl);

  const attachCommand =
    sandboxMode !== "none"
      ? `OpenCode is proxied via ${opencodeConnectUrl} (requires OpenWork token)`
      : buildAttachCommand({
          url: opencodeConnectUrl,
          workspace: resolvedWorkspace,
          username: opencodeUsername,
          password: opencodePassword,
        });

  const opencodeRouterHealthUrl = `http://127.0.0.1:${opencodeRouterHealthPort}`;
  const opencodeRouterEnv: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCODE_DIRECTORY: resolvedWorkspace,
    OPENCODE_URL: opencodeConnectUrl,
    ...(opencodeUsername ? { OPENCODE_SERVER_USERNAME: opencodeUsername } : {}),
    ...(opencodePassword ? { OPENCODE_SERVER_PASSWORD: opencodePassword } : {}),
    ...(opencodeRouterEnabled ? { OPENCODE_ROUTER_HEALTH_PORT: String(opencodeRouterHealthPort) } : {}),
  };

  const children: ChildHandle[] = [];
  let shuttingDown = false;
  let detached = false;
  let sandboxContainerName: string | null = null;
  let sandboxStop: ((name: string) => Promise<void>) | null = null;
  let sandboxStopCommand: string | null = null;
  let sandboxCleanup: (() => Promise<void>) | null = null;
  const startedAt = Date.now();
  let opencodeRouterHealthInterval: NodeJS.Timeout | null = null;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    if (opencodeRouterHealthInterval) {
      clearInterval(opencodeRouterHealthInterval);
      opencodeRouterHealthInterval = null;
    }
    logger.info(
      "Shutting down",
      { children: children.map((handle) => handle.name) },
      "openwork-orchestrator",
    );
    if (sandboxContainerName && sandboxStop) {
      await sandboxStop(sandboxContainerName);
    }
    await Promise.all(children.map((handle) => stopChild(handle.child)));
    if (sandboxCleanup) {
      await sandboxCleanup();
      sandboxCleanup = null;
    }
  };

  const detachChildren = () => {
    detached = true;
    for (const handle of children) {
      try {
        handle.child.unref();
      } catch {
        // ignore
      }
      handle.child.stdout?.removeAllListeners();
      handle.child.stderr?.removeAllListeners();
      handle.child.stdout?.destroy();
      handle.child.stderr?.destroy();
    }
  };

  const handleQuit = async () => {
    tui?.stop();
    await shutdown();
    process.exit(0);
  };

  const handleDetach = async () => {
    if (detached) return;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    if (opencodeRouterHealthInterval) {
      clearInterval(opencodeRouterHealthInterval);
      opencodeRouterHealthInterval = null;
    }
    tui?.stop();
    detachChildren();
    const summary = [
      "Detached. Services still running:",
      ...children.map((handle) => `- ${handle.name} (pid ${handle.child.pid ?? "unknown"})`),
      ...(sandboxContainerName && sandboxStopCommand
        ? [
            `- sandbox (${sandboxStopCommand.split(" ")[0]} container ${sandboxContainerName})`,
            `Stop: ${sandboxStopCommand} ${sandboxContainerName}`,
          ]
        : []),
      `OpenWork URL: ${openworkConnectUrl}`,
      `OpenWork Token: ${openworkToken}`,
      `OpenCode URL: ${opencodeConnectUrl}`,
      `Attach: ${attachCommand}`,
    ].join("\n");
    process.stdout.write(`${summary}\n`);
    process.exit(0);
  };

  if (useTui) {
    if (compiledBinary) {
      const originalConsoleError = console.error.bind(console);
      restoreConsoleError = () => {
        console.error = originalConsoleError;
      };
      console.error = (...items: unknown[]) => {
        const text = items
          .map((item) => {
            if (typeof item === "string") return item;
            if (item instanceof Error) return `${item.name}: ${item.message}`;
            return String(item);
          })
          .join(" ");
        if (
          text.includes("React is not defined") ||
          text.includes("/$bunfs/root/openwork-orchestrator") ||
          text.includes("/$bunfs/root/openwork")
        ) {
          switchToPlainOutput(text);
        }
        originalConsoleError(...items);
      };
    }
    try {
      const { startOrchestratorTui } = await import("./tui/app.js");
      tui = startOrchestratorTui({
        version: cliVersion,
        connect: {
          runId,
          workspace: resolvedWorkspace,
          openworkUrl: openworkConnectUrl,
          openworkToken,
          hostToken: openworkHostToken,
          opencodeUrl: opencodeConnectUrl,
          opencodePassword: sandboxMode !== "none" ? undefined : (opencodePassword ?? undefined),
          opencodeUsername: sandboxMode !== "none" ? undefined : (opencodeUsername ?? undefined),
          attachCommand,
        },
        services: [
          { name: "opencode", label: "opencode", status: "starting", port: opencodePort },
          { name: "openwork-server", label: "openwork-server", status: "starting", port: openworkPort },
          {
            name: "router",
            label: "opencode-router",
            status: opencodeRouterEnabled ? "starting" : "disabled",
            port: sandboxMode !== "none" ? undefined : opencodeRouterHealthPort,
          },
        ],
        onQuit: handleQuit,
        onDetach: handleDetach,
        onCopyAttach: async () => {
          const result = await copyToClipboard(attachCommand);
          return { command: attachCommand, ...result };
        },
        onCopySelection: async (text) => copyToClipboard(text),
        onRouterHealth: async () => fetchOpenCodeRouterHealthViaOpenwork(openworkBaseUrl, openworkToken),
        onRouterTelegramIdentities: async () => {
          const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/identities/telegram`;
          const result = await fetchJson(url, {
            headers: {
              "X-OpenWork-Host-Token": openworkHostToken,
            },
          });
          const items = Array.isArray(result?.items) ? result.items : [];
          return { items };
        },
        onRouterSlackIdentities: async () => {
          const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/identities/slack`;
          const result = await fetchJson(url, {
            headers: {
              "X-OpenWork-Host-Token": openworkHostToken,
            },
          });
          const items = Array.isArray(result?.items) ? result.items : [];
          return { items };
        },
        onRouterSetGroupsEnabled: async (enabled) => {
          try {
            const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/config/groups`;
            await fetchJson(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-OpenWork-Host-Token": openworkHostToken,
              },
              body: JSON.stringify({ enabled }),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        onRouterSetTelegramToken: async (token) => {
          try {
            const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/identities/telegram`;
            await fetchJson(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-OpenWork-Host-Token": openworkHostToken,
              },
              body: JSON.stringify({ id: "default", token, enabled: true }),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
        onRouterSetSlackTokens: async (botToken, appToken) => {
          try {
            const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/identities/slack`;
            await fetchJson(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-OpenWork-Host-Token": openworkHostToken,
              },
              body: JSON.stringify({ id: "default", botToken, appToken, enabled: true }),
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      });
      tui.setUptimeStart(startedAt);
    } catch (error) {
      switchToPlainOutput(error instanceof Error ? error.message : String(error));
    }
  }

  const tuiServiceName = (name: string) => (name === "opencode-router" ? "router" : name);

  const handleExit = (name: string, code: number | null, signal: NodeJS.Signals | null) => {
    if (shuttingDown || detached) return;
    const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
    const services =
      name === "sandbox"
        ? ["opencode", "openwork-server", "router"]
        : [tuiServiceName(name)];
    for (const service of services) {
      tui?.updateService(service, { status: "stopped", message: reason });
    }
    logger.error("Process exited", { reason, code, signal }, name);
    void shutdown().then(() => process.exit(code ?? 1));
  };

  const handleSpawnError = (name: string, error: unknown) => {
    if (shuttingDown || detached) return;
    tui?.updateService(tuiServiceName(name), { status: "error", message: String(error) });
    logger.error("Process failed to start", { error: String(error) }, name);
    void shutdown().then(() => process.exit(1));
  };

  try {
    const opencodeActualVersion =
      sandboxMode !== "none" ? opencodeBinary.expectedVersion : await verifyOpencodeVersion(opencodeBinary);
    let openworkActualVersion: string | undefined;
    let opencodeClient: ReturnType<typeof createOpencodeClient>;

    if (sandboxMode !== "none") {
      const containerName = `openwork-orchestrator-${runId.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 24)}`;
      sandboxContainerName = containerName;

      sandboxStop = sandboxMode === "container" ? stopAppleContainer : stopDockerContainer;
      sandboxStopCommand = sandboxMode === "container" ? "container stop" : "docker stop";
      const opencodeInternalBaseUrl = `http://127.0.0.1:${SANDBOX_INTERNAL_OPENCODE_PORT}`;

      const runner = sandboxMode === "container" ? startAppleContainerSandbox : startDockerSandbox;
      const sandboxChild = await runner({
        image: sandboxImage,
        containerName,
        workspace: resolvedWorkspace,
        persistDir: sandboxPersistDir,
        opencodeConfigDir,
        extraMounts: sandboxExtraMounts,
        sidecars: {
          opencode: opencodeBinary.bin,
          openworkServer: openworkServerBinary.bin,
          opencodeRouter: opencodeRouterEnabled ? (opencodeRouterBinary?.bin ?? null) : null,
        },
        ports: {
          openwork: openworkPort,
          // In sandbox mode, opencodeRouter is only reachable via openwork-server
          // proxy (/opencode-router/*). Do not publish a separate host port.
          opencodeRouterHealth: null,
        },
        opencode: {
          corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
          username: opencodeUsername,
          password: opencodePassword,
          hotReload: opencodeHotReload,
        },
        openwork: {
          token: openworkToken,
          hostToken: openworkHostToken,
          approvalMode: approvalMode === "auto" ? "auto" : "manual",
          approvalTimeoutMs,
          readOnly,
          corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
          opencodeUsername,
          opencodePassword,
          logFormat,
        },
        runId,
        logFormat,
        detach: detachRequested,
        logger,
      });

      sandboxCleanup = sandboxChild.cleanup;
      tui?.updateService("opencode", { status: "running", port: SANDBOX_INTERNAL_OPENCODE_PORT });
      tui?.updateService("openwork-server", { status: "running", port: openworkPort });
      if (opencodeRouterEnabled) {
        tui?.updateService("router", { status: "running", port: undefined });
      }

      if (!detachRequested) {
        children.push({ name: "sandbox", child: sandboxChild.child });
        logger.info("Process spawned", { pid: sandboxChild.child.pid ?? 0, containerName }, "sandbox");
        sandboxChild.child.on("exit", (code, signal) => handleExit("sandbox", code, signal));
        sandboxChild.child.on("error", (error) => handleSpawnError("sandbox", error));
      } else {
        // docker run -d exits quickly; the container continues to run.
        logger.info("Sandbox detached", { containerName }, "sandbox");
      }

      logger.info("Waiting for health", { url: openworkBaseUrl }, "openwork-server");
      await waitForHealthy(openworkBaseUrl);
      logger.info("Healthy", { url: openworkBaseUrl }, "openwork-server");
      tui?.updateService("openwork-server", { status: "healthy" });

      opencodeClient = createOpencodeClient({
        baseUrl: `${openworkBaseUrl.replace(/\/$/, "")}/opencode`,
        headers: { Authorization: `Bearer ${openworkToken}` },
      });

      // In sandbox mode, the released openwork-server binary may not have our
      // latest proxy/auth changes yet.  Instead of using the OpenCode SDK client
      // (which relies on the proxy handling Bearer tokens), do a direct health
      // check against the openwork-server's own /opencode proxy path.  If the
      // server is healthy *and* is proxying to a healthy opencode, we're good.
      logger.info("Waiting for health (proxy)", { url: `${openworkBaseUrl}/opencode` }, "opencode");
      await waitForHealthyViaProxy(`${openworkBaseUrl.replace(/\/$/, "")}/opencode`, openworkToken);
      logger.info("Healthy (proxy)", { url: `${openworkBaseUrl}/opencode` }, "opencode");
      tui?.updateService("opencode", { status: "healthy" });

      try {
        openworkActualVersion = await verifyOpenworkServer({
          baseUrl: openworkBaseUrl,
          token: openworkToken,
          hostToken: openworkHostToken,
          expectedVersion: openworkServerBinary.expectedVersion,
          expectedWorkspace: "/workspace",
          expectedOpencodeBaseUrl: opencodeInternalBaseUrl,
          expectedOpencodeDirectory: "/workspace",
          expectedOpencodeUsername: opencodeUsername,
          expectedOpencodePassword: opencodePassword,
        });
      } catch (verifyError) {
        // In sandbox mode the released server binary may differ from the
        // expected version or lack capabilities we just added locally.  Log
        // the mismatch but don't abort — the health checks above already
        // proved the server is running and proxying correctly.
        logger.warn("Sandbox server verification warning (non-fatal)", { error: String(verifyError) }, "openwork-server");
      }
      logVerbose(`openwork-server version: ${openworkActualVersion ?? "unknown"}`);
    } else {
      const opencodeChild = await startOpencode({
        bin: opencodeBinary.bin,
        workspace: resolvedWorkspace,
        configDir: opencodeConfigDir,
        hotReload: opencodeHotReload,
        bindHost: opencodeBindHost,
        port: opencodePort,
        username: opencodeUsername,
        password: opencodePassword,
        corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
        logger,
        runId,
        logFormat,
        opencodeRouterHealthPort: opencodeRouterEnabled ? opencodeRouterHealthPort : undefined,
      });
      children.push({ name: "opencode", child: opencodeChild });
      tui?.updateService("opencode", {
        status: "running",
        pid: opencodeChild.pid ?? undefined,
        port: opencodePort,
      });
      logger.info("Process spawned", { pid: opencodeChild.pid ?? 0 }, "opencode");
      opencodeChild.on("exit", (code, signal) => handleExit("opencode", code, signal));
      opencodeChild.on("error", (error) => handleSpawnError("opencode", error));

      const authHeaders: Record<string, string> = {};
      if (opencodeUsername && opencodePassword) {
        authHeaders.Authorization = `Basic ${encodeBasicAuth(opencodeUsername, opencodePassword)}`;
      }
      opencodeClient = createOpencodeClient({
        baseUrl: opencodeBaseUrl,
        directory: resolvedWorkspace,
        headers: Object.keys(authHeaders).length ? authHeaders : undefined,
      });

      logger.info("Waiting for health", { url: opencodeBaseUrl }, "opencode");
      await waitForOpencodeHealthy(opencodeClient);
      logger.info("Healthy", { url: opencodeBaseUrl }, "opencode");
      tui?.updateService("opencode", { status: "healthy" });

      let opencodeRouterChild: ChildProcess | null = null;
      let opencodeRouterReady = false;
      if (opencodeRouterEnabled) {
        if (!opencodeRouterBinary) {
          throw new Error("OpenCodeRouter binary missing.");
        }
        opencodeRouterActualVersion = await verifyOpenCodeRouterVersion(opencodeRouterBinary);
        logVerbose(`opencodeRouter version: ${opencodeRouterActualVersion ?? "unknown"}`);

        try {
          opencodeRouterChild = await startOpenCodeRouter({
            bin: opencodeRouterBinary.bin,
            workspace: resolvedWorkspace,
            opencodeUrl: opencodeConnectUrl,
            opencodeUsername,
            opencodePassword,
            opencodeRouterHealthPort,
            opencodeRouterDataDir: opencodeRouterDataDir ?? undefined,
            logger,
            runId,
            logFormat,
          });
          children.push({ name: "opencode-router", child: opencodeRouterChild });
          tui?.updateService("router", {
            status: "running",
            pid: opencodeRouterChild.pid ?? undefined,
            port: opencodeRouterHealthPort,
          });
          logger.info("Process spawned", { pid: opencodeRouterChild.pid ?? 0 }, "opencode-router");
          opencodeRouterChild.on("exit", (code, signal) => {
            if (opencodeRouterRequired) {
              handleExit("opencode-router", code, signal);
              return;
            }
            const reason = code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
            tui?.updateService("router", { status: "stopped", message: reason });
            logger.warn("Process exited, continuing without opencodeRouter", { reason, code, signal }, "opencode-router");
          });
          opencodeRouterChild.on("error", (error) => handleSpawnError("opencode-router", error));

          const healthBaseUrl = `http://127.0.0.1:${opencodeRouterHealthPort}`;
          logger.info("Waiting for health", { url: healthBaseUrl }, "opencode-router");
          const health = await waitForOpenCodeRouterHealthy(healthBaseUrl, 10_000, 400);
          tui?.setRouterHealth(health);
          tui?.updateService("router", { status: health.ok ? "healthy" : "running" });
          logger.info("Healthy", { url: healthBaseUrl, ok: health.ok }, "opencode-router");
          opencodeRouterReady = true;
        } catch (error) {
          if (opencodeRouterRequired) {
            throw error;
          }
          const message = error instanceof Error ? error.message : String(error);
          logger.warn("OpenCodeRouter failed to start, continuing without it", { error: message }, "opencode-router");
          tui?.updateService("router", { status: "stopped", message });
          if (opencodeRouterChild) {
            try {
              opencodeRouterChild.kill();
            } catch {
              // ignore
            }
          }
          opencodeRouterChild = null;
          opencodeRouterReady = false;
        }
      }

      const openworkChild = await startOpenworkServer({
        bin: openworkServerBinary.bin,
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
        opencodeRouterHealthPort: opencodeRouterReady ? opencodeRouterHealthPort : undefined,
        opencodeRouterDataDir: opencodeRouterReady ? (opencodeRouterDataDir ?? undefined) : undefined,
        logger,
        runId,
        logFormat,
      });
      children.push({ name: "openwork-server", child: openworkChild });
      tui?.updateService("openwork-server", {
        status: "running",
        pid: openworkChild.pid ?? undefined,
        port: openworkPort,
      });
      logger.info("Process spawned", { pid: openworkChild.pid ?? 0 }, "openwork-server");
      openworkChild.on("exit", (code, signal) => handleExit("openwork-server", code, signal));
      openworkChild.on("error", (error) => handleSpawnError("openwork-server", error));

      logger.info("Waiting for health", { url: openworkBaseUrl }, "openwork-server");
      await waitForHealthy(openworkBaseUrl);
      logger.info("Healthy", { url: openworkBaseUrl }, "openwork-server");
      tui?.updateService("openwork-server", { status: "healthy" });

      openworkActualVersion = await verifyOpenworkServer({
        baseUrl: openworkBaseUrl,
        token: openworkToken,
        hostToken: openworkHostToken,
        expectedVersion: openworkServerBinary.expectedVersion,
        expectedWorkspace: resolvedWorkspace,
        expectedOpencodeBaseUrl: opencodeConnectUrl,
        expectedOpencodeDirectory: resolvedWorkspace,
        expectedOpencodeUsername: opencodeUsername,
        expectedOpencodePassword: opencodePassword,
      });
      logVerbose(`openwork-server version: ${openworkActualVersion ?? "unknown"}`);

      if (opencodeRouterReady && !opencodeRouterHealthInterval) {
        opencodeRouterHealthInterval = setInterval(() => {
          fetchOpenCodeRouterHealthViaOpenwork(openworkBaseUrl, openworkToken)
            .then((health) => {
              tui?.setRouterHealth(health);
              if (health.ok) {
                tui?.updateService("router", { status: "healthy" });
              }
            })
            .catch(() => undefined);
        }, 15_000);
      }
    }

    if (opencodeRouterEnabled) {
      if (sandboxMode !== "none") {
        // OpenCodeRouter is started inside the sandbox container; just probe health.
        opencodeRouterActualVersion = opencodeRouterBinary?.expectedVersion;
        logVerbose(`opencodeRouter version: ${opencodeRouterActualVersion ?? "unknown"}`);
        try {
          const url = `${openworkBaseUrl.replace(/\/$/, "")}/opencode-router/health`;
          logger.info("Waiting for health", { url }, "opencode-router");
          const health = await waitForOpenCodeRouterHealthyViaOpenwork(openworkBaseUrl, openworkToken);
          tui?.setRouterHealth(health);
          tui?.updateService("router", { status: health.ok ? "healthy" : "running" });
          logger.info("Healthy", { url, ok: health.ok }, "opencode-router");
        } catch (error) {
          logger.warn("OpenCodeRouter health check failed", { error: String(error) }, "opencode-router");
          tui?.updateService("router", { status: "running", message: String(error) });
        }
        if (!opencodeRouterHealthInterval) {
          opencodeRouterHealthInterval = setInterval(() => {
            fetchOpenCodeRouterHealthViaOpenwork(openworkBaseUrl, openworkToken)
              .then((health) => {
                tui?.setRouterHealth(health);
                if (health.ok) {
                  tui?.updateService("router", { status: "healthy" });
                }
              })
              .catch(() => undefined);
          }, 15_000);
        }
      } else {
        // In host mode, opencodeRouter is started before openwork-server so we can
        // confirm health before wiring the proxy.
      }
    }

    const payload = {
      runId,
      workspace: resolvedWorkspace,
      approval: {
        mode: approvalMode,
        timeoutMs: approvalTimeoutMs,
        readOnly,
      },
      opencode: {
        baseUrl: opencodeBaseUrl,
        connectUrl: opencodeConnectUrl,
        username: sandboxMode !== "none" ? undefined : opencodeUsername,
        password: sandboxMode !== "none" ? undefined : opencodePassword,
        bindHost: opencodeBindHost,
        port: opencodePort,
        hotReload: opencodeHotReload,
        version: opencodeActualVersion,
      },
      openwork: {
        baseUrl: openworkBaseUrl,
        connectUrl: openworkConnectUrl,
        host: openworkHost,
        port: openworkPort,
        token: openworkToken,
        hostToken: openworkHostToken,
        version: openworkActualVersion,
      },
      opencodeRouter: {
        enabled: opencodeRouterEnabled,
        version: opencodeRouterEnabled ? opencodeRouterActualVersion : undefined,
        healthPort: sandboxMode !== "none" ? null : opencodeRouterHealthPort,
      },
      diagnostics: {
        cliVersion,
        sidecar: {
          dir: sidecar.dir,
          baseUrl: sidecar.baseUrl,
          manifestUrl: sidecar.manifestUrl,
          target: sidecar.target,
          source: sidecarSource,
          opencodeSource,
          allowExternal,
        } as SidecarDiagnostics,
        binaries: {
          opencode: {
            path: opencodeBinary.bin,
            source: opencodeBinary.source,
            expectedVersion: opencodeBinary.expectedVersion,
            actualVersion: opencodeActualVersion,
          } as BinaryDiagnostics,
          openworkServer: {
            path: openworkServerBinary.bin,
            source: openworkServerBinary.source,
            expectedVersion: openworkServerBinary.expectedVersion,
            actualVersion: openworkActualVersion,
          } as BinaryDiagnostics,
          opencodeRouter: opencodeRouterBinary
            ? ({
                path: opencodeRouterBinary.bin,
                source: opencodeRouterBinary.source,
                expectedVersion: opencodeRouterBinary.expectedVersion,
                actualVersion: opencodeRouterActualVersion,
              } as BinaryDiagnostics)
            : null,
        },
      },
    };

    if (outputJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (useTui) {
      logger.info(
        "Ready",
        {
          workspace: payload.workspace,
          opencode: payload.opencode,
          openwork: payload.openwork,
          opencodeRouter: payload.opencodeRouter,
        },
        "openwork-orchestrator",
      );
    } else if (logFormat === "json") {
      logger.info(
        "Ready",
        {
          workspace: payload.workspace,
          opencode: payload.opencode,
          openwork: payload.openwork,
          opencodeRouter: payload.opencodeRouter,
        },
        "openwork-orchestrator",
      );
    } else {
      console.log("OpenWork orchestrator running");
      console.log(`Run ID: ${runId}`);
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

    if (detachRequested) {
      await handleDetach();
    }

    if (checkOnly) {
      try {
        if (sandboxMode !== "none") {
          // In sandbox mode the released server binary may not support the
          // Bearer-through-proxy auth that the OpenCode SDK client expects.
          // Run a lighter set of checks: openwork-server endpoints + proxy
          // health.  Full SDK checks (session create, SSE events) are deferred
          // until the modified server binary is released.
          await runSandboxChecks({
            openworkUrl: openworkBaseUrl,
            openworkToken,
            hostToken: openworkHostToken,
          });
        } else {
          await runChecks({
            opencodeClient,
            openworkUrl: openworkBaseUrl,
            openworkToken,
            hostToken: openworkHostToken,
            checkEvents,
          });
        }
        logger.info("Checks ok", { checkEvents }, "openwork-orchestrator");
        if (!outputJson && logFormat === "pretty") {
          console.log("Checks: ok");
        }
      } catch (error) {
        logger.error("Checks failed", { error: String(error) }, "openwork-orchestrator");
        await shutdown();
        tui?.stop();
        process.exit(1);
      }
      await shutdown();
      tui?.stop();
      process.exit(0);
    }

    process.on("SIGINT", () => shutdown().then(() => process.exit(0)));
    process.on("SIGTERM", () => shutdown().then(() => process.exit(0)));
    await new Promise(() => undefined);
  } catch (error) {
    await shutdown();
    tui?.stop();
    logger.error(
      "Run failed",
      { error: error instanceof Error ? error.message : String(error) },
      "openwork-orchestrator",
    );
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (readBool(args.flags, "help", false) || args.flags.get("help") === true) {
    printHelp();
    return;
  }
  if (readBool(args.flags, "version", false) || args.flags.get("version") === true) {
    console.log(await resolveCliVersion());
    return;
  }

  const command = args.positionals[0] ?? "start";
  if (command === "start") {
    await runStart(args);
    return;
  }
  if (command === "serve") {
    args.flags.set("tui", false);
    await runStart(args);
    return;
  }
  if (command === "daemon") {
    await runDaemonCommand(args);
    return;
  }
  if (command === "workspace" || command === "workspaces") {
    await runWorkspaceCommand(args);
    return;
  }
  if (command === "instance") {
    await runInstanceCommand(args);
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
