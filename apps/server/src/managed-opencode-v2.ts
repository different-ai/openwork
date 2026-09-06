import { managedPolicyPluginPath } from "./managed-policy-plugin.js";
import type { EnginePermissionRule } from "./managed-policy-rules.js";
// Parallel v2 lane prototype: provider injection is a watched-config write. This module
// deliberately has no reload/dispose call, unlike managed-opencode.ts and server.ts reloadOpencodeEngine.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export { installOpencodeV2Binary } from "./opencode-v2-binary.js";

import { loopbackFetch } from "./server-fetch.js";

export interface OpencodeV2ModelSpec {
  id: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface OpencodeV2ProviderSpec {
  id: string;
  name: string;
  baseUrl?: string;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  apiKey: string;
  models: OpencodeV2ModelSpec[];
}

export interface ManagedOpencodeV2ServerOptions {
  bin: string;
  rootDir: string;
  hostname?: string;
  port?: number;
  env?: Record<string, string>;
  bootTimeoutMs?: number;
  permissions?: () => Promise<EnginePermissionRule[]>;
}

export interface OpencodeV2Health {
  healthy: boolean;
  version: string;
  pid: number;
}

export interface ManagedOpencodeV2Server {
  url: string;
  username: string;
  password: string;
  childPid: number | undefined;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  health(): Promise<OpencodeV2Health>;
  fetchJson(path: string, init?: { method?: string; body?: unknown; directory?: string; timeoutMs?: number }): Promise<{ status: number; json: unknown }>;
  injectProvider(spec: OpencodeV2ProviderSpec): Promise<void>;
  setProviders(specs: OpencodeV2ProviderSpec[]): Promise<void>;
  close(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diagnostics(exitCode: number | null, stdout: string, stderr: string): Error {
  const tail = (value: string) => value.slice(-4_000);
  return new Error(
    `OpenCode v2 server exited with code ${String(exitCode)}\nstdout:\n${tail(stdout)}\nstderr:\n${tail(stderr)}`,
  );
}

export async function createManagedOpencodeV2Server(
  options: ManagedOpencodeV2ServerOptions,
): Promise<ManagedOpencodeV2Server> {
  const hostname = options.hostname ?? "127.0.0.1";
  const port = options.port ?? 0;
  const bootTimeoutMs = options.bootTimeoutMs ?? 60_000;
  const configDir = join(options.rootDir, "config");
  const password = randomBytes(24).toString("base64url");
  const username = "opencode";
  let url = "";
  const providers = new Map<string, OpencodeV2ProviderSpec>();
  const opencodeModelsUrl = (options.env?.OPENCODE_MODELS_URL ?? process.env.OPENCODE_MODELS_URL)?.replace(/\/+$/, "");
  // The engine needs OS paths and locale settings, not the server's provider,
  // cloud, database, or control-plane credentials. Unknown keys stay private.
  const inherited: Record<string, string> = {};
  for (const key of [
    "OPENWORK_SERVER_URL", "OPENWORK_SERVER_TOKEN",
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "CI",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]) {
    const value = options.env?.[key] ?? process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  // A caller may deliberately provide a config file; never inherit the server's
  // OPENCODE_CONFIG or OPENCODE_PURE settings implicitly.
  if (options.env?.OPENCODE_CONFIG) inherited.OPENCODE_CONFIG = options.env.OPENCODE_CONFIG;

  await mkdir(options.rootDir, { recursive: true, mode: 0o700 });
  await chmod(options.rootDir, 0o700);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  // Load enforcement on the first boot, before any session can run.
  await writeProviders();
  const child = spawn(options.bin, ["serve", "--hostname", hostname, "--port", String(port)], {
    env: {
      ...inherited,
      OPENCODE_PASSWORD: password,
      OPENCODE_DB: join(options.rootDir, "opencode.db"),
      OPENCODE_CONFIG_DIR: configDir,
      ...(opencodeModelsUrl === undefined ? {} : { OPENCODE_MODELS_URL: opencodeModelsUrl }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  child.on("error", (error) => {
    spawnError = error;
  });

  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  async function fetchJson(
    path: string,
    init: { method?: string; body?: unknown; directory?: string; timeoutMs?: number } = {},
  ): Promise<{ status: number; json: unknown }> {
    if (!url) throw new Error("OpenCode v2 has not announced its listener");
    const separator = path.includes("?") ? "&" : "?";
    const requestPath = init.directory === undefined
      ? path
      : `${path}${separator}location%5Bdirectory%5D=${encodeURIComponent(init.directory)}`;
    const response = await loopbackFetch(`${url}${requestPath}`, {
      method: init.method,
      headers: {
        authorization,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.timeoutMs === undefined ? undefined : AbortSignal.timeout(init.timeoutMs),
    });
    const text = await response.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON engine responses remain observable as raw text.
    }
    return { status: response.status, json };
  }

  async function health(): Promise<OpencodeV2Health> {
    const response = await fetchJson("/api/health", { timeoutMs: 5_000 });
    if (response.status !== 200 || !isRecord(response.json)) {
      throw new Error(`OpenCode v2 health returned HTTP ${response.status}`);
    }
    const { healthy, version, pid } = response.json;
    if (typeof healthy !== "boolean" || typeof version !== "string" || typeof pid !== "number") {
      throw new Error("OpenCode v2 health returned an invalid payload");
    }
    if (pid !== child.pid) throw new Error("OpenCode v2 health did not match the spawned child");
    return { healthy, version, pid };
  }

  async function writeProviders(): Promise<void> {
    const providerConfig: Record<string, unknown> = {};
    for (const provider of providers.values()) {
      const models: Record<string, unknown> = {};
      for (const model of provider.models) {
        const config = model.config ?? {};
        const modalities = isRecord(config.modalities) ? config.modalities : {};
        models[model.id] = {
          name: model.name,
          ...(typeof config.id === "string" ? { modelID: config.id } : {}),
          capabilities: {
            tools: typeof config.tool_call === "boolean" ? config.tool_call : true,
            input: modalities.input ?? ["text"],
            output: modalities.output ?? ["text"],
          },
          limit: config.limit ?? { context: 128_000, output: 8_192 },
          ...(typeof config.family === "string" ? { family: config.family } : {}),
          ...(isRecord(config.options) ? { settings: config.options } : {}),
          ...(isRecord(config.headers) ? { headers: config.headers } : {}),
          ...(config.status === "deprecated" ? { disabled: true } : {}),
        };
      }
      providerConfig[provider.id] = {
        name: provider.name,
        package: provider.package ?? "@opencode-ai/ai/providers/openai-compatible",
        settings: {
          ...provider.settings,
          ...(provider.baseUrl ? { baseURL: provider.baseUrl } : {}),
          apiKey: provider.apiKey,
          name: provider.id,
        },
        ...(provider.headers ? { headers: provider.headers } : {}),
        models,
      };
    }
    const target = join(configDir, "opencode.json");
    const temporary = `${target}.tmp-${randomBytes(8).toString("hex")}`;
    await writeFile(temporary, `${JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      providers: providerConfig,
      ...(options.permissions ? { permissions: await options.permissions() } : {}),
      ...(options.env?.OPENWORK_SERVER_URL ? { plugins: [managedPolicyPluginPath(true)] } : {}),
    }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async function close(): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const exited = await Promise.race([
      exit.then(() => true),
      sleep(2_000).then(() => false),
    ]);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
  }

  const managed: ManagedOpencodeV2Server = {
    get url() { return url; },
    username,
    password,
    childPid: child.pid,
    get exitCode() {
      return child.exitCode;
    },
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    health,
    fetchJson,
    async injectProvider(spec) {
      providers.set(spec.id, spec);
      await writeProviders();
    },
    async setProviders(specs) {
      providers.clear();
      for (const spec of specs) {
        providers.set(spec.id, spec);
      }
      await writeProviders();
    },
    close,
  };

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      await close();
      throw new Error(`Failed to start OpenCode v2 server: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) throw diagnostics(child.exitCode, stdout, stderr);
    // Only the child can write its stdout pipe. Do not send the generated
    // credential to a probed port before that child confirms it has bound.
    if (!url) {
      const announced = stdout.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
      if (announced) {
        const endpoint = new URL(announced);
        if (endpoint.hostname !== hostname || !endpoint.port || endpoint.port === "0"
          || endpoint.username || endpoint.password || endpoint.pathname !== "/"
          || endpoint.search || endpoint.hash
          || (port !== 0 && Number(endpoint.port) !== port)) {
          await close();
          throw new Error("OpenCode v2 announced an unexpected listener");
        }
        url = endpoint.origin;
      }
    }
    try {
      const state = await health();
      if (state.healthy) return managed;
    } catch {
      // The engine can return 503 or refuse connections while booting.
    }
    await sleep(250);
  }

  await close();
  throw new Error(`Timed out waiting ${bootTimeoutMs}ms for OpenCode v2 health\nstdout:\n${stdout.slice(-4_000)}\nstderr:\n${stderr.slice(-4_000)}`);
}
