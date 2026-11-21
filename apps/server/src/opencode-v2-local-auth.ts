import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { opencodeDataDirs, resolveGlobalOpencodeConfigPath } from "@openwork/paths";
import { readJsoncFile } from "./jsonc.js";
import { ORGANIZATION_PROVIDER_ID } from "./organization-provider-gate.js";
import { loopbackFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";

type EngineV1Connection = Pick<ServerConfig, "opencodeBaseUrl" | "opencodeUsername" | "opencodePassword">;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export type EngineV2SkippedProviderReason = "policy" | "oauth" | "unsupported" | "metadata" | "credentials";

export interface EngineV2SkippedProvider {
  id: string;
  reason: EngineV2SkippedProviderReason;
}

export interface LocalProviderAuth {
  apiKeys: Map<string, string>;
  signIns: Set<string>;
}

export async function readLocalProviderAuth(path = join(opencodeDataDirs()[0], "auth.json")): Promise<LocalProviderAuth> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, "utf8")); } catch (error) {
    if (record(error) && error.code === "ENOENT") return { apiKeys: new Map(), signIns: new Set() };
    throw new Error("Could not read local provider credentials");
  }
  const apiKeys = new Map<string, string>();
  const signIns = new Set<string>();
  for (const [id, auth] of record(value) ? Object.entries(value) : []) {
    if (!record(auth) || typeof auth.type !== "string") continue;
    if (auth.type === "api") {
      if (typeof auth.key === "string" && auth.key.trim()) apiKeys.set(id, auth.key);
    } else {
      signIns.add(id);
    }
  }
  return { apiKeys, signIns };
}

export async function readUserConfigProviders(path = resolveGlobalOpencodeConfigPath()): Promise<{
  directory: string;
  providers: Record<string, Record<string, unknown>>;
}> {
  const directory = dirname(path);
  let value: unknown;
  try {
    value = (await readJsoncFile<unknown>(path, {}, { allowInvalid: true, regularFileOnly: true })).data;
  } catch {
    return { directory, providers: {} };
  }
  const providers = record(value) && record(value.provider) ? value.provider : {};
  return {
    directory,
    providers: Object.fromEntries(Object.entries(providers).flatMap(([id, provider]) => record(provider) ? [[id, provider]] : [])),
  };
}

export async function readLocalProviderApiKeys(path?: string): Promise<Map<string, string>> {
  return (await readLocalProviderAuth(path)).apiKeys;
}

type Normalized = { definition: Record<string, unknown> } | { reason: "metadata" };

function enabledKinds(value: unknown): string[] | undefined {
  return record(value) ? Object.entries(value).flatMap(([kind, enabled]) => enabled === true ? [kind] : []) : undefined;
}

function modelsDevModel(id: string, model: Record<string, unknown>, api: Record<string, unknown>): Record<string, unknown> {
  const capabilities = record(model.capabilities) ? model.capabilities : {};
  const input = enabledKinds(capabilities.input);
  const output = enabledKinds(capabilities.output);
  return {
    id: typeof api.id === "string" && api.id.trim() ? api.id : id,
    name: typeof model.name === "string" && model.name.trim() ? model.name : id,
    ...(typeof model.family === "string" ? { family: model.family } : {}),
    ...(typeof capabilities.toolcall === "boolean" ? { tool_call: capabilities.toolcall } : {}),
    ...(typeof capabilities.reasoning === "boolean" ? { reasoning: capabilities.reasoning } : {}),
    ...(typeof capabilities.attachment === "boolean" ? { attachment: capabilities.attachment } : {}),
    ...(typeof capabilities.temperature === "boolean" ? { temperature: capabilities.temperature } : {}),
    ...(input?.length || output?.length ? { modalities: { input: input?.length ? input : ["text"], output: output?.length ? output : ["text"] } } : {}),
    ...(record(model.limit) ? { limit: model.limit } : {}),
    ...(typeof model.status === "string" ? { status: model.status } : {}),
    ...(record(model.variants) ? { variants: model.variants } : {}),
    ...(record(model.options) && Object.keys(model.options).length ? { options: model.options } : {}),
    ...(record(model.headers) && Object.keys(model.headers).length ? { headers: model.headers } : {}),
  };
}

export function normalizeLocalProviderDefinition(value: unknown): Normalized {
  if (!record(value) || !record(value.models)) return { reason: "metadata" };
  const base = {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    env: Array.isArray(value.env) ? value.env.filter((name): name is string => typeof name === "string") : [],
  };
  if (typeof value.npm === "string") {
    return { definition: { ...base, npm: value.npm, ...(typeof value.api === "string" ? { api: value.api } : {}), models: value.models } };
  }
  let shared: { npm: string; url: string | undefined } | undefined;
  const models: Record<string, unknown> = {};
  for (const [id, model] of Object.entries(value.models)) {
    if (!record(model) || !record(model.api) || typeof model.api.npm !== "string" || !model.api.npm.trim()) return { reason: "metadata" };
    const url = typeof model.api.url === "string" && model.api.url.trim() ? model.api.url.trim() : undefined;
    if (shared && (shared.npm !== model.api.npm || shared.url !== url)) return { reason: "metadata" };
    shared ??= { npm: model.api.npm, url };
    models[id] = modelsDevModel(id, model, model.api);
  }
  if (!shared) return { reason: "metadata" };
  return { definition: { ...base, npm: shared.npm, ...(shared.url ? { api: shared.url } : {}), models } };
}

export interface EngineV2NativeProvider {
  name: string;
  env: string[];
}

