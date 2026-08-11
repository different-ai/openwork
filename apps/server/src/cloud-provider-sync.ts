import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { EnvService } from "./env-file.js";
import { syncManagedProviderAuth } from "./managed-provider-auth.js";
import { writeOpenworkRuntimeConfigFile } from "./openwork-runtime-config.js";
import {
  hasOpenworkWorkspaceConfig,
  readOpenworkWorkspaceConfig,
  writeOpenworkWorkspaceConfig,
} from "./openwork-workspace-config-store.js";
import {
  mergeRuntimeProviderUpdate,
  readGlobalRuntimeOpencodeConfig,
  readRuntimeOpencodeConfig,
  runtimeProviderMap,
  writeGlobalRuntimeOpencodeConfig,
  writeRuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig } from "./types.js";
import { openworkConfigPath } from "./workspace-files.js";
import { findManagedEngineWorkspace } from "./workspaces.js";

type JsonRecord = Record<string, unknown>;

export type CloudProviderDenSession = {
  /** Resolved Den API base URL, including any required `/api/den` prefix. */
  baseUrl: string;
  token: string;
  orgId: string;
};

export type CloudProviderSyncRunResult = {
  status: "applied" | "noop" | "failed" | "no_session";
  message?: string;
};

export type CloudProviderSyncStatusProvider = {
  cloudProviderId: string;
  providerId: string;
  sourceProviderId: string;
  name: string;
  source: string | null;
  updatedAt: string | null;
  modelIds: string[];
  importedAt: number;
};

export type CloudProviderSyncRunDetail = {
  fingerprintChanged: boolean;
  providerStateChanged: boolean;
  envUpserts: number;
  envDeletes: number;
  cleanupChanged: boolean;
  cleanupRuntimeChanged: boolean;
  fileChanged: boolean;
  reloadDeferred: boolean;
};

export type CloudProviderSyncStatus = {
  hasSession: boolean;
  lastRun: {
    at: string;
    status: "applied" | "noop" | "failed";
    message?: string;
    detail?: CloudProviderSyncRunDetail;
  } | null;
  providers: CloudProviderSyncStatusProvider[];
};

type DenProviderModel = {
  id: string;
  name: string;
  config: JsonRecord;
};

type DenProvider = {
  id: string;
  providerId: string;
  name: string;
  source: string | null;
  updatedAt: string | null;
  providerConfig: JsonRecord;
  models: DenProviderModel[];
};

type DenProviderConnection = DenProvider & {
  apiKey: string | null;
  apiKeys: Record<string, string> | null;
};

type EnvEntry = {
  key: string;
  value: string;
};

type MaterializedProvider = {
  provider: DenProviderConnection;
  runtimeProviderId: string;
  config: JsonRecord;
  envEntries: EnvEntry[];
};

type PreparedMaterialization = {
  fingerprint: string;
  providers: MaterializedProvider[];
  envEntries: EnvEntry[];
};

type CloudProviderSyncLogger = {
  warn: (message: string, metadata?: JsonRecord) => void;
  error: (message: string, metadata?: JsonRecord) => void;
};

export type CloudProviderSyncOptions = {
  config: ServerConfig;
  env: EnvService;
  reloadEngine: () => Promise<void>;
  /**
   * Reports whether the managed engine currently has non-idle sessions.
   * When it returns true a pending engine reload is deferred to a later
   * pass instead of disposing a live instance ("no auto-reload while
   * sessions are running"). Absent means "unknown" and never blocks.
   */
  engineBusy?: () => Promise<boolean>;
  fetchImpl?: typeof globalThis.fetch;
  logger?: CloudProviderSyncLogger;
  intervalMs?: number;
};

