import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HttpProviderRegistration } from "@flue/runtime";
import type { Model, Provider, ProviderListResponse } from "@openwork/engine-protocol";
import { z } from "zod";
import { EnvService } from "../env-file.js";
import { resolveOpencodeModelsUrl } from "../opencode-models-url.js";
import {
  readEffectiveRuntimeOpencodeConfig,
  runtimeDisabledProviderList,
  runtimeProviderMap,
  type RuntimeOpencodeConfig,
} from "../runtime-opencode-config-store.js";
import { externalFetch } from "../server-fetch.js";
import type { ServerConfig } from "../types.js";
import {
  readFlueProviderCredentials,
  type FlueProviderCredential,
  type FlueProviderCredentialMap,
} from "./credential-vault.js";

export const FLUE_CATALOG_CACHE_FILE = join(".opencode", "openwork", "flue-catalog-cache.json");

const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
const CATALOG_FETCH_TIMEOUT_MS = 3_500;

export type FlueApiKind =
  | "openai-completions"
  | "openai-responses"
  | "openai-codex-responses"
  | "azure-openai-responses"
  | "anthropic-messages"
  | "bedrock-converse-stream"
  | "pi-messages";

export const NPM_API_KIND_TABLE: Array<{ npm: string; apiKind: FlueApiKind }> = [
  { npm: "@openrouter/ai-sdk-provider", apiKind: "openai-completions" },
  { npm: "@ai-sdk/openai-compatible", apiKind: "openai-completions" },
  { npm: "@ai-sdk/mistral", apiKind: "openai-completions" },
  { npm: "@ai-sdk/anthropic", apiKind: "anthropic-messages" },
  { npm: "@ai-sdk/openai", apiKind: "openai-responses" },
  { npm: "@ai-sdk/azure", apiKind: "azure-openai-responses" },
  { npm: "@ai-sdk/amazon-bedrock", apiKind: "bedrock-converse-stream" },
];

export type EnvMap = Record<string, string | undefined>;

const stringSchema = z.string().trim().min(1);
const modelStatusSchema = z.union([
  z.literal("alpha"),
  z.literal("beta"),
  z.literal("deprecated"),
  z.literal("active"),
]);

const rawModelSchema = z.object({
  id: stringSchema.optional(),
  name: stringSchema.optional(),
  family: stringSchema.optional(),
  status: modelStatusSchema.optional(),
  release_date: stringSchema.optional(),
  limit: z.object({
    context: z.number().finite().nonnegative().optional(),
    input: z.number().finite().nonnegative().optional(),
    output: z.number().finite().nonnegative().optional(),
  }).optional(),
  capabilities: z.object({
    temperature: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    attachment: z.boolean().optional(),
    toolcall: z.boolean().optional(),
  }).optional(),
  temperature: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  attachment: z.boolean().optional(),
  toolcall: z.boolean().optional(),
  tool_call: z.boolean().optional(),
}).passthrough();

const rawProviderSchema = z.object({
  id: stringSchema.optional(),
  name: stringSchema.optional(),
  npm: stringSchema.optional(),
  env: z.array(stringSchema).optional(),
  api: stringSchema.optional(),
  options: z.object({
    baseURL: stringSchema.optional(),
  }).passthrough().optional(),
  whitelist: z.array(stringSchema).optional(),
  blacklist: z.array(stringSchema).optional(),
  models: z.record(z.string(), rawModelSchema).optional(),
}).passthrough();

const catalogModelSchema = z.object({
  id: stringSchema,
  name: stringSchema,
  family: stringSchema.nullable(),
  status: modelStatusSchema,
  releaseDate: stringSchema,
  limit: z.object({
    context: z.number().finite().nonnegative(),
    input: z.number().finite().nonnegative().nullable(),
    output: z.number().finite().nonnegative(),
  }),
  temperature: z.boolean(),
  reasoning: z.boolean(),
  attachment: z.boolean(),
  toolcall: z.boolean(),
});

const catalogProviderSchema = z.object({
  id: stringSchema,
  name: stringSchema,
  npm: stringSchema.nullable(),
  env: z.array(stringSchema),
  api: stringSchema.nullable(),
  models: z.array(catalogModelSchema),
});

