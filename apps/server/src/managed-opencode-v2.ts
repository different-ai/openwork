import type { EnginePermissionRule } from "./managed-policy-rules.js";
import { nativeModelVariants } from "@openwork/types/cloud-model-fast";
// Provider injection uses v2's watched config, without disposing live sessions.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendEngineOutputTail, createEngineStartupLineReader } from "./engine-output.js";

export { installOpencodeV2Binary } from "./opencode-v2-binary.js";

import { loopbackFetch } from "./server-fetch.js";

export function nativeCatalogIdentity(value: Record<string, unknown>) {
  const id = (value: unknown) => typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9._:@+/-]+$/.test(value) ? value : undefined;
  return {
    ...(id(value.upstreamModelId) ? { upstreamModelId: id(value.upstreamModelId) } : {}),
    ...(id(value.modelGroupId) ? { modelGroupId: id(value.modelGroupId) } : {}),
    ...(id(value.credentialSetId) ? { credentialSetId: id(value.credentialSetId) } : {}),
  };
}

export function nativeCatalogModelMetadata(config: Record<string, unknown>) {
  const released = typeof config.release_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(config.release_date)
    ? Date.parse(`${config.release_date}T00:00:00.000Z`) : NaN;
  return {
    ...nativeCatalogIdentity(config),
    ...(Number.isFinite(released) && new Date(released).toISOString().slice(0, 10) === config.release_date ? { time: { released } } : {}),
  };
}

type NativeModelCost = {
  input: number;
  output: number;
  cache?: { read?: number; write?: number };
  tier?: { type: "context"; size: number };
};

function nativeModelCosts(value: unknown): NativeModelCost[] {
  const rate = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const cost = (value: unknown) => {
    if (!isRecord(value) || !rate(value.input) || !rate(value.output)) return undefined;
    return { input: value.input, output: value.output,
      ...(rate(value.cache_read) || rate(value.cache_write) ? { cache: {
        ...(rate(value.cache_read) ? { read: value.cache_read } : {}),
        ...(rate(value.cache_write) ? { write: value.cache_write } : {}),
      } } : {}),
    };
  };
  const base = cost(value);
  const costs: NativeModelCost[] = base ? [base] : [];
  if (!isRecord(value)) return costs;
  if (Array.isArray(value.tiers)) {
    for (const entry of value.tiers) {
      const price = cost(entry);
      const tier = isRecord(entry) && isRecord(entry.tier) ? entry.tier : undefined;
      if (price && tier?.type === "context" && typeof tier.size === "number" && Number.isSafeInteger(tier.size) && tier.size >= 0) {
        costs.push({ ...price, tier: { type: "context", size: tier.size } });
      }
    }
  } else {
    const price = cost(value.context_over_200k);
    if (price) costs.push({ ...price, tier: { type: "context", size: 200_000 } });
  }
  return costs;
}

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
  /** Mandatory native hosts opt into skill-directory config; previews do not. */
  nativeSkills?: boolean;
  nativeCatalogMetadata?: boolean;
  cwd?: string;
  hostname?: string;
  port?: number;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
  bootTimeoutMs?: number;
  expectedVersion?: string;
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
  isAlive(): boolean;
  health(): Promise<OpencodeV2Health>;
  fetchJson(path: string, init?: { method?: string; body?: unknown; directory?: string; timeoutMs?: number }): Promise<{ status: number; json: unknown }>;
  injectProvider(spec: OpencodeV2ProviderSpec): Promise<void>;
  setProviders(specs: OpencodeV2ProviderSpec[]): Promise<void>;
  /** Extra absolute skill directories registered through native config `skills`. */
  setSkills(directories: string[]): Promise<void>;
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