const requestTimeoutMs = 8_000;
const defaultIntervalMs = 5 * 60 * 1_000;
const modelConfigPassthroughKeys = [
  "family",
  "release_date",
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "interleaved",
  "cost",
  "limit",
  "modalities",
  "status",
  "options",
  "headers",
  "provider",
  "variants",
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function parseJsonRecord(value: unknown): JsonRecord {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseApiKeys(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries: Array<[string, string]> = [];
  for (const [key, credential] of Object.entries(value)) {
    if (typeof credential === "string" && credential.trim().length > 0) {
      entries.push([key, credential]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function parseModel(value: unknown): DenProviderModel | null {
  if (!isRecord(value)) return null;
  const id = readRequiredString(value.id);
  const name = readRequiredString(value.name);
  if (!id || !name || (!isRecord(value.config) && typeof value.config !== "string")) return null;
  return { id, name, config: parseJsonRecord(value.config) };
}

function parseProvider(value: unknown): DenProvider | null {
  if (!isRecord(value)) return null;
  const id = readRequiredString(value.id);
  const providerId = readRequiredString(value.providerId);
  const name = readRequiredString(value.name);
  if (!id || !/^lpr_/i.test(id) || !providerId || !name || !Array.isArray(value.models)) return null;

  const models: DenProviderModel[] = [];
  for (const modelValue of value.models) {
    const model = parseModel(modelValue);
    if (!model) return null;
    models.push(model);
  }

  return {
    id,
    providerId,
    name,
    source: readOptionalString(value.source),
    updatedAt: readOptionalString(value.updatedAt),
    providerConfig: parseJsonRecord(value.providerConfig),
    models,
  };
}

function parseProviderList(payload: unknown): DenProvider[] {
  if (!isRecord(payload) || !Array.isArray(payload.llmProviders)) {
    throw new Error("den_llm_provider_list_invalid_response");
  }
  const providers: DenProvider[] = [];
  for (const value of payload.llmProviders) {
    const provider = parseProvider(value);
    if (!provider) throw new Error("den_llm_provider_list_invalid_response");
    providers.push(provider);
  }
  return providers;
}

function parseProviderConnection(payload: unknown, expectedId: string): DenProviderConnection {
  if (!isRecord(payload) || !isRecord(payload.llmProvider)) {
    throw new Error(`den_llm_provider_connect_invalid_response_${expectedId}`);
  }
  const provider = parseProvider(payload.llmProvider);
  if (!provider || provider.id !== expectedId) {
    throw new Error(`den_llm_provider_connect_invalid_response_${expectedId}`);
  }
  return {
    ...provider,
    apiKey: typeof payload.llmProvider.apiKey === "string" ? payload.llmProvider.apiKey : null,
    apiKeys: parseApiKeys(payload.llmProvider.apiKeys),
  };
}

export function parseCloudProviderDenSession(value: unknown): CloudProviderDenSession | null {
  if (!isRecord(value)) return null;
  const baseUrl = readRequiredString(value.baseUrl);
  const token = readRequiredString(value.token);
  const orgId = readRequiredString(value.orgId);
  if (!baseUrl || !token || !orgId) return null;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token, orgId };
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  session: CloudProviderDenSession,
  path: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${session.baseUrl}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${session.token}`,
        "x-openwork-legacy-org-id": session.orgId,
      },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    throw new Error(error instanceof Error ? `den_request_failed: ${error.message}` : "den_request_failed");
  }
  if (!response.ok) throw new Error(`den_request_failed_${response.status}`);
  try {
    const payload: unknown = await response.json();
    return payload;
  } catch {
    throw new Error("den_request_invalid_json");
  }
}

async function fetchProviders(
  fetchImpl: typeof globalThis.fetch,
  session: CloudProviderDenSession,
): Promise<DenProviderConnection[]> {
  const providers = parseProviderList(await requestJson(fetchImpl, session, "/v1/llm-providers"));
  return Promise.all(
    providers.map(async (provider) =>
      parseProviderConnection(
        await requestJson(fetchImpl, session, `/v1/llm-providers/${encodeURIComponent(provider.id)}/connect`),
        provider.id,
      )),
  );
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function runtimeProviderId(provider: DenProvider): string {
  return provider.source === "openwork" ? "openwork" : provider.id;
}

function isCloudManagedProviderKey(providerId: string): boolean {
  return /^lpr_/i.test(providerId) || providerId.trim() === "openwork";
}

function readProviderEnvNames(providerConfig: JsonRecord): string[] {
  return readStringList(providerConfig.env);
}

function upsertEnvEntry(entries: EnvEntry[], key: string, value: string): void {
  const trimmedKey = key.trim();
  const trimmedValue = value.trim();
  if (!trimmedKey || !trimmedValue) return;
  const existing = entries.find((entry) => entry.key === trimmedKey);
  if (existing) existing.value = trimmedValue;
  else entries.push({ key: trimmedKey, value: trimmedValue });
}

function readOpenWorkInferenceBaseUrl(providerConfig: JsonRecord): string | null {
  const options = providerConfig.options;
  if (isRecord(options)) {
    const baseUrl = readRequiredString(options.baseURL);
    if (baseUrl) return baseUrl.replace(/\/api\/v1\/?$/, "");
  }
  const api = readRequiredString(providerConfig.api);
  return api ? api.replace(/\/api\/v1\/?$/, "") : null;
}

// Ported from ee/apps/den-api/src/llm/cloud-provider-materialization.ts.
// Keep local: the open-source server must never depend on ee modules.
function providerEnvEntries(provider: DenProviderConnection): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const envNames = readProviderEnvNames(provider.providerConfig);
  if (provider.apiKeys) {
    const keys = Object.keys(provider.apiKeys);
    const orderedNames = [
      ...envNames.filter((name) => keys.includes(name)),
      ...keys.filter((name) => !envNames.includes(name)),
    ];
    for (const name of orderedNames) upsertEnvEntry(entries, name, provider.apiKeys[name] ?? "");
  }
  if (provider.apiKey && envNames[0]) upsertEnvEntry(entries, envNames[0], provider.apiKey);

  const primaryCredential = provider.apiKey?.trim() || entries[0]?.value || "";
  if (provider.source === "openwork" && primaryCredential) {
    upsertEnvEntry(entries, "OPENWORK_API_KEY", primaryCredential);
    const baseUrl = readOpenWorkInferenceBaseUrl(provider.providerConfig);
    if (baseUrl) upsertEnvEntry(entries, "OPENWORK_INFERENCE_BASE_URL", baseUrl);
  }
  return entries;
}

function buildModelConfig(model: DenProviderModel): JsonRecord {
  const next: JsonRecord = { id: model.id, name: model.name };
  for (const key of modelConfigPassthroughKeys) {
    const value = model.config[key];
    if (value !== undefined) next[key] = value;
  }
  return next;
}

function buildProviderConfig(provider: DenProviderConnection): JsonRecord {
  const models: JsonRecord = {};
  for (const model of [...provider.models].sort((left, right) => left.id.localeCompare(right.id))) {
    models[model.id] = buildModelConfig(model);
  }
  const config: JsonRecord = {
    id: provider.providerId,
    name: provider.name,
    env: readProviderEnvNames(provider.providerConfig),
  };
  if (Object.keys(models).length > 0 || provider.source !== "openwork") config.models = models;

  const npm = readRequiredString(provider.providerConfig.npm);
  if (npm) config.npm = npm;
  const api = readRequiredString(provider.providerConfig.api);
  if (api) config.api = api;
  if (isRecord(provider.providerConfig.options)) config.options = provider.providerConfig.options;
  const whitelist = readStringList(provider.providerConfig.whitelist);
  if (whitelist.length > 0) config.whitelist = whitelist;
  const blacklist = readStringList(provider.providerConfig.blacklist);
  if (blacklist.length > 0) config.blacklist = blacklist;
  return config;
}

function prepareMaterialization(providers: DenProviderConnection[]): PreparedMaterialization {
  const materialized: MaterializedProvider[] = [];
  for (const provider of providers) {
    const envEntries = providerEnvEntries(provider);
    const envNames = readProviderEnvNames(provider.providerConfig);
    if (envNames.length > 0 && !envEntries.some((entry) => envNames.includes(entry.key))) continue;
    materialized.push({
      provider,
      runtimeProviderId: runtimeProviderId(provider),
      config: buildProviderConfig(provider),
      envEntries,
    });
  }
  materialized.sort((left, right) => left.runtimeProviderId.localeCompare(right.runtimeProviderId));

  const envEntries: EnvEntry[] = [];
  for (const provider of materialized) {
    for (const entry of provider.envEntries) upsertEnvEntry(envEntries, entry.key, entry.value);
  }

  // Preserve den-api's stable, secret-safe owp:v1 fingerprint format.
  const fingerprintPayload = materialized.map((entry) => ({
    id: entry.provider.id,
    runtimeProviderId: entry.runtimeProviderId,
    source: entry.provider.source,
    providerId: entry.provider.providerId,
    config: entry.config,
    keyHashes: entry.envEntries
      .map((envEntry) => ({ key: envEntry.key, hash: hashString(envEntry.value) }))
      .sort((left, right) => left.key.localeCompare(right.key)),
  }));
  return {
    fingerprint: `owp:v1:${hashString(stableJson(fingerprintPayload))}`,
    providers: materialized,
    envEntries,
  };
}

function desiredProviderMap(prepared: PreparedMaterialization): JsonRecord {
  return Object.fromEntries(prepared.providers.map((provider) => [provider.runtimeProviderId, provider.config]));
}

function managedProviderMap(providers: Record<string, Record<string, unknown>>): JsonRecord {
  return Object.fromEntries(Object.entries(providers).filter(([providerId]) => isCloudManagedProviderKey(providerId)));
}

function removeCloudProviderImportBaselines(openwork: JsonRecord): JsonRecord | null {
  if (!isRecord(openwork.cloudImports) || !isRecord(openwork.cloudImports.providers)) return null;
  if (Object.keys(openwork.cloudImports.providers).length === 0) return null;
  return {
    ...openwork,
    cloudImports: {
      ...openwork.cloudImports,
      providers: {},
    },
  };
}

async function readLegacyOpenworkConfig(path: string): Promise<JsonRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function configuredIntervalMs(): number {
  const configured = Number(process.env.OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS ?? "");
  return Number.isFinite(configured) && configured > 0 ? configured : defaultIntervalMs;
}

function configuredReloadRetryMs(): number {
  const configured = Number(process.env.OPENWORK_ENGINE_RELOAD_RETRY_MS ?? "");
  return Number.isFinite(configured) && configured > 0 ? configured : 15_000;
}

export class CloudProviderSync {
  private readonly config: ServerConfig;
  private readonly env: EnvService;
  private readonly reloadEngine: () => Promise<void>;
  private readonly engineBusy?: () => Promise<boolean>;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly logger?: CloudProviderSyncLogger;
  private readonly intervalMs: number;
  private session: CloudProviderDenSession | null = null;
  private lastRun: CloudProviderSyncStatus["lastRun"] = null;
  private providers: CloudProviderSyncStatusProvider[] = [];
  private fingerprint: string | null = null;
  private ownedEnvKeys = new Set<string>();
  private managedProviderIds = new Set<string>();
  private importedAtByCloudProviderId = new Map<string, number>();
  private reloadPending = false;
  private queue: Promise<void> = Promise.resolve();
  private interval: ReturnType<typeof setInterval> | null = null;
  private pendingReloadRetry: ReturnType<typeof setTimeout> | null = null;
  private readonly reloadRetryMs: number;

  constructor(options: CloudProviderSyncOptions) {
    this.config = options.config;
    this.env = options.env;
    this.reloadEngine = options.reloadEngine;
    this.engineBusy = options.engineBusy;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs ?? configuredIntervalMs();
    this.reloadRetryMs = configuredReloadRetryMs();
  }

  setSession(session: CloudProviderDenSession): void {
    this.session = session;
    this.startInterval();
    void this.run("den_session_updated");
  }

  async clearSession(): Promise<void> {
    this.session = null;
    this.stopInterval();
    await this.enqueue(async () => {
      try {
        await this.sweep();
      } catch (error) {
        this.logger?.error("cloud provider sweep failed", {
          message: error instanceof Error ? error.message : "cloud_provider_sweep_failed",
        });
      } finally {
        this.lastRun = null;
        this.providers = [];
        this.fingerprint = null;
        this.ownedEnvKeys.clear();
        this.managedProviderIds.clear();
        this.importedAtByCloudProviderId.clear();
      }
    });
  }

  run(reason?: string): Promise<CloudProviderSyncRunResult> {
    if (!this.session) return Promise.resolve({ status: "no_session" });
    return this.enqueue(() => this.runPass(reason));
  }

  status(): CloudProviderSyncStatus {
    return {
      hasSession: this.session !== null,
      lastRun: this.lastRun ? { ...this.lastRun } : null,
      providers: this.providers.map((provider) => ({ ...provider, modelIds: [...provider.modelIds] })),
    };
  }

  stop(): void {
    this.stopInterval();
    this.stopReloadRetry();
  }

  /** External runtime-config writers park their engine reload here when the engine is busy. */
  markReloadPending(): void {
    this.reloadPending = true;
    this.scheduleReloadRetry();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private startInterval(): void {
    this.stopInterval();
    this.interval = setInterval(() => {
      if (this.session) void this.run("interval");
    }, this.intervalMs);
    this.interval.unref();
  }

  private stopInterval(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  /**
   * A deferred reload must not wait for the next user gesture or the 5-minute
   * interval — and a reload parked by markReloadPending() may have no Den
   * session at all, so no sync pass would ever retry it. Poll the (local,
   * cheap) engine busy probe and land the reload moments after the last
   * session idles. Serialized on the same queue as sync passes.
   */
  private scheduleReloadRetry(): void {
    if (this.pendingReloadRetry) return;
    const timer = setTimeout(() => {
      this.pendingReloadRetry = null;
      if (!this.reloadPending) return;
      void this.enqueue(async () => {
        if (!this.reloadPending) return;
        if (await this.reloadDeferredByActivity()) {
          this.scheduleReloadRetry();
          return;
        }
        try {
          await this.reloadEngine();
          this.reloadPending = false;
        } catch {
          this.scheduleReloadRetry();
        }
      });
    }, this.reloadRetryMs);
    timer.unref();
    this.pendingReloadRetry = timer;
  }

  private stopReloadRetry(): void {
    if (this.pendingReloadRetry) clearTimeout(this.pendingReloadRetry);
    this.pendingReloadRetry = null;
  }

  /**
   * A pending reload never disposes a live engine: sessions (including
   * subagent children) would abort mid-turn. Unknown activity never blocks —
   * a dead engine surfaces through the dispose call itself.
   */
  private async reloadDeferredByActivity(): Promise<boolean> {
    if (!this.engineBusy) return false;
    try {
      return await this.engineBusy();
    } catch {
      return false;
    }
  }

  private async runPass(reason?: string): Promise<CloudProviderSyncRunResult> {
    const session = this.session;
    if (!session) return { status: "no_session" };
    try {
      const prepared = prepareMaterialization(await fetchProviders(this.fetchImpl, session));
      const { changed, detail } = await this.apply(prepared);
      this.updateProviderStatus(prepared);
      this.fingerprint = prepared.fingerprint;
      const status = changed ? "applied" : "noop";
      this.lastRun = { at: new Date().toISOString(), status, detail };
      return { status };
    } catch (error) {
      const message = error instanceof Error ? error.message : "cloud_provider_sync_failed";
      this.lastRun = { at: new Date().toISOString(), status: "failed", message };
      this.logger?.warn("cloud provider sync failed", { reason, message });
      return { status: "failed", message };
    }
  }

  private async apply(prepared: PreparedMaterialization): Promise<{ changed: boolean; detail: CloudProviderSyncRunDetail }> {
    const desiredProviders = desiredProviderMap(prepared);
    const globalRuntime = await readGlobalRuntimeOpencodeConfig(this.config);
    const currentManagedProviders = managedProviderMap(runtimeProviderMap(globalRuntime));
    const providerStateChanged = stableJson(currentManagedProviders) !== stableJson(desiredProviders);

    if (providerStateChanged) {
      const patch: JsonRecord = {};
      for (const providerId of Object.keys(currentManagedProviders)) {
        if (!(providerId in desiredProviders)) patch[providerId] = null;
      }
      for (const [providerId, providerConfig] of Object.entries(desiredProviders)) patch[providerId] = providerConfig;
      await writeGlobalRuntimeOpencodeConfig(this.config, (current) => ({
        ...current,
        provider: mergeRuntimeProviderUpdate(current.provider, patch),
      }));
    }
    for (const providerId of Object.keys(desiredProviders)) this.managedProviderIds.add(providerId);

    const storedEnv = new Map((await this.env.list()).map((entry) => [entry.key, entry.value]));
    const envUpserts = prepared.envEntries.filter((entry) => storedEnv.get(entry.key) !== entry.value);
    if (envUpserts.length > 0) {
      await this.env.upsertMany(envUpserts);
      for (const entry of envUpserts) this.ownedEnvKeys.add(entry.key);
    }
    const desiredEnvKeys = new Set(prepared.envEntries.map((entry) => entry.key));
    const envDeletes = [...this.ownedEnvKeys].filter((key) => !desiredEnvKeys.has(key));
    for (const key of envDeletes) {
      await this.env.delete(key);
      this.ownedEnvKeys.delete(key);
    }

    const workspaceCleanup = await this.cleanupWorkspaceTakeovers();
    const engineWorkspace = findManagedEngineWorkspace(this.config.workspaces) ?? this.config.workspaces[0];
    const runtimeFileChanged = engineWorkspace
      ? (await writeOpenworkRuntimeConfigFile(this.config, engineWorkspace.id)).changed
      : false;
    // Credentials reach a live engine through PUT /auth/{providerID} below, so
    // a key rotation never needs a reload. Provider *config* (models, npm,
    // options.baseURL) has no live path: the engine reads it from
    // OPENCODE_CONFIG when it builds an instance, and the only write endpoint
    // that accepts it, PATCH /config, performs the same instance dispose as
    // POST /instance/dispose (verified against opencode 1.18.15 — both drop an
    // open /event stream, GET /config and PUT /auth do not). So a config delta
    // still reloads. Without a rollover-capable engine pool it is deferred
    // while sessions are live; with one, reloadEngine flips generations.
    this.reloadPending = this.reloadPending
      || providerStateChanged
      || workspaceCleanup.runtimeChanged
      || runtimeFileChanged;
    let reloadError: unknown;
    let reloadDeferred = false;
    if (engineWorkspace && this.reloadPending) {
      if (await this.reloadDeferredByActivity()) {
        reloadDeferred = true;
        this.scheduleReloadRetry();
      } else {
        try {
          await this.reloadEngine();
          this.reloadPending = false;
        } catch (error) {
          reloadError = error;
        }
      }
    }
    await syncManagedProviderAuth({
      config: this.config,
      env: this.env,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
    });
    if (reloadError) throw reloadError;

    this.managedProviderIds = new Set(Object.keys(desiredProviders));
    const detail: CloudProviderSyncRunDetail = {
      fingerprintChanged: this.fingerprint !== prepared.fingerprint,
      providerStateChanged,
      envUpserts: envUpserts.length,
      envDeletes: envDeletes.length,
      cleanupChanged: workspaceCleanup.changed,
      cleanupRuntimeChanged: workspaceCleanup.runtimeChanged,
      fileChanged: runtimeFileChanged,
      reloadDeferred,
    };
    const changed = detail.fingerprintChanged
      || providerStateChanged
      || envUpserts.length > 0
      || envDeletes.length > 0
      || workspaceCleanup.changed
      || runtimeFileChanged;
    return { changed, detail };
  }

  private async cleanupWorkspaceTakeovers(): Promise<{ changed: boolean; runtimeChanged: boolean }> {
    let changed = false;
    let runtimeChanged = false;
    for (const workspace of this.config.workspaces) {
      const runtime = await readRuntimeOpencodeConfig(this.config, workspace.id);
      const providerPatch: JsonRecord = {};
      for (const providerId of Object.keys(runtimeProviderMap(runtime))) {
        if (isCloudManagedProviderKey(providerId)) providerPatch[providerId] = null;
      }
      if (Object.keys(providerPatch).length > 0) {
        const result = await writeRuntimeOpencodeConfig(this.config, workspace.id, (current) => ({
          ...current,
          provider: mergeRuntimeProviderUpdate(current.provider, providerPatch),
        }));
        changed = changed || result.changed;
        runtimeChanged = runtimeChanged || result.changed;
      }

      const hasStoredConfig = await hasOpenworkWorkspaceConfig(this.config, workspace.id);
      const openwork = hasStoredConfig
        ? await readOpenworkWorkspaceConfig(this.config, workspace.id)
        : workspace.workspaceType !== "remote" && workspace.path.trim().length > 0
          ? await readLegacyOpenworkConfig(openworkConfigPath(workspace.path))
          : null;
      if (!openwork) continue;
      const next = removeCloudProviderImportBaselines(openwork);
      if (!next) continue;
      await writeOpenworkWorkspaceConfig(this.config, workspace.id, () => next);
      changed = true;
    }
    return { changed, runtimeChanged };
  }

  private updateProviderStatus(prepared: PreparedMaterialization): void {
    const desiredCloudIds = new Set(prepared.providers.map((entry) => entry.provider.id));
    for (const cloudId of [...this.importedAtByCloudProviderId.keys()]) {
      if (!desiredCloudIds.has(cloudId)) this.importedAtByCloudProviderId.delete(cloudId);
    }
    const now = Date.now();
    this.providers = prepared.providers.map((entry) => {
      const importedAt = this.importedAtByCloudProviderId.get(entry.provider.id) ?? now;
      this.importedAtByCloudProviderId.set(entry.provider.id, importedAt);
      return {
        cloudProviderId: entry.provider.id,
        providerId: entry.runtimeProviderId,
        sourceProviderId: entry.provider.providerId,
        name: entry.provider.name,
        source: entry.provider.source,
        updatedAt: entry.provider.updatedAt,
        modelIds: entry.provider.models.map((model) => model.id).sort(),
        importedAt,
      };
    });
  }

  private async sweep(): Promise<void> {
    const providerPatch = Object.fromEntries([...this.managedProviderIds].map((providerId) => [providerId, null]));
    let providerChanged = false;
    if (Object.keys(providerPatch).length > 0) {
      const result = await writeGlobalRuntimeOpencodeConfig(this.config, (current) => ({
        ...current,
        provider: mergeRuntimeProviderUpdate(current.provider, providerPatch),
      }));
      providerChanged = result.changed;
    }
    for (const key of this.ownedEnvKeys) await this.env.delete(key);

    const engineWorkspace = findManagedEngineWorkspace(this.config.workspaces) ?? this.config.workspaces[0];
    if (engineWorkspace) {
      const fileResult = await writeOpenworkRuntimeConfigFile(this.config, engineWorkspace.id);
      this.reloadPending = this.reloadPending || providerChanged || fileResult.changed;
    }
    let reloadError: unknown;
    if (this.reloadPending && (await this.reloadDeferredByActivity())) {
      this.scheduleReloadRetry();
    } else if (this.reloadPending) {
      try {
        await this.reloadEngine();
        this.reloadPending = false;
      } catch (error) {
        reloadError = error;
      }
    }
    await syncManagedProviderAuth({
      config: this.config,
      env: this.env,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
    });
    if (reloadError) throw reloadError;
  }
}