const runtimeProviderSchema = catalogProviderSchema.extend({
  catalogId: stringSchema,
  optionsBaseUrl: stringSchema.nullable(),
  whitelist: z.array(stringSchema),
  blacklist: z.array(stringSchema),
  envProvided: z.boolean(),
  modelsProvided: z.boolean(),
});

const diskCacheSchema = z.object({
  schemaVersion: z.literal(1),
  updatedAt: z.number().finite().nonnegative(),
  providers: z.array(catalogProviderSchema),
});

export type FlueCatalogModel = z.infer<typeof catalogModelSchema>;
export type FlueCatalogProvider = z.infer<typeof catalogProviderSchema>;
type FlueRuntimeProvider = z.infer<typeof runtimeProviderSchema>;

export type FlueCatalogSkip = {
  providerId: string;
  reason: string;
};

export type FlueCatalogParseResult = {
  providers: FlueCatalogProvider[];
  skipped: FlueCatalogSkip[];
};

export type FlueProviderRegistration = {
  providerId: string;
  registration: HttpProviderRegistration;
};

export type FlueCatalogMaterialization = {
  providerList: ProviderListResponse;
  registrations: FlueProviderRegistration[];
  skipped: FlueCatalogSkip[];
  catalogSource: string;
};

export type FlueCatalogDiagnostics = {
  catalogSource: string;
  connectedProviderIds: string[];
  registeredProviderIds: string[];
  skipped: FlueCatalogSkip[];
};

type CatalogLoadResult = FlueCatalogParseResult & {
  source: string;
};

export type CatalogFetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type CatalogFetch = (input: string, init?: RequestInit) => Promise<CatalogFetchResponse>;

export type FlueCatalogBridgeOptions = {
  cachePath: string;
  resolveModelsUrl?: () => Promise<string>;
  fetchCatalog?: CatalogFetch;
  readEnvStore?: () => Promise<EnvMap>;
  readVaultCredentials?: (config: ServerConfig) => Promise<FlueProviderCredentialMap>;
  readRuntimeConfig?: (config: ServerConfig, workspaceId: string) => Promise<RuntimeOpencodeConfig>;
  now?: () => number;
  fetchTimeoutMs?: number;
};

type MemoryCatalog = {
  expiresAt: number;
  providers: FlueCatalogProvider[];
  skipped: FlueCatalogSkip[];
  source: "url";
};

type ApiKindResult = {
  ok: true;
  apiKind: FlueApiKind;
} | {
  ok: false;
  reason: string;
};

type CredentialResolution = {
  envName: string | null;
  value: string | null;
};

type ProviderCandidate = {
  id: string;
  name: string;
  npm: string | null;
  env: string[];
  api: string | null;
  models: FlueCatalogModel[];
  fromRuntime: boolean;
};

let memoryCatalog: MemoryCatalog | null = null;
let catalogFetchInFlight: Promise<FlueCatalogParseResult> | null = null;
let loggedCatalogFailure = false;
let loggedMaterializationFailure = false;

export function resetFlueCatalogCacheForTest(): void {
  memoryCatalog = null;
  catalogFetchInFlight = null;
  loggedCatalogFailure = false;
  loggedMaterializationFailure = false;
}

export function catalogApiJsonUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (trimmed.endsWith("/api.json")) return trimmed;
  return `${trimmed.replace(/\/+$/, "")}/api.json`;
}

function normalizeStringList(values: string[] | undefined): string[] {
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed && !normalized.includes(trimmed)) normalized.push(trimmed);
  }
  return normalized;
}

function normalizeModel(modelKey: string, rawModel: z.infer<typeof rawModelSchema>): FlueCatalogModel {
  const id = rawModel.id ?? modelKey;
  const limit = rawModel.limit;
  const capabilities = rawModel.capabilities;
  return {
    id,
    name: rawModel.name ?? id,
    family: rawModel.family ?? null,
    status: rawModel.status ?? "active",
    releaseDate: rawModel.release_date ?? "2026-01-01",
    limit: {
      context: limit?.context ?? 0,
      input: limit?.input ?? null,
      output: limit?.output ?? 0,
    },
    temperature: capabilities?.temperature ?? rawModel.temperature ?? true,
    reasoning: capabilities?.reasoning ?? rawModel.reasoning ?? false,
    attachment: capabilities?.attachment ?? rawModel.attachment ?? false,
    toolcall: capabilities?.toolcall ?? rawModel.toolcall ?? rawModel.tool_call ?? true,
  };
}

