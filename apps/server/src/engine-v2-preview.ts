import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import constants from "../../../constants.json" with { type: "json" };
import {
  createManagedOpencodeV2Server,
  installOpencodeV2Binary,
  type ManagedOpencodeV2Server,
  type OpencodeV2ProviderSpec,
} from "./managed-opencode-v2.js";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";
import { runtimeStorageDir } from "./runtime-db.js";
import {
  isEngineGlobalRuntimeConfigId,
  onRuntimeOpencodeConfigWrite,
  readGlobalRuntimeOpencodeConfig,
  readEffectiveRuntimeOpencodeConfig,
  runtimeMcpMap,
  runtimeProviderMap,
} from "./runtime-opencode-config-store.js";
import type { EnvService } from "./env-file.js";
import { selectPrimaryCredentialEnvName } from "./managed-provider-auth.js";
import type { ServerConfig } from "./types.js";

const OPENCODE_V2_VERSION = constants.opencodeV2Version;
const PREVIEW_STATE_FILE = "engine-v2-preview.json";
const UNSET_API_KEY = "openwork-engine-v2-preview-unset";
// A cold sidecar can return HTTP 503 while its model catalog initializes for 17–20 seconds.
const CATALOG_MIRROR_TIMEOUT_MS = 60_000;

export interface EngineV2PreviewStatus {
  enabled: boolean;
  chatRouting: boolean;
  running: boolean;
  version?: string;
  pid?: number;
  binSource?: "env" | "path" | "cache";
  mirroredProviderIds: string[];
  skippedProviderIds: string[];
  catalogModelIds: string[];
  lastMirroredAt?: string;
  lastError?: string;
}

export interface RuntimeProviderRecordLike {
  name?: string;
  npm?: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
  };
  models?: Record<string, unknown>;
}

export interface EngineV2Preview {
  status(): EngineV2PreviewStatus;
  setEnabled(enabled: boolean): Promise<EngineV2PreviewStatus>;
  setChatRouting(chatRouting: boolean): Promise<EngineV2PreviewStatus>;
  connection(): { url: string; username: string; password: string } | undefined;
  ensureWorkspaceReady(directory: string): Promise<void>;
  syncWorkspaceMcp(workspaceId: string, directory: string): Promise<void>;
  stop(): Promise<void>;
}

export interface EngineV2PreviewState {
  enabled: boolean;
  chatRouting?: boolean;
}

export function resolveInitialEngineV2PreviewState(
  env: NodeJS.ProcessEnv,
  persisted: EngineV2PreviewState,
): EngineV2PreviewState {
  const override = env.OPENWORK_ENGINE_V2_PREVIEW;
  if (override === "1" || override === "chat") return { enabled: true, chatRouting: true };
  if (override === "sidecar") return { enabled: true, chatRouting: false };
  return persisted;
}

interface ResolvedBinary {
  bin: string;
  source: "env" | "path" | "cache";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), PREVIEW_STATE_FILE);
}

export function readEngineV2PreviewState(config: ServerConfig): EngineV2PreviewState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(config), "utf8"));
    if (
      !isRecord(parsed)
      || typeof parsed.enabled !== "boolean"
      || (parsed.chatRouting !== undefined && typeof parsed.chatRouting !== "boolean")
    ) {
      return { enabled: false, chatRouting: false };
    }
    return { enabled: parsed.enabled, chatRouting: parsed.chatRouting === true };
  } catch {
    return { enabled: false, chatRouting: false };
  }
}

