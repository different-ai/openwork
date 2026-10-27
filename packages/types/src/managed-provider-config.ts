import { catalogModelVariants } from "./cloud-model-fast.js";

type JsonRecord = Record<string, unknown>;

export type ManagedProviderModel = { id: string; name: string; config: JsonRecord };
type ManagedProviderModelConfig = { id: string; name: string } & JsonRecord;
export type ManagedProviderConfigInput = {
  providerId: string;
  name: string;
  source: string | null;
  /** Environment names and SDK bindings must already use this target's runtime names. */
  providerConfig: JsonRecord;
  models: readonly ManagedProviderModel[];
};
export type ManagedProviderConfig = {
  id: string;
  name: string;
  env: string[];
  models?: Record<string, ManagedProviderModelConfig>;
  npm?: string;
  api?: string;
  options?: JsonRecord;
  whitelist?: string[];
  blacklist?: string[];
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}
export function readProviderEnvNames(providerConfig: JsonRecord): string[] {
  return readStringList(providerConfig.env);
}

function credentialEnvRank(name: string): number | null {
  const normalized = name.trim().toUpperCase();
  if (/(^|_)API_KEY$/.test(normalized)) return 0;
  if (/(^|_)ACCESS_KEY_ID$/.test(normalized)) return 1;
  if (/(^|_)BEARER_TOKEN(_|$)/.test(normalized) || /(^|_)TOKEN$/.test(normalized)) return 2;
  if (/(^|_)KEY$/.test(normalized)) return 3;
  return null;
}

export function selectPrimaryCredentialEnvName(
  envNames: string[],
  availableNames: Iterable<string>,
): string | null {
  const available = new Set([...availableNames].filter((name) => name.trim().length > 0));
  const orderedNames = envNames.filter((name) => available.has(name));
  const ranked = orderedNames
    .map((name, index) => ({ name, index, rank: credentialEnvRank(name) }))
    .filter((entry): entry is { name: string; index: number; rank: number } => entry.rank !== null)
    .sort((left, right) => left.rank - right.rank || left.index - right.index);
  if (ranked[0]) return ranked[0].name;
  if (envNames.length > 1 && envNames.some((name) => credentialEnvRank(name) !== null)) return null;
  return orderedNames[0] ?? null;
}

export function selectLegacyScalarCredentialEnvName(envNames: string[]): string | null {
  return selectPrimaryCredentialEnvName(envNames, envNames) ?? envNames[0] ?? null;
}

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

function buildModelConfig(model: ManagedProviderModel, providerNpm: unknown): ManagedProviderModelConfig {
  const next: ManagedProviderModelConfig = { id: model.id, name: model.name };
  for (const key of modelConfigPassthroughKeys) {
    const value = model.config[key];
    if (value !== undefined) next[key] = value;
  }
  const variants = catalogModelVariants(model.config, providerNpm);
  if (variants) next.variants = variants;
  return next;
}

/** Build the engine provider block shared by Desktop, server sync and cloud workers. */
export function buildManagedProviderConfig(provider: ManagedProviderConfigInput): ManagedProviderConfig {
  const models = Object.fromEntries(
    [...provider.models]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((model): [string, ManagedProviderModelConfig] => [model.id, buildModelConfig(model, provider.providerConfig.npm)]),
  );
  const config: ManagedProviderConfig = {
    id: provider.providerId,
    name: provider.name,
    env: readProviderEnvNames(provider.providerConfig),
  };
  if (Object.keys(models).length > 0 || provider.source !== "openwork") config.models = models;

  const npm = readString(provider.providerConfig.npm);
  if (npm) config.npm = npm;
  const api = readString(provider.providerConfig.api);
  if (api) config.api = api;
  if (isRecord(provider.providerConfig.options)) config.options = provider.providerConfig.options;
  const whitelist = readStringList(provider.providerConfig.whitelist);
  if (Array.isArray(provider.providerConfig.whitelist)) config.whitelist = whitelist;
  const blacklist = readStringList(provider.providerConfig.blacklist);
  if (blacklist.length > 0) config.blacklist = blacklist;
  return config;
}