function normalizeProvider(providerKey: string, rawProvider: unknown): FlueCatalogProvider | null {
  const parsed = rawProviderSchema.safeParse(rawProvider);
  if (!parsed.success) return null;
  const provider = parsed.data;
  const id = provider.id ?? providerKey;
  const models: FlueCatalogModel[] = [];
  for (const [modelKey, rawModel] of Object.entries(provider.models ?? {})) {
    models.push(normalizeModel(modelKey, rawModel));
  }
  models.sort((left, right) => left.id.localeCompare(right.id));
  return {
    id,
    name: provider.name ?? id,
    npm: provider.npm ?? null,
    env: normalizeStringList(provider.env),
    api: provider.api ?? null,
    models,
  };
}

function normalizeRuntimeProvider(providerKey: string, rawProvider: unknown): FlueRuntimeProvider | null {
  const parsed = rawProviderSchema.safeParse(rawProvider);
  if (!parsed.success) return null;
  const provider = parsed.data;
  const models: FlueCatalogModel[] = [];
  for (const [modelKey, rawModel] of Object.entries(provider.models ?? {})) {
    models.push(normalizeModel(modelKey, rawModel));
  }
  models.sort((left, right) => left.id.localeCompare(right.id));
  return {
    id: providerKey,
    catalogId: provider.id ?? providerKey,
    name: provider.name ?? provider.id ?? providerKey,
    npm: provider.npm ?? null,
    env: normalizeStringList(provider.env),
    api: provider.api ?? null,
    models,
    optionsBaseUrl: provider.options?.baseURL ?? null,
    whitelist: normalizeStringList(provider.whitelist),
    blacklist: normalizeStringList(provider.blacklist),
    envProvided: provider.env !== undefined,
    modelsProvided: provider.models !== undefined,
  };
}

export function parseFlueCatalogPayload(payload: unknown): FlueCatalogParseResult {
  const recordResult = z.record(z.string(), z.unknown()).safeParse(payload);
  if (!recordResult.success) {
    return { providers: [], skipped: [{ providerId: "__catalog__", reason: "malformed" }] };
  }

  const providers: FlueCatalogProvider[] = [];
  const skipped: FlueCatalogSkip[] = [];
  for (const [providerKey, rawProvider] of Object.entries(recordResult.data)) {
    const provider = normalizeProvider(providerKey, rawProvider);
    if (provider) providers.push(provider);
    else skipped.push({ providerId: providerKey, reason: "malformed" });
  }
  providers.sort((left, right) => left.id.localeCompare(right.id));
  return { providers, skipped };
}

function providerModelsById(models: FlueCatalogModel[]): Map<string, FlueCatalogModel> {
  const out = new Map<string, FlueCatalogModel>();
  for (const model of models) out.set(model.id, model);
  return out;
}

function filteredModels(models: FlueCatalogModel[], whitelist: string[], blacklist: string[]): FlueCatalogModel[] {
  const allow = new Set(whitelist);
  const block = new Set(blacklist);
  return models.filter((model) => (allow.size === 0 || allow.has(model.id)) && !block.has(model.id));
}

function mergeProvider(candidateId: string, catalogProvider: FlueCatalogProvider | undefined, runtimeProvider: FlueRuntimeProvider | undefined): ProviderCandidate {
  const catalogModels = catalogProvider?.models ?? [];
  const models = runtimeProvider?.modelsProvided ? runtimeProvider.models : catalogModels;
  const filtered = runtimeProvider
    ? filteredModels(models, runtimeProvider.whitelist, runtimeProvider.blacklist)
    : models;
  return {
    id: candidateId,
    name: runtimeProvider?.name ?? catalogProvider?.name ?? candidateId,
    npm: runtimeProvider?.npm ?? catalogProvider?.npm ?? null,
    env: runtimeProvider?.envProvided ? runtimeProvider.env : catalogProvider?.env ?? [],
    api: runtimeProvider?.optionsBaseUrl ?? runtimeProvider?.api ?? catalogProvider?.api ?? null,
    models: filtered,
    fromRuntime: Boolean(runtimeProvider),
  };
}

