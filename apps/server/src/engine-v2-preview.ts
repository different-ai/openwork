import { migrateOpencodeV1History, opencodeV1DatabasePath, type EngineV2MigrationStatus } from "./opencode-v2-migration.js";
import { waitForOpenWorkV2Skills, workspaceSkillFingerprint } from "./opencode-v2-instructions.js";
import {
  createV2ReadinessLog,
  resolveV2ReadinessPolicy,
  V2NotReadyError,
  type V2ReadinessEvent,
  type V2ReadinessPolicy,
} from "./v2-readiness.js";
import { executionRules } from "./managed-policy-rules.js";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
import { localProviderDefinitions, readLocalProviderApiKeys } from "./opencode-v2-local-auth.js";

const OPENCODE_V2_VERSION = constants.opencodeV2Version;
const PREVIEW_STATE_FILE = "engine-v2-preview.json";
const UNSET_API_KEY = "openwork-engine-v2-preview-unset";
// A cold sidecar can return HTTP 503 while its model catalog initializes for 17–20 seconds.
const CATALOG_MIRROR_TIMEOUT_MS = 60_000;
// Requests join an in-flight provider mirror only this long. The mirror's
// catalog confirmation is diagnostics; the engine serves requests meanwhile.
const MIRROR_JOIN_TIMEOUT_MS = 10_000;
const WORKSPACE_PROVIDER_READY_TIMEOUT_MS = 8_000;
const MCP_SETTLE_TIMEOUT_MS = 10_000;
// A registration the engine rejected is retried after this long, or at once
// when its configuration changes, instead of on every request.
const MCP_REGISTRATION_RETRY_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  /** How each optional pre-turn step behaves, and the latest ones that were
   * degraded (continued unconfirmed) or blocked. */
  readiness: { policy: V2ReadinessPolicy; recent: V2ReadinessEvent[] };
  migration: EngineV2MigrationStatus;
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
  start(): void;
  status(): EngineV2PreviewStatus;
  setEnabled(enabled: boolean): Promise<EngineV2PreviewStatus>;
  setChatRouting(chatRouting: boolean): Promise<EngineV2PreviewStatus>;
  connection(): { url: string; username: string; password: string } | undefined;
  ensureWorkspaceReady(directory: string): Promise<void>;
  refreshProviders(): Promise<void>;
  syncWorkspaceMcp(workspaceId: string, directory: string): Promise<void>;
  /** Join the native watcher for local workspace skills. Blocks only under a `block` policy. */
  syncWorkspaceSkills(directory: string): Promise<void>;
  readinessPolicy(): V2ReadinessPolicy;
  /** Record a degraded or blocked step observed outside this module. */
  recordReadiness(event: Pick<V2ReadinessEvent, "check" | "outcome" | "detail">): void;
  migrateHistory(): EngineV2PreviewStatus;
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
  localApiKeys: ReadonlyMap<string, string> = new Map(),
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
    const resolvedKey = explicitKey ?? storedKey ?? localApiKeys.get(id);
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
      ...(Array.isArray(value.whitelist) ? { whitelist: value.whitelist.filter((id): id is string => typeof id === "string") } : {}),
      ...(Array.isArray(value.blacklist) ? { blacklist: value.blacklist.filter((id): id is string => typeof id === "string") } : {}),
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