export async function writeEngineV2PreviewState(
  config: ServerConfig,
  state: EngineV2PreviewState,
): Promise<void> {
  await mkdir(runtimeStorageDir(config), { recursive: true });
  await writeFile(statePath(config), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function exec(file: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function resolveBinary(config: ServerConfig): Promise<ResolvedBinary> {
  const override = process.env.OPENWORK_OPENCODE2_BIN?.trim();
  if (override) return { bin: override, source: "env" };

  let pathError = "not found";
  try {
    await exec("opencode2", ["--version"]);
    return { bin: "opencode2", source: "path" };
  } catch (error) {
    pathError = errorMessage(error);
  }

  try {
    const binary = await installOpencodeV2Binary(join(runtimeStorageDir(config), "opencode-v2-verified"), OPENCODE_V2_VERSION);
    return { bin: binary, source: "cache" };
  } catch (error) {
    throw new Error(
      `Unable to resolve OpenCode v2 (${pathError}; verified download: ${errorMessage(error)}). Set OPENWORK_OPENCODE2_BIN to a working opencode2 binary.`,
    );
  }
}

export function mapRuntimeProvidersToV2Specs(
  providerMap: Record<string, unknown>,
  storedCredentials: ReadonlyMap<string, string> = new Map(),
): { specs: OpencodeV2ProviderSpec[]; skippedProviderIds: string[] } {
  const specs: OpencodeV2ProviderSpec[] = [];
  const skippedProviderIds: string[] = [];

  for (const [id, value] of Object.entries(providerMap)) {
    if (!isRecord(value)) {
      skippedProviderIds.push(id);
      continue;
    }
    // Only built-in adapters: do not turn organization configuration into a
    // request to install an arbitrary runtime package.
    const packages: Record<string, string> = {
      "@ai-sdk/openai": "@opencode-ai/ai/providers/openai",
      "@ai-sdk/anthropic": "@opencode-ai/ai/providers/anthropic",
      "@openrouter/ai-sdk-provider": "@opencode-ai/ai/providers/openrouter",
      "@ai-sdk/openai-compatible": "@opencode-ai/ai/providers/openai-compatible",
    };
    const options = isRecord(value.options) ? value.options : {};
    // Catalog `api` metadata may use only the native adapter's trusted origin.
    // Custom destinations must use the existing explicit options.baseURL path.
    const explicitBaseUrl = typeof options.baseURL === "string" && options.baseURL.trim()
      ? options.baseURL : undefined;
    if (!explicitBaseUrl && value.api !== undefined) {
      const nativeOrigins: Record<string, string> = {
        "@ai-sdk/openai": "https://api.openai.com",
        "@ai-sdk/anthropic": "https://api.anthropic.com",
        "@openrouter/ai-sdk-provider": "https://openrouter.ai",
      };
      let trusted = false;
      try {
        const url = new URL(typeof value.api === "string" ? value.api : "");
        trusted = typeof value.npm === "string" && Object.hasOwn(nativeOrigins, value.npm)
          && url.origin === nativeOrigins[value.npm] && !url.username && !url.password;
      } catch { /* Invalid endpoint metadata is never mirrored. */ }
      if (!trusted) { skippedProviderIds.push(id); continue; }
    }
    const endpoint = explicitBaseUrl ?? value.api;
    const baseUrl = typeof endpoint === "string" && endpoint.trim() ? endpoint : undefined;
    const packageName = typeof value.npm === "string" && Object.hasOwn(packages, value.npm) ? packages[value.npm] : undefined;
    if ((value.npm !== undefined && !packageName)
      || (!baseUrl && (!packageName || value.npm === "@ai-sdk/openai-compatible"))) {
      skippedProviderIds.push(id);
      continue;
    }
    const { apiKey, baseURL, headers, ...settings } = options;
    const envNames = Array.isArray(value.env)
      ? value.env.filter((name): name is string => typeof name === "string") : [];
    const credentialName = selectPrimaryCredentialEnvName(envNames, storedCredentials.keys());
    const storedKey = credentialName ? storedCredentials.get(credentialName) : undefined;
    // Resolve only this provider's declared credential, never inherit the
    // server environment or copy unrelated secrets into the sidecar.
    const explicitKey = typeof apiKey === "string" && apiKey.trim() !== "" && !apiKey.includes("{env:") ? apiKey : undefined;
    const resolvedKey = explicitKey ?? storedKey;
    if (envNames.length > 0 && !resolvedKey) {
      skippedProviderIds.push(id);
      continue;
    }
    const models = isRecord(value.models)
      ? Object.entries(value.models)
        .map(([modelId, model]) => ({
          id: modelId,
          name: isRecord(model) && typeof model.name === "string" ? model.name : modelId,
          ...(isRecord(model) ? { config: model } : {}),
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
      : [];
    specs.push({
      id,
      name: typeof value.name === "string" ? value.name : id,
      ...(baseUrl ? { baseUrl } : {}),
      ...(packageName ? { package: packageName } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(isRecord(headers) ? { headers } : {}),
      apiKey: resolvedKey ?? UNSET_API_KEY,
      models,
    });
  }

  specs.sort((left, right) => left.id.localeCompare(right.id));
  skippedProviderIds.sort((left, right) => left.localeCompare(right));
  return { specs, skippedProviderIds };
}

function catalogModelIds(payload: unknown, mirroredProviderIds: string[]): string[] {
  const mirrored = new Set(mirroredProviderIds);
  const ids = new Set<string>();

  function visit(value: unknown, withinMirroredProvider: boolean): void {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, withinMirroredProvider);
      return;
    }
    if (!isRecord(value)) return;

    const providerId = typeof value.providerID === "string"
      ? value.providerID
      : typeof value.providerId === "string"
        ? value.providerId
        : undefined;
    const withinProvider = withinMirroredProvider || (providerId !== undefined && mirrored.has(providerId));
    if (withinProvider && typeof value.id === "string" && !mirrored.has(value.id)) ids.add(value.id);
    if (withinProvider && isRecord(value.models)) {
      for (const modelId of Object.keys(value.models)) ids.add(modelId);
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, withinProvider || mirrored.has(key));
    }
  }

  visit(payload, false);
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/** Translate only fields supported by the pinned v2 MCP API. */
export function mapRuntimeMcpToV2(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.enabled === false || value.disabled === true) return undefined;
  const shared = {
    ...(typeof value.codemode === "boolean" ? { codemode: value.codemode } : {}),
    ...(typeof value.timeout === "number" && value.timeout > 0
      ? { timeout: { startup: value.timeout, catalog: value.timeout, execution: value.timeout } } : {}),
  };
  const strings = (input: unknown) => isRecord(input)
    ? Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  if (value.type === "local" && Array.isArray(value.command)
    && value.command.length > 0 && value.command.every((part) => typeof part === "string" && part.trim())) {
    return { type: "local", command: value.command, environment: strings(value.environment),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}), ...shared };
  }
  if (value.type !== "remote" || typeof value.url !== "string" || !/^https?:\/\//i.test(value.url)) return undefined;
  const oauth = isRecord(value.oauth) ? {
    ...(typeof value.oauth.clientId === "string" ? { client_id: value.oauth.clientId } : {}),
    ...(typeof value.oauth.clientSecret === "string" ? { client_secret: value.oauth.clientSecret } : {}),
    ...(typeof value.oauth.scope === "string" ? { scope: value.oauth.scope } : {}),
  } : value.oauth === false ? false : undefined;
  return { type: "remote", url: value.url, headers: strings(value.headers),
    ...(oauth === undefined ? {} : { oauth }), ...shared };
}

export function createEngineV2Preview(options: { config: ServerConfig; env?: Pick<EnvService, "list" | "onChange"> }): EngineV2Preview {
  const { config } = options;
  const rootDir = join(runtimeStorageDir(config), "opencode-v2", "state");
  const workspaceDir = join(rootDir, "workspace");
  const initialState = resolveInitialEngineV2PreviewState(process.env, readEngineV2PreviewState(config));
  let enabled = initialState.enabled;
  let chatRouting = initialState.chatRouting === true;
  let allowRunning = true;
  let running = false;
  let version: string | undefined;
  let pid: number | undefined;
  let binSource: EngineV2PreviewStatus["binSource"];
  let mirroredProviderIds: string[] = [];
  let skippedProviderIds: string[] = [];
  let currentCatalogModelIds: string[] = [];
  let lastMirroredAt: string | undefined;
  let lastError: string | undefined;
  let sidecar: ManagedOpencodeV2Server | undefined;
  let unsubscribe: (() => void) | undefined;
  let startPromise: Promise<void> | undefined;
  let mirrorInFlight: Promise<void> | undefined;
  let mirrorDirty = false;
  const workspaceReadiness = new Map<string, Promise<void>>();
  let mirroredSpecs: OpencodeV2ProviderSpec[] = [];
  const workspaceMcp = new Map<string, Map<string, string>>();
  const mcpInFlight = new Map<string, Promise<void>>();

  async function syncWorkspaceMcp(workspaceId: string, directory: string): Promise<void> {
    // Serialize each location, then re-read authoritative state. A queued call
    // must not reuse a snapshot taken before a removal or credential update.
    const previous = mcpInFlight.get(directory);
    const pending = (async () => {
      if (previous) await previous.catch(() => undefined);
      const active = sidecar;
      if (!active) throw new Error("OpenCode v2 is not running");
      const runtime = runtimeMcpMap(await readEffectiveRuntimeOpencodeConfig(config, workspaceId));
      const desired = new Map(Object.entries(runtime).flatMap(([name, value]) => {
        const mapped = mapRuntimeMcpToV2(value);
        return mapped ? [[name, mapped] as const] : [];
      }));
      const applied = workspaceMcp.get(directory) ?? new Map<string, string>();
      workspaceMcp.set(directory, applied);
      // Remove first so a failed replacement cannot leave an old credential or
      // revoked tool active. Only touch registrations owned by this mirror.
      for (const [name, fingerprint] of applied) {
        if (desired.has(name) && JSON.stringify(desired.get(name)) === fingerprint) continue;
        const result = await active.fetchJson(`/api/mcp/${encodeURIComponent(name)}`, {
          method: "DELETE", directory, timeoutMs: 15_000,
        });
        if (result.status !== 204 && result.status !== 404) throw new Error(`OpenCode v2 MCP removal failed (${result.status})`);
        applied.delete(name);
      }
      for (const [name, mcpConfig] of desired) {
        const fingerprint = JSON.stringify(mcpConfig);
        if (applied.get(name) === fingerprint) continue;
        const result = await active.fetchJson(`/api/mcp/${encodeURIComponent(name)}`, {
          method: "PUT", body: { config: mcpConfig }, directory, timeoutMs: 30_000,
        });
        if (result.status !== 204) throw new Error(`OpenCode v2 MCP registration failed (${result.status})`);
        applied.set(name, fingerprint);
      }
    })();
    mcpInFlight.set(directory, pending);
    try { await pending; }
    finally { if (mcpInFlight.get(directory) === pending) mcpInFlight.delete(directory); }
  }

  function status(): EngineV2PreviewStatus {
    return {
      enabled,
      chatRouting,
      running,
      ...(version === undefined ? {} : { version }),
      ...(pid === undefined ? {} : { pid }),
      ...(binSource === undefined ? {} : { binSource }),
      mirroredProviderIds: [...mirroredProviderIds],
      skippedProviderIds: [...skippedProviderIds],
      catalogModelIds: [...currentCatalogModelIds],
      ...(lastMirroredAt === undefined ? {} : { lastMirroredAt }),
      ...(lastError === undefined ? {} : { lastError }),
    };
  }

  async function mirrorProviders(): Promise<void> {
    const active = sidecar;
    if (!active) return;
    const providerMap = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config));
    const credentials = new Map((await options.env?.list() ?? []).map((entry) => [entry.key, entry.value]));
    const mapped = mapRuntimeProvidersToV2Specs(providerMap, credentials);
    const nextMirroredProviderIds = mapped.specs.map((spec) => spec.id);
    await active.setProviders(mapped.specs);
    mirroredSpecs = mapped.specs;
    workspaceReadiness.clear();
    mirroredProviderIds = nextMirroredProviderIds;
    skippedProviderIds = [...mapped.skippedProviderIds];
    lastMirroredAt = new Date().toISOString();
    const expectedModelIds = mapped.specs.flatMap((spec) => spec.models.map((model) => model.id));
    const deadline = Date.now() + CATALOG_MIRROR_TIMEOUT_MS;
    let catalog = await active.fetchJson("/api/model", { directory: workspaceDir });
    let nextCatalogModelIds = catalogModelIds(catalog.json, nextMirroredProviderIds);
    while (expectedModelIds.some((modelId) => !nextCatalogModelIds.includes(modelId)) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      catalog = await active.fetchJson("/api/model", { directory: workspaceDir });
      nextCatalogModelIds = catalogModelIds(catalog.json, nextMirroredProviderIds);
    }
    currentCatalogModelIds = nextCatalogModelIds;
    const missingModelIds = expectedModelIds.filter((modelId) => !nextCatalogModelIds.includes(modelId));
    const catalogMessage = isRecord(catalog.json) && typeof catalog.json.message === "string"
      ? ` ${catalog.json.message}`
      : "";
    lastError = missingModelIds.length === 0
      ? undefined
      : `catalog missing [${missingModelIds.join(", ")}] after ${CATALOG_MIRROR_TIMEOUT_MS}ms: ${catalog.status}${catalogMessage}`;
  }

  function scheduleMirror(): void {
    mirrorDirty = true;
    if (mirrorInFlight) return;
    mirrorInFlight = (async () => {
      try {
        while (mirrorDirty && allowRunning && sidecar) {
          mirrorDirty = false;
          try {
            await mirrorProviders();
          } catch (error) {
            lastError = errorMessage(error);
          }
        }
      } finally {
        mirrorInFlight = undefined;
        if (mirrorDirty && allowRunning && sidecar) scheduleMirror();
      }
    })();
    void mirrorInFlight;
  }

  async function closeSidecar(): Promise<void> {
    const active = sidecar;
    workspaceReadiness.clear();
    sidecar = undefined;
    workspaceMcp.clear();
    running = false;
    version = undefined;
    pid = undefined;
    if (!active) return;
    try {
      await active.close();
    } catch (error) {
      lastError = errorMessage(error);
    }
  }

  async function startSidecar(): Promise<void> {
    const resolved = await resolveBinary(config);
    binSource = resolved.source;
    if (!enabled || !allowRunning) return;
    await mkdir(workspaceDir, { recursive: true });
    const opencodeModelsUrl = await resolveOpencodeModelsUrl();
    const managed = await createManagedOpencodeV2Server({
      bin: resolved.bin,
      rootDir,
      env: { OPENCODE_MODELS_URL: opencodeModelsUrl },
    });
    sidecar = managed;
    if (!enabled || !allowRunning) {
      await closeSidecar();
      return;
    }
    try {
      const health = await managed.health();
      version = health.version;
      pid = health.pid;
      running = health.healthy;
      const unsubscribeConfig = onRuntimeOpencodeConfigWrite((_writeConfig, workspaceId) => {
        if (!isEngineGlobalRuntimeConfigId(workspaceId)) return;
        scheduleMirror();
      });
      const unsubscribeEnv = options.env?.onChange(scheduleMirror);
      unsubscribe = () => { unsubscribeConfig(); unsubscribeEnv?.(); };
      scheduleMirror();
      if (mirrorInFlight) await mirrorInFlight;
      if (!enabled || !allowRunning) {
        await closeSidecar();
        return;
      }
    } catch (error) {
      await closeSidecar();
      throw error;
    }
  }

  async function start(): Promise<void> {
    if (sidecar) return;
    if (startPromise) {
      await startPromise;
      return;
    }
    const pending = startSidecar();
    startPromise = pending;
    try {
      await pending;
    } finally {
      if (startPromise === pending) startPromise = undefined;
    }
  }

  function recordStartError(error: unknown): void {
    running = false;
    lastError = `${errorMessage(error)} Set OPENWORK_OPENCODE2_BIN to a working opencode2 binary to override resolution.`;
  }

  async function stopRuntime(): Promise<void> {
    allowRunning = false;
    unsubscribe?.();
    unsubscribe = undefined;
    mirrorDirty = false;
    if (startPromise) await startPromise.catch(() => undefined);
    if (mirrorInFlight) await mirrorInFlight;
    await closeSidecar();
  }

  async function setEnabled(nextEnabled: boolean): Promise<EngineV2PreviewStatus> {
    if (nextEnabled && enabled && running) return status();
    await writeEngineV2PreviewState(config, { enabled: nextEnabled, chatRouting });
    enabled = nextEnabled;
    if (!enabled) {
      await stopRuntime();
      return status();
    }
    allowRunning = true;
    lastError = undefined;
    // Fire and forget: binary resolution can install from npm and boot can take
    // tens of seconds, while renderer config requests time out after 10s. The
    // status endpoint reports progress and records failures via lastError.
    void start().catch(recordStartError);
    return status();
  }

  async function setChatRouting(nextChatRouting: boolean): Promise<EngineV2PreviewStatus> {
    await writeEngineV2PreviewState(config, { enabled, chatRouting: nextChatRouting });
    chatRouting = nextChatRouting;
    return status();
  }

  function connection(): { url: string; username: string; password: string } | undefined {
    if (!running || !sidecar) return undefined;
    return { url: sidecar.url, username: sidecar.username, password: sidecar.password };
  }

  async function ensureWorkspaceReady(directory: string): Promise<void> {
    if (mirrorInFlight) await mirrorInFlight;
    const active = sidecar;
    if (!active) throw new Error("OpenCode v2 is not running");
    const existing = workspaceReadiness.get(directory);
    if (existing) return existing;
    // V2 discovers configuration asynchronously for each new location. Its
    // initial catalog can be empty even after the preview location is ready.
    const pending = (async () => {
      const deadline = Date.now() + 8_000;
      do {
        const response = await active.fetchJson("/api/provider", { directory, timeoutMs: 5_000 });
        const payload = isRecord(response.json) ? response.json.data : undefined;
        if (response.status === 200 && Array.isArray(payload) && mirroredSpecs.every((spec) =>
          payload.some((provider) => isRecord(provider) && provider.id === spec.id
            && isRecord(provider.settings) && provider.settings.apiKey === spec.apiKey)
        )) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw new Error("OpenCode v2 workspace provider configuration did not become ready");
    })();
    workspaceReadiness.set(directory, pending);
    try { await pending; } catch (error) {
      if (workspaceReadiness.get(directory) === pending) workspaceReadiness.delete(directory);
      throw error;
    }
  }

  async function stop(): Promise<void> {
    await stopRuntime();
  }

  if (enabled) void start().catch(recordStartError);
  return { status, setEnabled, setChatRouting, connection, ensureWorkspaceReady, syncWorkspaceMcp, stop };
}