function trimmedEnvValue(env: EnvMap, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

export function resolveProviderCredential(envNames: string[], envStore: EnvMap, processEnv: EnvMap): CredentialResolution {
  for (const envName of envNames) {
    const value = trimmedEnvValue(envStore, envName);
    if (value) return { envName, value };
  }
  for (const envName of envNames) {
    const value = trimmedEnvValue(processEnv, envName);
    if (value) return { envName, value };
  }
  return { envName: null, value: null };
}

export function resolveProviderCredentialWithVault(
  vaultCredential: FlueProviderCredential | undefined,
  envNames: string[],
  envStore: EnvMap,
  processEnv: EnvMap,
): CredentialResolution {
  const vaultValue = vaultCredential?.key.trim();
  if (vaultValue) return { envName: null, value: vaultValue };
  return resolveProviderCredential(envNames, envStore, processEnv);
}

export function normalizeOpenWorkInferenceBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/api/v1")) return trimmed;
  return `${trimmed}/api/v1`;
}

function resolveOpenWorkBaseUrl(candidate: ProviderCandidate, envStore: EnvMap, processEnv: EnvMap): string | null {
  if (candidate.id !== "openwork") return candidate.api;
  const override = resolveProviderCredential(["OPENWORK_INFERENCE_BASE_URL"], envStore, processEnv).value;
  if (override) return normalizeOpenWorkInferenceBaseUrl(override);
  return candidate.api;
}

function defaultBaseUrlForProvider(candidate: ProviderCandidate, apiKind: FlueApiKind): string | null {
  if (apiKind === "anthropic-messages") return "https://api.anthropic.com";
  if (apiKind === "openai-responses") return "https://api.openai.com/v1";
  if (candidate.npm === "@ai-sdk/mistral") return "https://api.mistral.ai/v1";
  return null;
}

function hasOpenAiCompatibilityMarker(value: string | null): boolean {
  const normalized = value?.toLowerCase() ?? "";
  return normalized.includes("openai")
    || normalized.includes("openrouter")
    || normalized.includes("openwork")
    || normalized.includes("compatible");
}

export function apiKindForProvider(input: { id: string; name: string; npm: string | null; baseUrl: string | null }): ApiKindResult {
  if (input.npm) {
    for (const row of NPM_API_KIND_TABLE) {
      if (row.npm === input.npm) return { ok: true, apiKind: row.apiKind };
    }
  }
  if (
    hasOpenAiCompatibilityMarker(input.npm)
    || hasOpenAiCompatibilityMarker(input.id)
    || hasOpenAiCompatibilityMarker(input.name)
    || hasOpenAiCompatibilityMarker(input.baseUrl)
  ) {
    return { ok: true, apiKind: "openai-completions" };
  }
  return { ok: false, reason: `unsupported_npm:${input.npm ?? "missing"}` };
}

function registrationModels(models: FlueCatalogModel[]): Record<string, { contextWindow?: number; maxTokens?: number }> {
  const out: Record<string, { contextWindow?: number; maxTokens?: number }> = {};
  for (const model of models) {
    out[model.id] = {
      contextWindow: model.limit.context,
      maxTokens: model.limit.output,
    };
  }
  return out;
}