/** The whole generated engine config: every writer emits all current keys. */
export function renderOpencodeV2Config(input: {
  providers: OpencodeV2ProviderSpec[];
  permissions?: EnginePermissionRule[];
  skills: string[];
  nativeCatalogMetadata?: boolean;
}): Record<string, unknown> {
  const providerConfig: Record<string, unknown> = {};
  for (const provider of input.providers) {
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
          output: config.reasoning === true
            ? [...new Set([...(Array.isArray(modalities.output) ? modalities.output : ["text"]), "reasoning"])]
            : modalities.output ?? ["text"],
        },
        limit: config.limit ?? { context: 128_000, output: 8_192 },
        ...(typeof config.family === "string" ? { family: config.family } : {}),
        ...(input.nativeCatalogMetadata ? { cost: nativeModelCosts(config.cost) } : {}),
        ...(isRecord(config.options) ? { settings: config.options } : {}),
        ...(isRecord(config.variants) ? {
          variants: nativeModelVariants(config.variants, provider.package),
        } : {}),
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
  return {
    $schema: "https://opencode.ai/config.json",
    providers: providerConfig,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    ...(input.skills.length ? { skills: [...input.skills] } : {}),
  };
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
  let skills: string[] = [];
  let writes: Promise<void> = Promise.resolve();
  const opencodeModelsUrl = (options.env?.OPENCODE_MODELS_URL ?? process.env.OPENCODE_MODELS_URL)?.replace(/\/+$/, "");
  // The engine needs OS paths and locale settings, not the server's provider,
  // cloud, database, or control-plane credentials. Unknown keys stay private.
  const inherited: Record<string, string> = {};
  for (const key of [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
    "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "CI",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
    "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  ]) {
    const value = options.env?.[key] ?? process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  await mkdir(options.rootDir, { recursive: true, mode: 0o700 });
  await chmod(options.rootDir, 0o700);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await chmod(configDir, 0o700);
  // Replace the generated config before boot, removing stale managed-policy
  // registrations while retaining independent engine permissions. Leave the
  // old entrypoint on disk: another configuration may still reference it.
  // Boot registers no skill directories: a stale materialized root is never
  // visible until a fresh cloud skill sync succeeds.
  await writeConfig();
  const child = spawn(options.bin, ["serve", "--hostname", hostname, "--port", String(port)], {
    cwd: options.cwd,
    env: {
      ...inherited,
      // Only the embedding host can opt additional keys into this child. Engine
      // identity and state paths below cannot be replaced by that environment.
      ...options.env,
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
  let announced: string | undefined;
  const lines = createEngineStartupLineReader((line) => {
    announced = line.match(/server listening on (http:\/\/[^\s]+)/)?.[1];
    if (announced) lines.stop();
  });
  // A close event, unlike exit, includes the final bytes from both pipes.
  let closed = false;
  const closedPromise = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.once("close", () => {
    closed = true;
    lines.stop();
  });
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    stdout = appendEngineOutputTail(stdout, text);
    lines.write(text);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendEngineOutputTail(stderr, String(chunk));
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

  // Every rewrite (providers, permissions, skills) serializes through one
  // queue and emits the whole current state, so no writer drops another's keys.
  function writeConfig(): Promise<void> {
    const next = writes.catch(() => undefined).then(writeConfigNow);
    writes = next;
    return next;
  }

  async function writeConfigNow(): Promise<void> {
    const target = join(configDir, "opencode.json");
    const temporary = `${target}.tmp-${randomBytes(8).toString("hex")}`;
    const { skills: configuredSkills, ...hostConfig } = options.config ?? {};
    const generated = renderOpencodeV2Config({
      providers: [...providers.values()],
      nativeCatalogMetadata: options.nativeCatalogMetadata,
      ...(options.permissions ? { permissions: await options.permissions() } : {}),
      skills,
    });
    await writeFile(temporary, `${JSON.stringify({
      ...hostConfig,
      ...generated,
      ...((Array.isArray(configuredSkills) && configuredSkills.length) || skills.length
        ? { skills: [...(Array.isArray(configuredSkills) ? configuredSkills : []), ...skills] } : {}),
      providers: { ...(isRecord(hostConfig.providers) ? hostConfig.providers : {}), ...(isRecord(generated.providers) ? generated.providers : {}) },
      ...(options.permissions ? { permissions: [
        ...(Array.isArray(hostConfig.permissions) ? hostConfig.permissions : []),
        ...(Array.isArray(generated.permissions) ? generated.permissions : []),
      ] } : {}),
    }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }

  async function close(): Promise<void> {
    lines.stop();
    if (child.connected) child.disconnect();
    if (closed) return;
    const waitForClose = async (timeoutMs: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          closedPromise.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
      } finally { clearTimeout(timer); }
    };
    if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (!await waitForClose(2_000)) {
      if (child.pid && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (!await waitForClose(2_000)) throw new Error("OpenCode v2 shutdown did not complete");
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
    isAlive: () => !closed && !spawnError && child.pid !== undefined && child.exitCode === null && child.signalCode === null,
    health,
    fetchJson,
    async injectProvider(spec) {
      providers.set(spec.id, spec);
      await writeConfig();
    },
    async setProviders(specs) {
      providers.clear();
      for (const spec of specs) {
        providers.set(spec.id, spec);
      }
      await writeConfig();
    },
    async setSkills(directories) {
      skills = [...directories];
      await writeConfig();
    },
    close,
  };

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError !== undefined) {
      await close();
      throw new Error(`Failed to start OpenCode v2 server: ${spawnError.message}\nstdout:\n${stdout.slice(-4_000)}\nstderr:\n${stderr.slice(-4_000)}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      if (closed) throw diagnostics(child.exitCode, stdout, stderr);
      await sleep(250);
      continue;
    }
    // Only the child can write its stdout pipe. Do not send the generated
    // credential to a probed port before that child confirms it has bound.
    if (!url && announced) {
      try {
        const endpoint = new URL(announced);
        if (endpoint.hostname !== hostname || !endpoint.port || endpoint.port === "0"
          || endpoint.username || endpoint.password || endpoint.pathname !== "/"
          || endpoint.search || endpoint.hash
          || (port !== 0 && Number(endpoint.port) !== port)) {
          throw new Error("OpenCode v2 announced an unexpected listener");
        }
        url = endpoint.origin;
      } catch (error) {
        await close();
        throw error;
      }
    }
    let state: OpencodeV2Health | undefined;
    try {
      state = await health();
    } catch {
      // The engine can return 503 or refuse connections while booting.
    }
    if (state && options.expectedVersion && state.version !== options.expectedVersion) {
      await close();
      throw new Error(`OpenCode v2 version mismatch: expected ${options.expectedVersion}, received ${state.version}`);
    }
    if (state?.healthy) return managed;
    await sleep(250);
  }

  const exited = child.exitCode !== null || child.signalCode !== null;
  await close();
  if (exited) throw diagnostics(child.exitCode, stdout, stderr);
  throw new Error(`Timed out waiting ${bootTimeoutMs}ms for OpenCode v2 health\nstdout:\n${stdout.slice(-4_000)}\nstderr:\n${stderr.slice(-4_000)}`);
}