export function createEngineV2Preview(options: {
  config: ServerConfig;
  env?: Pick<EnvService, "list" | "onChange">;
  deferStart?: boolean;
  readinessPolicy?: V2ReadinessPolicy;
}): EngineV2Preview {
  const { config } = options;
  const rootDir = join(runtimeStorageDir(config), "opencode-v2", "state");
  const workspaceDir = join(rootDir, "workspace");
  const initialState = resolveInitialEngineV2PreviewState(process.env, readEngineV2PreviewState(config));
  let migration: EngineV2MigrationStatus = { state: "idle", imported: 0, skipped: 0, total: 0 };
  let migrationJob: Promise<void> | undefined;
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
  const policy = options.readinessPolicy ?? resolveV2ReadinessPolicy(process.env.OPENWORK_V2_READINESS);
  const readinessLog = createV2ReadinessLog();
  const degraded = (check: V2ReadinessEvent["check"], detail: string) => readinessLog.record({ check, outcome: "degraded", detail });
  const blocked = (check: V2NotReadyError["check"], detail: string): V2NotReadyError => {
    readinessLog.record({ check, outcome: "blocked", detail });
    return new V2NotReadyError(check, detail);
  };
  let sidecar: ManagedOpencodeV2Server | undefined;
  let unsubscribe: (() => void) | undefined;
  let startPromise: Promise<void> | undefined;
  let mirrorInFlight: Promise<void> | undefined;
  let mirrorDirty = false;
  // Result of the last provider check per location, reused until providers change.
  const workspaceReadiness = new Map<string, Promise<boolean>>();
  // Locations whose providers were confirmed under some earlier mirror.
  const providersConfirmed = new Set<string>();
  let mirroredSpecs: OpencodeV2ProviderSpec[] = [];
  let mirroredFingerprint: string | undefined;
  const workspaceMcp = new Map<string, Map<string, string>>();
  const mcpInFlight = new Map<string, Promise<string>>();
  const mcpWorkspaces = new Map<string, string>();
  const mcpRejected = new Map<string, Map<string, { fingerprint: string; at: number }>>();
  // The last skill check per location, keyed by the workspace skill files'
  // fingerprint. An unchanged fingerprint reuses the result with no wait.
  const skillSnapshots = new Map<string, { fingerprint: string; settled: boolean; diagnostic: string }>();
  async function syncWorkspaceSkills(directory: string): Promise<void> {
    const active = sidecar;
    if (!active) throw new Error("OpenCode v2 is not running");
    const fingerprint = await workspaceSkillFingerprint(directory);
    const previous = skillSnapshots.get(directory);
    if (previous?.fingerprint === fingerprint) {
      if (previous.settled) return;
      if (policy.skills === "block") throw blocked("skills", previous.diagnostic);
      degraded("skills", previous.diagnostic);
      return;
    }
    // Freshness only: the engine owns which skills load, as it does for the CLI.
    const check = waitForOpenWorkV2Skills(directory, async () => {
      const response = await active.fetchJson("/api/skill", { directory, timeoutMs: 5_000 });
      if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
      return response.json;
    }).then((result) => {
      const diagnostic = result.settled ? "" : result.diagnostic;
      skillSnapshots.set(directory, { fingerprint, settled: result.settled, diagnostic });
      return diagnostic;
    });
    if (policy.skills === "background" && previous) {
      // A confirmed earlier snapshot exists; refresh it without delaying the turn.
      void check.then((diagnostic) => { if (diagnostic) degraded("skills", diagnostic); }, () => undefined);
      return;
    }
    const diagnostic = await check;
    if (!diagnostic) return;
    if (policy.skills === "block") throw blocked("skills", diagnostic);
    degraded("skills", diagnostic);
  }

  async function syncWorkspaceMcp(workspaceId: string, directory: string): Promise<void> {
    mcpWorkspaces.set(directory, workspaceId);
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
      let changed = false;
      // Remove first so a failed replacement cannot leave an old credential or
      // revoked tool active. Only touch registrations owned by this mirror.
      for (const [name, fingerprint] of applied) {
        if (desired.has(name) && JSON.stringify(desired.get(name)) === fingerprint) continue;
        const result = await active.fetchJson(`/api/mcp/${encodeURIComponent(name)}`, {
          method: "DELETE", directory, timeoutMs: 15_000,
        });
        if (result.status !== 204 && result.status !== 404) throw new Error(`OpenCode v2 MCP removal failed (${result.status})`);
        applied.delete(name);
        changed = true;
      }
      // A connection the engine rejects is unavailable, exactly as a broken
      // entry in the CLI's own config would be; it never blocks the chat.
      const rejected = mcpRejected.get(directory) ?? new Map<string, { fingerprint: string; at: number }>();
      mcpRejected.set(directory, rejected);
      for (const [name, mcpConfig] of desired) {
        const fingerprint = JSON.stringify(mcpConfig);
        if (applied.get(name) === fingerprint) continue;
        const previousRejection = rejected.get(name);
        if (previousRejection?.fingerprint === fingerprint && Date.now() - previousRejection.at < MCP_REGISTRATION_RETRY_MS) continue;
        let status: number;
        try {
          status = (await active.fetchJson(`/api/mcp/${encodeURIComponent(name)}`, {
            method: "PUT", body: { config: mcpConfig }, directory, timeoutMs: 30_000,
          })).status;
        } catch (error) {
          status = 0;
          degraded("mcp", `${name}: ${errorMessage(error)}`);
        }
        if (status !== 204) {
          rejected.set(name, { fingerprint, at: Date.now() });
          if (status !== 0) degraded("mcp", `${name}: registration failed (${status})`);
          continue;
        }
        rejected.delete(name);
        applied.set(name, fingerprint);
        changed = true;
      }
      let stillStarting = false;
      if (changed) {
        // Wait briefly so a just-registered connection's tools are in the first
        // turn, but a slow or failing server only delays, never refuses, it.
        const deadline = Date.now() + MCP_SETTLE_TIMEOUT_MS;
        while (true) {
          const result = await active.fetchJson("/api/mcp", { directory, timeoutMs: 5_000 }).catch(() => undefined);
          const entries = isRecord(result?.json) ? result.json.data : undefined;
          const pending = result?.status !== 200 || !Array.isArray(entries) || [...applied.keys()].some((name) => {
            const entry = entries.find((entry) => isRecord(entry) && entry.name === name);
            return !isRecord(entry) || !isRecord(entry.status) || entry.status.status === "pending";
          });
          if (!pending) break;
          if (Date.now() >= deadline) {
            stillStarting = true;
            degraded("mcp", "connections were still starting when the request proceeded");
            break;
          }
          await delay(100);
        }
        // The pinned beta batches MCP ToolsChanged events for 100ms after
        // connection startup. Admission follows that registry refresh when it can.
        await delay(250);
      }
      const unavailable = [...desired.keys()].filter((name) => rejected.has(name));
      return stillStarting || unavailable.length
        ? `${unavailable.length ? `rejected: ${unavailable.join(", ")}` : ""}${stillStarting ? `${unavailable.length ? "; " : ""}still starting` : ""}`
        : "";
    })();
    mcpInFlight.set(directory, pending);
    let unavailable: string;
    try { unavailable = await pending; }
    catch (error) {
      // Retain ownership for removals, but never cache a failed readiness
      // attempt as an applied configuration.
      const applied = workspaceMcp.get(directory);
      if (applied) for (const name of applied.keys()) applied.set(name, "");
      throw error;
    }
    finally { if (mcpInFlight.get(directory) === pending) mcpInFlight.delete(directory); }
    // Under a `block` policy every configured connection must be registered
    // and started before a turn. Registered ones stay cached either way.
    if (unavailable && policy.mcp === "block") throw blocked("mcp", unavailable);
  }

  function status(): EngineV2PreviewStatus {
    return {
      enabled,
      migration: { ...migration },
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
      readiness: { policy: { ...policy }, recent: readinessLog.recent() },
    };
  }

  async function mirrorProviders(): Promise<void> {
    const active = sidecar;
    if (!active) return;
    const configured = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config));
    const localKeys = await readLocalProviderApiKeys();
    const providerMap = { ...await localProviderDefinitions(config, localKeys, configured), ...configured };
    const credentials = new Map((await options.env?.list() ?? []).map((entry) => [entry.key, entry.value]));
    const mapped = mapRuntimeProvidersToV2Specs(providerMap, credentials, localKeys);
    const nextMirroredProviderIds = mapped.specs.map((spec) => spec.id);
    skippedProviderIds = [...mapped.skippedProviderIds];
    // Frequent syncs usually change nothing. Re-pushing identical providers
    // would reset every location's confirmation and make turns wait again.
    const fingerprint = createHash("sha256").update(JSON.stringify(mapped.specs)).digest("hex");
    if (fingerprint === mirroredFingerprint) return;
    await active.setProviders(mapped.specs);
    mirroredSpecs = mapped.specs;
    mirroredFingerprint = fingerprint;
    workspaceReadiness.clear();
    mirroredProviderIds = nextMirroredProviderIds;
    lastMirroredAt = new Date().toISOString();
    const expectedModelIds = mapped.specs.flatMap((spec) => spec.models
      .filter(model => (spec.whitelist === undefined || spec.whitelist.includes(model.id)) && !spec.blacklist?.includes(model.id))
      .map((model) => model.id));
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

  async function refreshProviders(): Promise<void> {
    if (!running || !sidecar) throw new Error("OpenCode v2 is not running");
    scheduleMirror();
    await mirrorInFlight;
    if (lastError) throw new Error(lastError);
  }

  async function closeSidecar(): Promise<void> {
    const active = sidecar;
    workspaceReadiness.clear();
    providersConfirmed.clear();
    mirroredFingerprint = undefined;
    sidecar = undefined;
    workspaceMcp.clear();
    mcpWorkspaces.clear();
    mcpRejected.clear();
    skillSnapshots.clear();
    readinessLog.clear();
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
    // Remove copies left by the former v2-only Cloud materializer. Cloud
    // skills now use the same metadata/on-demand Connect path as v1.
    await rm(join(rootDir, "cloud-skills"), { recursive: true, force: true });
    const opencodeModelsUrl = await resolveOpencodeModelsUrl();
    const managed = await createManagedOpencodeV2Server({
      bin: resolved.bin,
      rootDir,
      env: { OPENCODE_MODELS_URL: opencodeModelsUrl },
      permissions: async () => {
        const runtime = await readGlobalRuntimeOpencodeConfig(config);
        return executionRules(runtime.managedPolicy?.execution);
      },
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
        const global = isEngineGlobalRuntimeConfigId(workspaceId);
        if (global) scheduleMirror();
        // Connections installed through OpenWork also update already-open
        // locations while a conversation is active. Request admission joins
        // the same serialized reconciliation rather than racing it.
        for (const [directory, id] of mcpWorkspaces) {
          if (global || id === workspaceId) void syncWorkspaceMcp(id, directory).catch((error) => {
            if (sidecar) lastError = `MCP: ${errorMessage(error)}`;
          });
        }
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
    if (migration.state === "running") throw new Error("Wait for history migration to finish before switching engines.");
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
    if (migration.state === "running") throw new Error("Wait for history migration to finish before switching engines.");
    await writeEngineV2PreviewState(config, { enabled, chatRouting: nextChatRouting });
    chatRouting = nextChatRouting;
    return status();
  }

  function connection(): { url: string; username: string; password: string } | undefined {
    if (!running || !sidecar) return undefined;
    return { url: sidecar.url, username: sidecar.username, password: sidecar.password };
  }

  async function ensureWorkspaceReady(directory: string): Promise<void> {
    const background = policy.providers === "background" && providersConfirmed.has(directory);
    if (mirrorInFlight && !background) await Promise.race([mirrorInFlight, delay(MIRROR_JOIN_TIMEOUT_MS)]);
    const active = sidecar;
    if (!active) throw new Error("OpenCode v2 is not running");
    let pending = workspaceReadiness.get(directory);
    if (!pending) {
      // V2 discovers configuration asynchronously for each new location. Its
      // initial catalog can be empty even after the preview location is ready.
      pending = (async () => {
        const deadline = Date.now() + WORKSPACE_PROVIDER_READY_TIMEOUT_MS;
        do {
          const response = await active.fetchJson("/api/provider", { directory, timeoutMs: 5_000 }).catch(() => undefined);
          const payload = isRecord(response?.json) ? response.json.data : undefined;
          if (response?.status === 200 && Array.isArray(payload) && mirroredSpecs.every((spec) =>
            payload.some((provider) => isRecord(provider) && provider.id === spec.id
              && isRecord(provider.settings) && provider.settings.apiKey === spec.apiKey)
          )) {
            providersConfirmed.add(directory);
            return true;
          }
          await delay(100);
        } while (Date.now() < deadline);
        return false;
      })();
      const check = pending;
      workspaceReadiness.set(directory, check);
      // A failed check is retried by the next turn when the policy blocks;
      // otherwise the degraded result is reused until providers change.
      void check.then((confirmed) => {
        if (!confirmed && policy.providers === "block" && workspaceReadiness.get(directory) === check) workspaceReadiness.delete(directory);
      });
    }
    // The location was confirmed under an earlier provider set: continue with
    // it while the current set is confirmed in the background.
    if (background) return;
    if (await pending) return;
    const detail = `${directory} did not report every mirrored provider`;
    if (policy.providers === "block") throw blocked("providers", detail);
    degraded("providers", `${detail}; continuing with the engine's catalog`);
  }

  function migrateHistory(): EngineV2PreviewStatus {
    if (migration.state === "running") return status();
    migration = { state: "running", imported: 0, skipped: 0, total: 0 };
    migrationJob = (async () => {
      try {
        const source = opencodeV1DatabasePath();
        const resolved = await resolveBinary(config);
        enabled = true;
        allowRunning = true;
        await writeEngineV2PreviewState(config, { enabled, chatRouting });
        await start();
        if (!sidecar) throw new Error("OpenCode v2 could not start. Retry migration.");
        await migrateOpencodeV1History({ source, storageDir: join(runtimeStorageDir(config), "opencode-v2"),
          bin: resolved.bin, target: sidecar, progress: (next) => { migration = next; } });
      } catch (error) {
        migration = { ...migration, state: "error", error: errorMessage(error) };
      }
    })();
    return status();
  }

  async function stop(): Promise<void> {
    await migrationJob;
    await stopRuntime();
  }

  function startWhenReady(): void {
    if (enabled) void start().catch(recordStartError);
  }
  if (!options.deferStart) startWhenReady();
  return {
    start: startWhenReady, migrateHistory, status, setEnabled, setChatRouting, connection, ensureWorkspaceReady,
    refreshProviders, syncWorkspaceMcp, syncWorkspaceSkills, stop,
    readinessPolicy: () => ({ ...policy }),
    recordReadiness: (event) => readinessLog.record(event),
  };
}