function engineModel(input: { provider: ProviderCandidate; model: FlueCatalogModel; apiKind: string; baseUrl: string | null }): Model {
  return {
    id: input.model.id,
    providerID: input.provider.id,
    api: { id: input.apiKind, url: input.baseUrl ?? "", npm: input.provider.npm ?? "" },
    name: input.model.name,
    family: input.model.family ?? input.provider.id,
    capabilities: {
      temperature: input.model.temperature,
      reasoning: input.model.reasoning,
      attachment: input.model.attachment,
      toolcall: input.model.toolcall,
      input: { text: true, audio: false, image: input.model.attachment, video: false, pdf: input.model.attachment },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: {
      context: input.model.limit.context,
      ...(input.model.limit.input !== null ? { input: input.model.limit.input } : {}),
      output: input.model.limit.output,
    },
    status: input.model.status,
    options: {},
    headers: {},
    release_date: input.model.releaseDate,
  };
}

function engineProvider(input: { provider: ProviderCandidate; apiKind: string; baseUrl: string | null }): Provider {
  const models: Record<string, Model> = {};
  for (const model of input.provider.models) {
    models[model.id] = engineModel({ provider: input.provider, model, apiKind: input.apiKind, baseUrl: input.baseUrl });
  }
  const source: Provider["source"] = input.provider.fromRuntime ? "config" : "env";
  return {
    id: input.provider.id,
    name: input.provider.name,
    source,
    env: input.provider.env,
    options: {},
    models,
  };
}

function defaultModelMap(providers: Provider[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const provider of providers) {
    const firstModelId = Object.keys(provider.models)[0];
    if (firstModelId) out[provider.id] = firstModelId;
  }
  return out;
}

function disabledProviderSet(config: RuntimeOpencodeConfig): Set<string> {
  const providerIds = new Set<string>();
  for (const providerId of runtimeDisabledProviderList(config)) {
    const trimmed = providerId.trim();
    if (trimmed) providerIds.add(trimmed);
  }
  return providerIds;
}

function deterministicOnlyMaterialization(input: {
  runtimeConfig: RuntimeOpencodeConfig;
  deterministicProvider: Provider;
  skipped: FlueCatalogSkip[];
}): FlueCatalogMaterialization {
  const disabled = disabledProviderSet(input.runtimeConfig).has(input.deterministicProvider.id);
  const providers = disabled ? [] : [input.deterministicProvider];
  return {
    providerList: {
      all: providers,
      default: defaultModelMap(providers),
      connected: providers.map((provider) => provider.id),
    },
    registrations: [],
    skipped: [
      ...input.skipped,
      ...(disabled ? [{ providerId: input.deterministicProvider.id, reason: "disabled" }] : []),
      { providerId: "__materialization__", reason: "materialization_failed" },
    ],
    catalogSource: "deterministic-only",
  };
}

export function materializeFlueCatalog(input: {
  catalogProviders: FlueCatalogProvider[];
  catalogSkips?: FlueCatalogSkip[];
  catalogSource?: string;
  runtimeConfig: RuntimeOpencodeConfig;
  envStore: EnvMap;
  processEnv: EnvMap;
  vaultCredentials?: FlueProviderCredentialMap;
  deterministicProvider: Provider;
}): FlueCatalogMaterialization {
  const catalogById = new Map<string, FlueCatalogProvider>();
  for (const provider of input.catalogProviders) catalogById.set(provider.id, provider);

  const runtimeById = new Map<string, FlueRuntimeProvider>();
  const runtimeCatalogIds = new Set<string>();
  const skipped: FlueCatalogSkip[] = [...input.catalogSkips ?? []];
  for (const [providerKey, rawProvider] of Object.entries(runtimeProviderMap(input.runtimeConfig))) {
    try {
      const provider = normalizeRuntimeProvider(providerKey, rawProvider);
      if (provider) {
        runtimeById.set(provider.id, provider);
        runtimeCatalogIds.add(provider.catalogId);
      }
      else skipped.push({ providerId: providerKey, reason: "malformed" });
    } catch {
      skipped.push({ providerId: providerKey, reason: "materialization_failed" });
    }
  }

  const disabled = disabledProviderSet(input.runtimeConfig);
  const vaultCredentials = input.vaultCredentials ?? {};
  const candidateIds = new Set<string>();
  for (const provider of input.catalogProviders) {
    try {
      if (runtimeCatalogIds.has(provider.id)) continue;
      if (resolveProviderCredentialWithVault(vaultCredentials[provider.id], provider.env, input.envStore, input.processEnv).value) {
        candidateIds.add(provider.id);
      }
    } catch {
      skipped.push({ providerId: provider.id, reason: "materialization_failed" });
    }
  }
  for (const providerId of runtimeById.keys()) candidateIds.add(providerId);

  const listedProviders: Provider[] = [];
  const connectedProviders: Provider[] = [];
  const registrations: FlueProviderRegistration[] = [];
  const sortedCandidateIds = [...candidateIds].sort((left, right) => left.localeCompare(right));
  for (const providerId of sortedCandidateIds) {
    try {
      const runtimeProvider = runtimeById.get(providerId);
      const catalogProvider = catalogById.get(runtimeProvider?.catalogId ?? providerId);
      const candidate = mergeProvider(providerId, catalogProvider, runtimeProvider);
      if (disabled.has(providerId)) {
        skipped.push({ providerId, reason: "disabled" });
        continue;
      }
      const modelsById = providerModelsById(candidate.models);
      candidate.models = [...modelsById.values()].sort((left, right) => left.id.localeCompare(right.id));
      if (candidate.models.length === 0) {
        if (runtimeProvider) skipped.push({ providerId, reason: "malformed" });
        continue;
      }

      const credential = resolveProviderCredentialWithVault(
        vaultCredentials[providerId],
        candidate.env,
        input.envStore,
        input.processEnv,
      );
      if (candidate.env.length > 0 && !credential.value && !candidate.fromRuntime) {
        skipped.push({ providerId, reason: "no_credential" });
        continue;
      }
      if (candidate.env.length === 0 && !candidate.fromRuntime) {
        skipped.push({ providerId, reason: "no_credential" });
        continue;
      }

      const configuredBaseUrl = resolveOpenWorkBaseUrl(candidate, input.envStore, input.processEnv);
      const apiKind = apiKindForProvider({ id: candidate.id, name: candidate.name, npm: candidate.npm, baseUrl: configuredBaseUrl });
      if (!apiKind.ok) {
        if (candidate.fromRuntime) {
          listedProviders.push(engineProvider({ provider: candidate, apiKind: "unsupported", baseUrl: configuredBaseUrl }));
        }
        skipped.push({ providerId, reason: "unmappable_npm" });
        continue;
      }

      const baseUrl = configuredBaseUrl ?? defaultBaseUrlForProvider(candidate, apiKind.apiKind);
      const provider = engineProvider({ provider: candidate, apiKind: apiKind.apiKind, baseUrl });
      listedProviders.push(provider);
      if (apiKind.apiKind === "bedrock-converse-stream") {
        skipped.push({ providerId, reason: "unsupported_credential_scheme" });
        continue;
      }
      if (!baseUrl) {
        skipped.push({ providerId, reason: "missing_base_url" });
        continue;
      }
      if (candidate.env.length > 0 && !credential.value) {
        skipped.push({ providerId, reason: "no_credential" });
        continue;
      }

      const registration: HttpProviderRegistration = {
        api: apiKind.apiKind,
        baseUrl,
        ...(credential.value ? { apiKey: credential.value } : {}),
        models: registrationModels(candidate.models),
      };
      registrations.push({ providerId, registration });
      connectedProviders.push(provider);
    } catch {
      skipped.push({ providerId, reason: "materialization_failed" });
    }
  }

  const deterministicDisabled = disabled.has(input.deterministicProvider.id);
  if (deterministicDisabled) skipped.push({ providerId: input.deterministicProvider.id, reason: "disabled" });
  const all = deterministicDisabled ? listedProviders : [input.deterministicProvider, ...listedProviders];
  const connected = deterministicDisabled ? connectedProviders : [input.deterministicProvider, ...connectedProviders];
  return {
    providerList: {
      all,
      default: defaultModelMap(connected),
      connected: connected.map((provider) => provider.id),
    },
    registrations,
    skipped,
    catalogSource: input.catalogSource ?? "memory",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isValidProviderSource(value: unknown): value is Provider["source"] {
  return value === "env" || value === "config" || value === "custom" || value === "api";
}

function isValidModelStatus(value: unknown): value is Model["status"] {
  return value === "alpha" || value === "beta" || value === "deprecated" || value === "active";
}

function isEngineModel(value: unknown): value is Model {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.providerID !== "string" || typeof value.name !== "string") return false;
  if (!isRecord(value.api) || typeof value.api.id !== "string" || typeof value.api.url !== "string" || typeof value.api.npm !== "string") return false;
  if (!isRecord(value.capabilities) || !isRecord(value.cost) || !isRecord(value.limit)) return false;
  if (typeof value.limit.context !== "number" || typeof value.limit.output !== "number") return false;
  if (!isValidModelStatus(value.status)) return false;
  return isRecord(value.options) && isRecord(value.headers) && typeof value.release_date === "string";
}

function isModelRecord(value: unknown): value is Record<string, Model> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isEngineModel);
}

