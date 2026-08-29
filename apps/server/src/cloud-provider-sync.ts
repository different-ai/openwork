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

/**
 * A Den-granted provider the sync pass could NOT materialize. Skips used to be
 * silent (the provider simply never appeared in `providers`); every skip now
 * names itself with a machine-readable reason so a dropped provider is
 * diagnosable from `GET /cloud-provider-sync/status` alone.
 */
export type CloudProviderSyncSkippedProvider = {
  cloudProviderId: string;
  providerId: string;
  name: string;
  /** Why materialization skipped this provider (e.g. declared env vars but no credential to fill them). */
  reason: "missing_credentials" | "needs_key";
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
  /**
   * True while a managed engine reload is still owed (deferred behind live
   * sessions or failed and awaiting retry). A provider listed in `providers`
   * with `reloadPending: true` is materialized on disk but not yet served by
   * the engine — the "applied but engine empty" gap is visible, not silent.
   * Additive: old readers ignore it.
   */
  reloadPending: boolean;
  /** Providers granted by Den but skipped by materialization, each with a reason. Additive. */
  skippedProviders: CloudProviderSyncSkippedProvider[];
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
  memberCredentialState: "missing" | "active" | "blocked" | "stale" | "error" | null;
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
  skipped: CloudProviderSyncSkippedProvider[];
};

type CloudProviderSyncLogger = {
  warn: (message: string, metadata?: JsonRecord) => void;
  error: (message: string, metadata?: JsonRecord) => void;
};

type CloudProviderSyncRequest = {
  contextKey: string;
  generation: number;
  session: CloudProviderDenSession;
  reason?: string;
};

type CloudProviderSyncRun = {
  contextKey: string;
  promise: Promise<CloudProviderSyncRunResult>;
};

type CloudProviderSyncTrailingRun = CloudProviderSyncRun & {
  request: CloudProviderSyncRequest;
  resolve: (result: CloudProviderSyncRunResult) => void;
  reject: (error: unknown) => void;
};