export type EngineV2NativeProviders = ReadonlyMap<string, EngineV2NativeProvider>;

export function parseEngineV2NativeProviders(value: unknown): Map<string, EngineV2NativeProvider> {
  const native = new Map<string, EngineV2NativeProvider>();
  for (const integration of record(value) && Array.isArray(value.data) ? value.data : []) {
    if (!record(integration) || typeof integration.id !== "string" || !Array.isArray(integration.methods)) continue;
    const methods = integration.methods.filter(record);
    if (!methods.some(method => typeof method.type === "string" && method.type !== "key")) continue;
    native.set(integration.id, {
      name: typeof integration.name === "string" && integration.name.trim() ? integration.name : integration.id,
      env: methods.flatMap(method => method.type === "env" && Array.isArray(method.names)
        ? method.names.filter((name): name is string => typeof name === "string" && name.trim() !== "") : []),
    });
  }
  return native;
}

const NEEDS_MORE_THAN_A_KEY = /^(?:azure|amazon-bedrock|google-vertex|cloudflare)/;

export function environmentProviderKey(id: string, provider: EngineV2NativeProvider, environment: NodeJS.ProcessEnv): string | undefined {
  if (NEEDS_MORE_THAN_A_KEY.test(id)) return undefined;
  if (!provider.env.length || !provider.env.every(name => /^[A-Z0-9_]+_API_KEY$/.test(name))) return undefined;
  for (const name of provider.env) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export type LocalProvider =
  | { id: string; status: "ready"; definition: Record<string, unknown>; apiKey: string }
  | { id: string; status: "native"; name: string; apiKey: string }
  | { id: string; status: "skipped"; reason: EngineV2SkippedProviderReason };

export interface LocalProviderOptions {
  allows?: ((providerId: string) => boolean) | null;
  native?: EngineV2NativeProviders;
  environment?: NodeJS.ProcessEnv;
  onCatalogError?: (error: Error) => void;
}

export async function resolveLocalProviders(
  config: EngineV1Connection,
  auth: LocalProviderAuth,
  configured: Record<string, unknown>,
  options: LocalProviderOptions = {},
): Promise<LocalProvider[]> {
  const local = (id: string) => !(id in configured) && !ORGANIZATION_PROVIDER_ID.test(id);
  const native = options.native ?? new Map<string, EngineV2NativeProvider>();
  const environmentKeys = new Map([...native].flatMap(([id, provider]) => {
    if (auth.apiKeys.has(id) || auth.signIns.has(id) || !local(id)) return [];
    if (options.allows && !options.allows(id)) return [];
    const key = options.environment ? environmentProviderKey(id, provider, options.environment) : undefined;
    return key ? [[id, key] as const] : [];
  }));
  const ids = [...new Set([...auth.apiKeys.keys(), ...auth.signIns, ...environmentKeys.keys()])].filter(local)
    .sort((left, right) => left.localeCompare(right));
  const resolved: LocalProvider[] = [];
  const wanted: string[] = [];
  for (const id of ids) {
    const apiKey = auth.apiKeys.get(id) ?? environmentKeys.get(id);
    const catalog = native.get(id);
    if (options.allows && !options.allows(id)) resolved.push({ id, status: "skipped", reason: "policy" });
    else if (apiKey === undefined) {
      resolved.push({ id, status: "skipped", reason: "oauth" });
    } else if (catalog) {
      resolved.push({ id, status: "native", name: catalog.name, apiKey });
    } else wanted.push(id);
  }
  if (!wanted.length || !config.opencodeBaseUrl) return resolved;
  const url = new URL("/provider", config.opencodeBaseUrl);
  let value: unknown;
  try {
    const response = await loopbackFetch(url.toString(), { headers: {
      Authorization: `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64")}`,
    }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("Could not read locally connected provider metadata");
    value = await response.json();
  } catch (error) {
    if (!options.onCatalogError) throw error;
    options.onCatalogError(error instanceof Error ? error : new Error("Could not read locally connected provider metadata"));
    return [...resolved, ...wanted.map((id): LocalProvider => ({ id, status: "skipped", reason: "metadata" }))]
      .sort((left, right) => left.id.localeCompare(right.id));
  }
  const catalog = new Map((record(value) && Array.isArray(value.all) ? value.all : []).flatMap(provider =>
    record(provider) && typeof provider.id === "string" ? [[provider.id, provider] as const] : []));
  for (const id of wanted) {
    const apiKey = auth.apiKeys.get(id) ?? "";
    const entry = catalog.get(id);
    const normalized = normalizeLocalProviderDefinition(entry);
    resolved.push("definition" in normalized
      ? { id, status: "ready", definition: normalized.definition, apiKey }
      : { id, status: "skipped", reason: normalized.reason });
  }
  return resolved;
}

export async function localProviderDefinitions(
  config: EngineV1Connection,
  auth: LocalProviderAuth,
  configured: Record<string, unknown>,
  options: LocalProviderOptions = {},
): Promise<{ providers: Record<string, unknown>; native: Array<{ id: string; name: string; apiKey: string }>; skipped: EngineV2SkippedProvider[] }> {
  const resolved = await resolveLocalProviders(config, auth, configured, options);
  return {
    providers: Object.fromEntries(resolved.flatMap(provider => provider.status === "ready" ? [[provider.id, provider.definition]] : [])),
    native: resolved.flatMap(provider => provider.status === "native" ? [{ id: provider.id, name: provider.name, apiKey: provider.apiKey }] : []),
    skipped: resolved.flatMap(provider => provider.status === "skipped" ? [{ id: provider.id, reason: provider.reason }] : []),
  };
}