function isEngineProvider(value: unknown): value is Provider {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.name !== "string" || !isValidProviderSource(value.source)) return false;
  if (!isStringArray(value.env) || !isRecord(value.options)) return false;
  return isModelRecord(value.models);
}

function isProviderListResponse(value: unknown): value is ProviderListResponse {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.all) || !value.all.every(isEngineProvider)) return false;
  if (!isStringArray(value.connected)) return false;
  if (!isRecord(value.default)) return false;
  return Object.values(value.default).every((modelId) => typeof modelId === "string");
}

export const flueProviderListResponseSchema = z.custom<ProviderListResponse>(
  isProviderListResponse,
  "Invalid provider list response",
);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logCatalogFailure(reason: string): void {
  if (loggedCatalogFailure) return;
  loggedCatalogFailure = true;
  console.warn("[flue-catalog] model catalog unavailable; using cached/runtime/deterministic fallback", { reason });
}

function logMaterializationFailure(): void {
  if (loggedMaterializationFailure) return;
  loggedMaterializationFailure = true;
  console.warn("[flue-catalog] provider materialization failed; using deterministic fallback", {
    reason: "materialization_failed",
  });
}

async function defaultReadEnvStore(): Promise<EnvMap> {
  return EnvService.readForProviderLookup();
}