type CloudProviderSyncPendingSession = {
  contextKey: string;
  promise: Promise<void>;
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
  const memberCredential = payload.llmProvider.memberCredential;
  const memberCredentialState = isRecord(memberCredential)
    && (memberCredential.state === "missing"
      || memberCredential.state === "active"
      || memberCredential.state === "blocked"
      || memberCredential.state === "stale"
      || memberCredential.state === "error")
    ? memberCredential.state
    : null;
  if (memberCredential !== undefined && memberCredentialState === null) {
    throw new Error(`den_llm_provider_connect_invalid_response_${expectedId}`);
  }
  return {
    ...provider,
    apiKey: typeof payload.llmProvider.apiKey === "string" ? payload.llmProvider.apiKey : null,
    apiKeys: parseApiKeys(payload.llmProvider.apiKeys),
    memberCredentialState,
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
  const skipped: CloudProviderSyncSkippedProvider[] = [];
  for (const provider of providers) {
    if (provider.memberCredentialState && provider.memberCredentialState !== "active") {
      skipped.push({
        cloudProviderId: provider.id,
        providerId: runtimeProviderId(provider),
        name: provider.name,
        reason: "needs_key",
      });
      continue;
    }
    const envEntries = providerEnvEntries(provider);
    const envNames = readProviderEnvNames(provider.providerConfig);
    if (envNames.length > 0 && !envEntries.some((entry) => envNames.includes(entry.key))) {
      // The provider declares credential env vars but the connect payload
      // yielded no value for any of them. Materializing it would produce a
      // provider whose every request fails with a missing API key, so it is
      // skipped — loudly, so status readers can see why it never appeared.
      skipped.push({
        cloudProviderId: provider.id,
        providerId: runtimeProviderId(provider),
        name: provider.name,
        reason: "missing_credentials",
      });
      continue;
    }
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
    skipped,
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
  private skippedProviders: CloudProviderSyncSkippedProvider[] = [];
  private fingerprint: string | null = null;
  private ownedEnvKeys = new Set<string>();
  private managedProviderIds = new Set<string>();
  private importedAtByCloudProviderId = new Map<string, number>();
  private reloadPending = false;
  private queue: Promise<void> = Promise.resolve();
  private contextGeneration = 0;
  private pendingSession: CloudProviderSyncPendingSession | null = null;
  private activeRun: CloudProviderSyncRun | null = null;
  private trailingRun: CloudProviderSyncTrailingRun | null = null;
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

  setSession(session: CloudProviderDenSession): Promise<void> {
    const contextKey = this.sessionContextKey(session);
    if (this.session && this.sessionContextKey(this.session) === contextKey) return Promise.resolve();
    if (this.pendingSession?.contextKey === contextKey) return this.pendingSession.promise;

    const hasMaterializedContext = this.session !== null
      || this.managedProviderIds.size > 0
      || this.ownedEnvKeys.size > 0;
    this.contextGeneration += 1;

    if (!hasMaterializedContext) {
      this.session = session;
      this.startInterval();
      void this.run("den_session_updated");
      return Promise.resolve();
    }

    const generation = this.contextGeneration;
    this.session = null;
    this.stopInterval();
    this.stopReloadRetry();
    const trailing = this.trailingRun;
    this.trailingRun = null;
    trailing?.resolve({ status: "no_session" });
    this.lastRun = null;
    this.providers = [];
    this.skippedProviders = [];

    const promise = this.enqueue(async () => {
      if (generation !== this.contextGeneration) return;
      await this.sweep({ forceReload: true });
      this.resetMaterializationState();
      if (generation !== this.contextGeneration) return;
      this.session = session;
      this.startInterval();
      void this.run("den_session_updated");
    });
    const pending = { contextKey, promise };
    this.pendingSession = pending;
    void promise.then(
      () => {
        if (this.pendingSession === pending) this.pendingSession = null;
      },
      () => {
        if (this.pendingSession === pending) this.pendingSession = null;
      },
    );
    return promise;
  }

  async clearSession(): Promise<void> {
    this.contextGeneration += 1;
    this.pendingSession = null;
    this.session = null;
    this.stopInterval();
    const trailing = this.trailingRun;
    this.trailingRun = null;
    trailing?.resolve({ status: "no_session" });
    await this.enqueue(async () => {
      try {
        await this.sweep({ forceReload: true });
      } catch (error) {
        this.logger?.error("cloud provider sweep failed", {
          message: error instanceof Error ? error.message : "cloud_provider_sweep_failed",
        });
      } finally {
        this.resetMaterializationState();
      }
    });
  }

  run(reason?: string): Promise<CloudProviderSyncRunResult> {
    const session = this.session;
    if (!session) return Promise.resolve({ status: "no_session" });
    const request = {
      contextKey: this.sessionContextKey(session),
      generation: this.contextGeneration,
      session,
      reason,
    };
    if (this.activeRun?.contextKey === request.contextKey) {
      const trailing = this.trailingRun;
      if (trailing && trailing.contextKey !== request.contextKey) {
        this.trailingRun = null;
        void this.activeRun.promise.then(trailing.resolve, trailing.reject);
      }
      return this.activeRun.promise;
    }
    if (this.trailingRun) {
      if (this.trailingRun.contextKey !== request.contextKey) {
        this.trailingRun.contextKey = request.contextKey;
        this.trailingRun.request = request;
      }
      return this.trailingRun.promise;
    }
    if (this.activeRun) return this.createTrailingRun(request);
    return this.startRun(request);
  }

  status(): CloudProviderSyncStatus {
    return {
      hasSession: this.session !== null,
      lastRun: this.lastRun ? { ...this.lastRun } : null,
      providers: this.providers.map((provider) => ({ ...provider, modelIds: [...provider.modelIds] })),
      reloadPending: this.reloadPending,
      skippedProviders: this.skippedProviders.map((provider) => ({ ...provider })),
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

  private sessionContextKey(session: CloudProviderDenSession): string {
    return `${session.baseUrl}\u0000${session.orgId}\u0000${session.token}`;
  }

  private resetMaterializationState(): void {
    this.lastRun = null;
    this.providers = [];
    this.skippedProviders = [];
    this.fingerprint = null;
    this.ownedEnvKeys.clear();
    this.managedProviderIds.clear();
    this.importedAtByCloudProviderId.clear();
  }

  private createTrailingRun(request: CloudProviderSyncRequest): Promise<CloudProviderSyncRunResult> {
    let resolve: (result: CloudProviderSyncRunResult) => void = () => undefined;
    let reject: (error: unknown) => void = () => undefined;
    const promise = new Promise<CloudProviderSyncRunResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    this.trailingRun = {
      contextKey: request.contextKey,
      request,
      promise,
      resolve,
      reject,
    };
    return promise;
  }

  private startRun(request: CloudProviderSyncRequest): Promise<CloudProviderSyncRunResult> {
    const promise = this.enqueue(() => this.runPass(request));
    const active = { contextKey: request.contextKey, promise };
    this.activeRun = active;
    void promise.then(
      () => this.finishRun(active),
      () => this.finishRun(active),
    );
    return promise;
  }

  private finishRun(active: CloudProviderSyncRun): void {
    if (this.activeRun !== active) return;
    this.activeRun = null;
    const trailing = this.trailingRun;
    this.trailingRun = null;
    if (!trailing) return;
    const promise = this.startRun(trailing.request);
    void promise.then(trailing.resolve, trailing.reject);
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
          // A landed retry settles a previously failed run: without this the
          // status would stay "failed" forever even though the engine now
          // serves every synced provider.
          if (this.session && this.lastRun?.status === "failed") {
            this.lastRun = {
              at: new Date().toISOString(),
              status: "applied",
              message: "deferred engine reload landed",
            };
          }
        } catch (error) {
          // Never silent: a signed-in desktop whose engine keeps rejecting
          // reloads must say so in status instead of reporting the last
          // pass's stale outcome while models never arrive.
          if (this.session) {
            const message = error instanceof Error ? error.message : "cloud_provider_engine_reload_failed";
            this.lastRun = { at: new Date().toISOString(), status: "failed", message };
            this.logger?.warn("cloud provider engine reload retry failed", { message });
          }
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

  private async runPass(request: CloudProviderSyncRequest): Promise<CloudProviderSyncRunResult> {
    const { reason, session } = request;
    try {
      const prepared = prepareMaterialization(await fetchProviders(this.fetchImpl, session));
      if (request.generation !== this.contextGeneration) return { status: "no_session" };
      const { changed, detail, reloadError } = await this.apply(prepared);
      // The materialization itself succeeded (config + env writes landed), so
      // record it even when the engine reload failed: hiding the providers
      // made a reload-only failure indistinguishable from "nothing synced".
      this.updateProviderStatus(prepared);
      this.skippedProviders = prepared.skipped;
      this.fingerprint = prepared.fingerprint;
      if (reloadError) {
        const message = reloadError instanceof Error ? reloadError.message : "cloud_provider_engine_reload_failed";
        this.lastRun = { at: new Date().toISOString(), status: "failed", message, detail };
        this.logger?.warn("cloud provider sync failed", { reason, message });
        return { status: "failed", message };
      }
      const status = changed ? "applied" : "noop";
      this.lastRun = { at: new Date().toISOString(), status, detail };
      return { status };
    } catch (error) {
      if (request.generation !== this.contextGeneration) return { status: "no_session" };
      const message = error instanceof Error ? error.message : "cloud_provider_sync_failed";
      this.lastRun = { at: new Date().toISOString(), status: "failed", message };
      this.logger?.warn("cloud provider sync failed", { reason, message });
      return { status: "failed", message };
    }
  }

  private async apply(
    prepared: PreparedMaterialization,
  ): Promise<{ changed: boolean; detail: CloudProviderSyncRunDetail; reloadError?: unknown }> {
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
    }
    const desiredEnvKeys = new Set(prepared.envEntries.map((entry) => entry.key));
    // Ownership follows the active cloud materialization, not whether this
    // process happened to write the value. After an app/server restart the
    // persisted credential can already equal Den's value, so envUpserts is
    // empty. Reclaim every desired key or the next logout will leave that
    // cloud credential behind permanently.
    for (const key of desiredEnvKeys) this.ownedEnvKeys.add(key);
    const envDeletes = [...this.ownedEnvKeys].filter((key) => !desiredEnvKeys.has(key));
    for (const key of envDeletes) {
      await this.env.delete(key);
      this.ownedEnvKeys.delete(key);
    }

    const workspaceCleanup = await this.cleanupWorkspaceTakeovers();
    const engineWorkspace = findManagedEngineWorkspace(this.config.workspaces) ?? this.config.workspaces[0];
    const runtimeFileChanged = engineWorkspace
      ? (await writeOpenworkRuntimeConfigFile(this.config)).changed
      : false;
    // Deliver credentials before disposing the current provider instances.
    // OpenCode constructs and caches SDK clients from config + auth together;
    // reloading first can cache a client without the just-synced credential,
    // even though PUT /auth/{providerID} later reports success. Credential
    // rotation therefore needs the same instance refresh as provider config.
    const authResult = await syncManagedProviderAuth({
      config: this.config,
      env: this.env,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
    });
    const authChanged = authResult.delivered.length > 0 || authResult.removed.length > 0;

    // Provider *config* (models, npm,
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
      || runtimeFileChanged
      || authChanged;
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
          // Self-heal like the busy-deferral path: without this, a failed
          // reload waited for the next external trigger (user gesture or the
          // 5-minute interval) while the status kept promising the providers.
          this.scheduleReloadRetry();
        }
      }
    }
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
    return { changed, detail, reloadError };
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

  private async sweep(options: { forceReload?: boolean } = {}): Promise<void> {
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
      const fileResult = await writeOpenworkRuntimeConfigFile(this.config);
      this.reloadPending = this.reloadPending || providerChanged || fileResult.changed;
    }
    const authResult = await syncManagedProviderAuth({
      config: this.config,
      env: this.env,
      fetchImpl: this.fetchImpl,
      logger: this.logger,
    });
    this.reloadPending = this.reloadPending
      || authResult.delivered.length > 0
      || authResult.removed.length > 0;
    let reloadError: unknown;
    if (this.reloadPending && !options.forceReload && (await this.reloadDeferredByActivity())) {
      this.scheduleReloadRetry();
    } else if (this.reloadPending) {
      try {
        await this.reloadEngine();
        this.reloadPending = false;
      } catch (error) {
        reloadError = error;
        // Sign-out cleanup must still reach the engine once it recovers.
        this.scheduleReloadRetry();
      }
    }
    if (reloadError) throw reloadError;
  }
}
