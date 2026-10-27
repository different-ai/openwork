import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { opencodeDataDirs } from "@openwork/paths";
import { ORGANIZATION_PROVIDER_ID } from "./organization-provider-gate.js";
import { loopbackFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";

/** Where the running OpenCode v1 engine answers, with its Basic credentials. */
type EngineV1Connection = Pick<ServerConfig, "opencodeBaseUrl" | "opencodeUsername" | "opencodePassword">;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Why a provider connected on this computer is not on OpenCode v2:
 * - `policy`: the organization allows only its own providers.
 * - `oauth`: a sign-in (such as ChatGPT) that needs the engine's own sign-in flow.
 * - `unsupported`: no built-in v2 adapter, or an endpoint the mirror does not trust.
 * - `metadata`: OpenCode v1 did not describe it in a shape the mirror can translate.
 * - `credentials`: its declared credential is missing.
 */
export type EngineV2SkippedProviderReason = "policy" | "oauth" | "unsupported" | "metadata" | "credentials";

export interface EngineV2SkippedProvider {
  id: string;
  reason: EngineV2SkippedProviderReason;
}

export interface LocalProviderAuth {
  /** API keys by provider id. */
  apiKeys: Map<string, string>;
  /** Providers connected with OAuth or another sign-in instead of an API key. */
  signIns: Set<string>;
}

/** Only the active v1 profile, never another installation's fallback directory. */
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

/** OAuth credentials need their native authorization flow and are not API keys. */
export async function readLocalProviderApiKeys(path?: string): Promise<Map<string, string>> {
  return (await readLocalProviderAuth(path)).apiKeys;
}

type Normalized = { definition: Record<string, unknown> } | { reason: "metadata" };

function enabledKinds(value: unknown): string[] | undefined {
  return record(value) ? Object.entries(value).flatMap(([kind, enabled]) => enabled === true ? [kind] : []) : undefined;
}

/** A v1 Provider.Info model in the models.dev field names the v2 config renderer reads. */
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

/**
 * Translate a GET /provider entry into the models.dev shape the v2 mirror
 * maps. OpenCode v1 1.18+ answers with Provider.Info: no top-level `npm` or
 * `api`; each model carries `api: { id, url, npm }` and `capabilities`. Older
 * engines answer in the models.dev shape, which is kept.
 *
 * Catalog responses are never a source of credentials or destinations: the
 * provider's `key`, `options` (which can hold `apiKey`, `baseURL`, a sign-in
 * placeholder or engine-specific headers) are dropped. The key comes from
 * auth.json and the endpoint from `api`, which the mapper accepts only on the
 * adapter's own origin.
 */
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
  // Every model must name the same package and endpoint, otherwise one
  // provider entry cannot describe it (for example a gateway mixing adapters).
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

/**
 * One provider connected on this computer as the v2 mirror sees it: ready to
 * mirror with its definition and key, or skipped with a reason. Row-level
 * actions on a provider added on this computer start from the same answer.
 */
export type LocalProvider =
  | { id: string; status: "ready"; definition: Record<string, unknown>; apiKey: string }
  | { id: string; status: "skipped"; reason: EngineV2SkippedProviderReason };

export interface LocalProviderOptions {
  /** The organization's provider rule; providers it refuses are never read from the engine or mirrored. */
  allows?: ((providerId: string) => boolean) | null;
}

/**
 * Providers connected in OpenCode v1 (auth.json) that have no OpenWork
 * runtime definition, resolved with trusted built-in metadata from the
 * running v1 engine. Organization providers are mirrored from their own
 * definitions and are not part of this list.
 */
export async function resolveLocalProviders(
  config: EngineV1Connection,
  auth: LocalProviderAuth,
  configured: Record<string, unknown>,
  options: LocalProviderOptions = {},
): Promise<LocalProvider[]> {
  const local = (id: string) => !(id in configured) && !ORGANIZATION_PROVIDER_ID.test(id);
  const ids = [...new Set([...auth.apiKeys.keys(), ...auth.signIns])].filter(local).sort((left, right) => left.localeCompare(right));
  const resolved: LocalProvider[] = [];
  const wanted: string[] = [];
  for (const id of ids) {
    if (options.allows && !options.allows(id)) resolved.push({ id, status: "skipped", reason: "policy" });
    else if (!auth.apiKeys.has(id)) {
      resolved.push({ id, status: "skipped", reason: "oauth" });
    } else wanted.push(id);
  }
  if (!wanted.length || !config.opencodeBaseUrl) return resolved;
  const url = new URL("/provider", config.opencodeBaseUrl);
  const response = await loopbackFetch(url.toString(), { headers: {
    Authorization: `Basic ${Buffer.from(`${config.opencodeUsername}:${config.opencodePassword}`).toString("base64")}`,
  }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Could not read locally connected provider metadata");
  const value: unknown = await response.json();
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

/** The mirror's view: definitions to map, and what will not reach the engine. */
export async function localProviderDefinitions(
  config: EngineV1Connection,
  auth: LocalProviderAuth,
  configured: Record<string, unknown>,
  options: LocalProviderOptions = {},
): Promise<{ providers: Record<string, unknown>; skipped: EngineV2SkippedProvider[] }> {
  const resolved = await resolveLocalProviders(config, auth, configured, options);
  return {
    providers: Object.fromEntries(resolved.flatMap(provider => provider.status === "ready" ? [[provider.id, provider.definition]] : [])),
    skipped: resolved.flatMap(provider => provider.status === "skipped" ? [{ id: provider.id, reason: provider.reason }] : []),
  };
}