async function defaultReadRuntimeConfig(config: ServerConfig, workspaceId: string): Promise<RuntimeOpencodeConfig> {
  return readEffectiveRuntimeOpencodeConfig(config, workspaceId);
}

function defaultFetchCatalog(input: string, init?: RequestInit): Promise<CatalogFetchResponse> {
  return externalFetch(input, init);
}

export class FlueCatalogBridge {
  private readonly cachePath: string;
  private readonly resolveModelsUrl: () => Promise<string>;
  private readonly fetchCatalog: CatalogFetch;
  private readonly readEnvStore: () => Promise<EnvMap>;
  private readonly readVaultCredentials: (config: ServerConfig) => Promise<FlueProviderCredentialMap>;
  private readonly readRuntimeConfig: (config: ServerConfig, workspaceId: string) => Promise<RuntimeOpencodeConfig>;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private lastDiagnostics: FlueCatalogDiagnostics | null = null;

  constructor(options: FlueCatalogBridgeOptions) {
    this.cachePath = options.cachePath;
    this.resolveModelsUrl = options.resolveModelsUrl ?? resolveOpencodeModelsUrl;
    this.fetchCatalog = options.fetchCatalog ?? defaultFetchCatalog;
    this.readEnvStore = options.readEnvStore ?? defaultReadEnvStore;
    this.readVaultCredentials = options.readVaultCredentials ?? readFlueProviderCredentials;
    this.readRuntimeConfig = options.readRuntimeConfig ?? defaultReadRuntimeConfig;
    this.now = options.now ?? Date.now;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? CATALOG_FETCH_TIMEOUT_MS;
  }

  diagnostics(): FlueCatalogDiagnostics | null {
    return this.lastDiagnostics;
  }

  updateDiagnostics(materialization: FlueCatalogMaterialization): void {
    this.lastDiagnostics = {
      catalogSource: materialization.catalogSource,
      connectedProviderIds: materialization.providerList.connected,
      registeredProviderIds: materialization.registrations.map((registration) => registration.providerId),
      skipped: materialization.skipped,
    };
  }

  async materializeForWorkspace(input: {
    config: ServerConfig;
    workspaceId: string;
    deterministicProvider: Provider;
    processEnv?: EnvMap;
    allowNetwork?: boolean;
  }): Promise<FlueCatalogMaterialization> {
    const [runtimeConfig, envStore, vaultCredentials] = await Promise.all([
      this.readRuntimeConfig(input.config, input.workspaceId).catch(() => ({})),
      this.readEnvStore().catch(() => ({})),
      this.readVaultCredentials(input.config).catch(() => ({})),
    ]);
    return this.materialize({
      runtimeConfig,
      envStore,
      vaultCredentials,
      processEnv: input.processEnv ?? process.env,
      deterministicProvider: input.deterministicProvider,
      allowNetwork: input.allowNetwork,
    });
  }

  async materialize(input: {
    runtimeConfig: RuntimeOpencodeConfig;
    envStore: EnvMap;
    processEnv: EnvMap;
    vaultCredentials?: FlueProviderCredentialMap;
    deterministicProvider: Provider;
    allowNetwork?: boolean;
  }): Promise<FlueCatalogMaterialization> {
    let materialization: FlueCatalogMaterialization;
    try {
      const catalog = await this.loadCatalog(input.allowNetwork ?? true);
      materialization = materializeFlueCatalog({
        catalogProviders: catalog.providers,
        catalogSkips: catalog.skipped,
        catalogSource: catalog.source,
        runtimeConfig: input.runtimeConfig,
        envStore: input.envStore,
        processEnv: input.processEnv,
        vaultCredentials: input.vaultCredentials,
        deterministicProvider: input.deterministicProvider,
      });
      if (materialization.catalogSource === "empty") {
        materialization.catalogSource = materialization.providerList.all.some(
          (provider) => provider.id !== input.deterministicProvider.id,
        ) ? "runtime-only" : "deterministic-only";
      }
    } catch {
      logMaterializationFailure();
      materialization = deterministicOnlyMaterialization({
        runtimeConfig: input.runtimeConfig,
        deterministicProvider: input.deterministicProvider,
        skipped: [],
      });
    }
    this.updateDiagnostics(materialization);
    console.info("[flue-catalog] materialized", {
      source: materialization.catalogSource,
      registered: materialization.registrations.length,
      listed: materialization.providerList.all.length,
      connected: materialization.providerList.connected.length,
      skipped: materialization.skipped.map((item) => ({ providerId: item.providerId, reason: item.reason })),
    });
    return materialization;
  }

  private async loadCatalog(allowNetwork: boolean): Promise<CatalogLoadResult> {
    const now = this.now();
    if (memoryCatalog && (allowNetwork ? memoryCatalog.expiresAt > now : true)) {
      return { providers: memoryCatalog.providers, skipped: memoryCatalog.skipped, source: memoryCatalog.source };
    }

    if (allowNetwork) {
      try {
        const remote = await this.remoteCatalog();
        memoryCatalog = {
          providers: remote.providers,
          skipped: remote.skipped,
          expiresAt: this.now() + CATALOG_CACHE_TTL_MS,
          source: "url",
        };
        await this.writeDiskCatalog(remote.providers).catch(() => undefined);
        return { ...remote, source: "url" };
      } catch (error) {
        logCatalogFailure(describeError(error));
      }
    }

    const disk = await this.readDiskCatalog();
    if (disk) return disk;
    return { providers: [], skipped: [], source: "empty" };
  }

  private async remoteCatalog(): Promise<FlueCatalogParseResult> {
    if (!catalogFetchInFlight) {
      catalogFetchInFlight = this.remoteCatalogOnce().finally(() => {
        catalogFetchInFlight = null;
      });
    }
    return catalogFetchInFlight;
  }

  private async remoteCatalogOnce(): Promise<FlueCatalogParseResult> {
    const baseUrl = await this.resolveModelsUrl();
    const response = await this.fetchCatalog(catalogApiJsonUrl(baseUrl), {
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
      headers: { Accept: "application/json", "User-Agent": "OpenWork Flue facade" },
    });
    if (!response.ok) throw new Error(`models catalog returned ${response.status}`);
    const payload: unknown = await response.json();
    return parseFlueCatalogPayload(payload);
  }

  private async readDiskCatalog(): Promise<CatalogLoadResult | null> {
    try {
      const raw = await readFile(this.cachePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      const cache = diskCacheSchema.safeParse(parsed);
      if (!cache.success) return null;
      return { providers: cache.data.providers, skipped: [], source: "disk-cache" };
    } catch {
      return null;
    }
  }

  private async writeDiskCatalog(providers: FlueCatalogProvider[]): Promise<void> {
    await mkdir(dirname(this.cachePath), { recursive: true });
    const tmpPath = `${this.cachePath}.${process.pid}.${this.now()}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify({ schemaVersion: 1, updatedAt: this.now(), providers }, null, 2)}\n`, "utf8");
      await rename(tmpPath, this.cachePath);
    } finally {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
  }
}
