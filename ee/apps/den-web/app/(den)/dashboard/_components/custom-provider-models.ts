/**
 * Pure helpers for AI Gateway custom OpenAI-compatible providers:
 * the model settings form, models.dev
 * templates, merging a fresh `/models` answer into the list, test
 * fingerprints and where a failed test sends the admin. No React, no fetch.
 */

import {
  gatewayCustomModalitySchema,
  gatewayCustomModelSchema,
  normalizeGatewayCustomBaseUrl,
  type GatewayCustomDiscoveredModel,
  type GatewayCustomDiscoveryStatus,
  type GatewayCustomModality,
  type GatewayCustomModel,
  type GatewayCustomModelMatch,
  type GatewayCustomReasoningOption,
  type GatewayCustomTestResponse,
} from "@openwork/types/den/gateway-custom-providers";
import type { GatewayAccessGrant, GatewayAccessGrantWrite } from "@openwork/types/den/gateway";

export const CUSTOM_MODALITIES: readonly GatewayCustomModality[] = gatewayCustomModalitySchema.options;

/** The settings form for one model. Numbers stay text while the admin types. */
export type ModelSettingsDraft = {
  id: string;
  name: string;
  attachment: boolean;
  reasoning: boolean;
  /** Reasoning can be switched on and off per request. */
  reasoningToggle: boolean;
  /** Effort values, comma separated ("low, medium, high"). Empty means none. */
  reasoningEfforts: string;
  toolCall: boolean;
  structuredOutput: boolean;
  temperature: boolean;
  input: GatewayCustomModality[];
  output: GatewayCustomModality[];
  context: string;
  outputLimit: string;
  costInput: string;
  costOutput: string;
  costCacheRead: string;
  costCacheWrite: string;
};

/** Where a model's settings came from, shown next to it. */
export type ModelOrigin =
  | { kind: "matched"; match: GatewayCustomModelMatch }
  /** Listed by the provider with details, no models.dev match. */
  | { kind: "listed" }
  /** Listed by the provider, nothing known beyond the id. */
  | { kind: "unknown" }
  | { kind: "template"; templateId: string; templateName: string }
  | { kind: "custom" }
  | { kind: "saved" };

export type ModelDraft = {
  /** Stable local key; the id itself is editable. */
  key: string;
  settings: ModelSettingsDraft;
  origin: ModelOrigin;
  /** Included in the provider. */
  selected: boolean;
  /** Settings were filled in (from a match, a template, the provider or by hand). */
  configured: boolean;
  /** The provider's latest `/models` answer no longer lists this id. */
  missing: boolean;
};

export type ModelSettingsField = keyof ModelSettingsDraft;

export const EMPTY_MODEL_SETTINGS: ModelSettingsDraft = {
  id: "", name: "", attachment: false, reasoning: false, reasoningToggle: false, reasoningEfforts: "",
  toolCall: true, structuredOutput: false, temperature: true, input: ["text"], output: ["text"],
  context: "", outputLimit: "", costInput: "", costOutput: "", costCacheRead: "", costCacheWrite: "",
};

// --- Number parsing ---

/** "128000", "128,000", "128k" or "1M" → a positive whole number of tokens; null when invalid. */
export function parseTokenCount(input: string): number | null {
  const text = input.trim().replace(/[,_\s]/g, "").toLowerCase();
  const match = /^(\d+(?:\.\d+)?)([km]?)$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]) * (match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : 1);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** USD per million tokens. Empty → undefined (not set); "$1.25" → 1.25; invalid or negative → null. */
export function parseCost(input: string): number | undefined | null {
  const text = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!text) return undefined;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

/** "low, medium,high" → ["low", "medium", "high"], de-duplicated. */
export function parseEffortValues(input: string): string[] {
  return [...new Set(input.split(",").map((value) => value.trim()).filter(Boolean))];
}

// --- Conversions ---

export function settingsFromModel(model: GatewayCustomModel): ModelSettingsDraft {
  const options = model.reasoning_options ?? [];
  const effort = options.find((option): option is Extract<GatewayCustomReasoningOption, { type: "effort" }> => option.type === "effort");
  return {
    id: model.id,
    name: model.name ?? "",
    attachment: model.attachment,
    reasoning: model.reasoning,
    reasoningToggle: options.some((option) => option.type === "toggle"),
    reasoningEfforts: effort ? effort.values.join(", ") : "",
    toolCall: model.tool_call,
    structuredOutput: model.structured_output,
    temperature: model.temperature,
    input: [...model.modalities.input],
    output: [...model.modalities.output],
    context: String(model.limit.context),
    outputLimit: String(model.limit.output),
    costInput: formatNumber(model.cost?.input),
    costOutput: formatNumber(model.cost?.output),
    costCacheRead: formatNumber(model.cost?.cache_read),
    costCacheWrite: formatNumber(model.cost?.cache_write),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModalities(value: unknown): GatewayCustomModality[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = gatewayCustomModalitySchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

function readPositiveInt(value: unknown): string {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? String(value) : "";
}

function readCost(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? String(value) : "";
}

/**
 * Settings copied from a models.dev catalog model (the `openrouter` list),
 * used as a template. Missing limits stay empty for the admin to fill in.
 */
export function settingsFromCatalogModel(model: { id: string; name: string; config: Record<string, unknown> }): ModelSettingsDraft {
  const config = model.config;
  const modalities = isRecord(config.modalities) ? config.modalities : {};
  const limit = isRecord(config.limit) ? config.limit : {};
  const cost = isRecord(config.cost) ? config.cost : {};
  const input = readModalities(modalities.input);
  const output = readModalities(modalities.output);
  const options = Array.isArray(config.reasoning_options) ? config.reasoning_options : [];
  const effort = options.find((option) => isRecord(option) && option.type === "effort");
  const efforts = isRecord(effort) && Array.isArray(effort.values) ? effort.values.filter((value): value is string => typeof value === "string") : [];
  const reasoning = config.reasoning === true;
  return {
    id: model.id,
    name: model.name && model.name !== model.id ? model.name : "",
    attachment: config.attachment === true,
    reasoning,
    reasoningToggle: reasoning && options.some((option) => isRecord(option) && option.type === "toggle"),
    reasoningEfforts: reasoning ? efforts.join(", ") : "",
    toolCall: config.tool_call === true,
    structuredOutput: config.structured_output === true,
    temperature: config.temperature !== false,
    input: input.length ? input : ["text"],
    output: output.length ? output : ["text"],
    context: readPositiveInt(limit.context),
    outputLimit: readPositiveInt(limit.output),
    costInput: readCost(cost.input),
    costOutput: readCost(cost.output),
    costCacheRead: readCost(cost.cache_read),
    costCacheWrite: readCost(cost.cache_write),
  };
}

/** Copies a template's settings onto a model, keeping the model's own id (and name when set). */
export function applyTemplateSettings(current: ModelSettingsDraft, template: ModelSettingsDraft): ModelSettingsDraft {
  return { ...template, id: current.id || template.id, name: current.name || template.name };
}

export type ModelDraftResult =
  | { ok: true; model: GatewayCustomModel }
  | { ok: false; field: ModelSettingsField; message: string };

/** The saved record for one model, or the first field to fix. */
export function modelFromSettings(settings: ModelSettingsDraft): ModelDraftResult {
  const id = settings.id.trim();
  if (!id) return { ok: false, field: "id", message: "Enter the model ID the provider expects." };
  if (/\s/.test(id)) return { ok: false, field: "id", message: "Model IDs can't contain spaces." };
  if (!settings.input.length) return { ok: false, field: "input", message: `Pick at least one input type for ${id}.` };
  if (!settings.output.length) return { ok: false, field: "output", message: `Pick at least one output type for ${id}.` };
  const context = parseTokenCount(settings.context);
  if (context === null) return { ok: false, field: "context", message: `Enter the context window for ${id}, in tokens.` };
  const output = parseTokenCount(settings.outputLimit);
  if (output === null) return { ok: false, field: "outputLimit", message: `Enter the most tokens ${id} can write in one answer.` };
  const costFields = [
    ["costInput", "input"], ["costOutput", "output"], ["costCacheRead", "cache_read"], ["costCacheWrite", "cache_write"],
  ] as const;
  const cost: NonNullable<GatewayCustomModel["cost"]> = {};
  for (const [field, key] of costFields) {
    const value = parseCost(settings[field]);
    if (value === null) return { ok: false, field, message: `Enter prices for ${id} in US dollars per million tokens, for example 0.5.` };
    if (value !== undefined) cost[key] = value;
  }
  const efforts = parseEffortValues(settings.reasoningEfforts);
  const reasoningOptions: GatewayCustomReasoningOption[] = settings.reasoning ? [
    ...(settings.reasoningToggle ? [{ type: "toggle" as const }] : []),
    ...(efforts.length ? [{ type: "effort" as const, values: efforts }] : []),
  ] : [];
  const candidate: GatewayCustomModel = {
    id,
    ...(settings.name.trim() && settings.name.trim() !== id ? { name: settings.name.trim() } : {}),
    attachment: settings.attachment,
    reasoning: settings.reasoning,
    ...(reasoningOptions.length ? { reasoning_options: reasoningOptions } : {}),
    tool_call: settings.toolCall,
    structured_output: settings.structuredOutput,
    temperature: settings.temperature,
    modalities: { input: settings.input, output: settings.output },
    limit: { context, output },
    ...(Object.keys(cost).length ? { cost } : {}),
  };
  const parsed = gatewayCustomModelSchema.safeParse(candidate);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path[0];
    const field: ModelSettingsField = path === "reasoning_options" ? "reasoningEfforts" : path === "name" ? "name" : "id";
    return { ok: false, field, message: field === "reasoningEfforts" ? `Effort values for ${id} must be short words, at most 12.` : `Check the settings for ${id}.` };
  }
  return { ok: true, model: parsed.data };
}

export type ModelsCheck =
  | { ok: true; models: GatewayCustomModel[] }
  | { ok: false; key: string | null; field: ModelSettingsField | null; message: string };

/** Every included model is complete, ids are unique, and there is at least one. */
export function checkSelectedModels(drafts: readonly ModelDraft[]): ModelsCheck {
  const selected = drafts.filter((draft) => draft.selected);
  if (!selected.length) return { ok: false, key: null, field: null, message: "Pick at least one model." };
  const models: GatewayCustomModel[] = [];
  const seen = new Set<string>();
  for (const draft of selected) {
    if (!draft.configured) {
      return { ok: false, key: draft.key, field: null, message: `Choose settings for ${draft.settings.id || "this model"}: pick a similar model from the list, or set it up yourself.` };
    }
    const result = modelFromSettings(draft.settings);
    if (!result.ok) return { ok: false, key: draft.key, field: result.field, message: result.message };
    if (seen.has(result.model.id)) return { ok: false, key: draft.key, field: "id", message: `${result.model.id} is in the list twice. Give each model its own ID.` };
    seen.add(result.model.id);
    models.push(result.model);
  }
  return { ok: true, models };
}

// --- Discovery ---

export function draftFromDiscovered(entry: GatewayCustomDiscoveredModel, key: string, selectMatched: boolean): ModelDraft {
  if (entry.model) {
    return {
      key,
      settings: settingsFromModel(entry.model),
      origin: entry.match ? { kind: "matched", match: entry.match } : { kind: "listed" },
      selected: selectMatched && entry.match !== null,
      configured: true,
      missing: false,
    };
  }
  return { key, settings: { ...EMPTY_MODEL_SETTINGS, id: entry.id }, origin: { kind: "unknown" }, selected: false, configured: false, missing: false };
}

/**
 * Folds a `/models` answer into the current list. Existing models and every
 * edit stay; ids the provider newly lists are added (ticked only when
 * `selectMatched` and matched to models.dev). Ids the provider listed last
 * time (`previouslyListed`) and no longer lists are flagged as missing, never
 * removed; models added by hand were never listed, so they are never flagged.
 * An unavailable answer changes nothing but clears no flags either.
 */
export function mergeDiscoveredModels(
  drafts: readonly ModelDraft[],
  discovered: readonly GatewayCustomDiscoveredModel[],
  status: GatewayCustomDiscoveryStatus,
  options: { selectMatched: boolean; makeKey: () => string; previouslyListed: ReadonlySet<string> },
): ModelDraft[] {
  if (status === "unavailable") return [...drafts];
  const listed = new Set(discovered.map((entry) => entry.id));
  const existingIds = new Set(drafts.map((draft) => draft.settings.id.trim()));
  const kept = drafts.map((draft) => {
    const id = draft.settings.id.trim();
    return { ...draft, missing: options.previouslyListed.has(id) && !listed.has(id) };
  });
  const added = discovered
    .filter((entry, index) => !existingIds.has(entry.id) && discovered.findIndex((other) => other.id === entry.id) === index)
    .map((entry) => draftFromDiscovered(entry, options.makeKey(), options.selectMatched));
  return [...kept, ...added];
}

// --- Connection ---

export type ConnectionField = "name" | "baseUrl" | "apiKey";

export function connectionError(input: { name: string; baseUrl: string; apiKey: string; apiKeyRequired: boolean }): { field: ConnectionField; message: string } | null {
  if (!input.name.trim()) return { field: "name", message: "Enter a name. People see it in the model picker." };
  if (!input.baseUrl.trim()) return { field: "baseUrl", message: "Enter the provider's API URL, for example https://api.example.com/v1." };
  const normalized = normalizeGatewayCustomBaseUrl(input.baseUrl);
  if (!normalized) return { field: "baseUrl", message: "Enter a full web address that starts with https://, without a user name, ? or #." };
  // http:// is left to den-api: it is refused unless the operator allowlisted that origin (GATEWAY_EGRESS_ALLOWED_ORIGINS).
  if (input.apiKeyRequired && !input.apiKey.trim()) return { field: "apiKey", message: "Paste the API key." };
  return null;
}

/**
 * A saved key is only ever sent to the origin it was saved for (den-api
 * refuses otherwise), so a URL on another host needs the key pasted again.
 */
export function newOriginNeedsKey(savedBaseUrl: string, baseUrl: string, apiKey: string): boolean {
  if (apiKey.trim()) return false;
  const normalized = normalizeGatewayCustomBaseUrl(baseUrl);
  if (!normalized) return false;
  try { return new URL(normalized).origin !== new URL(savedBaseUrl).origin; } catch { return true; }
}

/** "Requests go to …/chat/completions", or null while the URL is incomplete. */
export function chatCompletionsUrl(baseUrl: string): string | null {
  const normalized = normalizeGatewayCustomBaseUrl(baseUrl);
  return normalized ? `${normalized}/chat/completions` : null;
}

// --- Test ---

/** Everything a test result depends on. Any change makes the last result stale. */
export function testFingerprint(input: { baseUrl: string; apiKey: string; drafts: readonly ModelDraft[]; testModelKey: string | null }): string {
  return JSON.stringify({
    baseUrl: normalizeGatewayCustomBaseUrl(input.baseUrl) ?? input.baseUrl.trim(),
    apiKey: input.apiKey.trim(),
    models: input.drafts.filter((draft) => draft.selected).map((draft) => [draft.key, draft.configured, draft.settings]),
    testModelKey: input.testModelKey,
  });
}

/** The selected model to test: the chosen one while it is still ticked, else the first ticked one. */
export function resolveTestModelKey(drafts: readonly ModelDraft[], chosen: string | null): string | null {
  const selected = drafts.filter((draft) => draft.selected);
  return selected.find((draft) => draft.key === chosen)?.key ?? selected[0]?.key ?? null;
}

export type TestFailureTarget =
  | { step: "connection"; field: "baseUrl" | "apiKey" }
  | { step: "model"; modelKey: string }
  | null;

/** Where a failed test sends the admin: the key or URL field, the model, or nowhere (stay and show it). */
export function testFailureTarget(result: Extract<GatewayCustomTestResponse, { ok: false }>, testModelKey: string | null): TestFailureTarget {
  if (result.step === "connection") {
    const keyProblem = result.status === 401 || result.status === 403 || result.code === "unauthorized" || result.code === "forbidden" || result.code === "invalid_api_key";
    return { step: "connection", field: keyProblem ? "apiKey" : "baseUrl" };
  }
  if (result.step === "model" && testModelKey) return { step: "model", modelKey: testModelKey };
  return null;
}

/**
 * A saved provider needs a passing test before saving when the URL, the key
 * or the set of model ids changes. Other setting edits save directly.
 */
export function savedProviderNeedsTest(saved: { baseUrl: string; models: readonly GatewayCustomModel[] }, draft: { baseUrl: string; apiKey: string; models: readonly GatewayCustomModel[] }): boolean {
  if ((normalizeGatewayCustomBaseUrl(draft.baseUrl) ?? draft.baseUrl.trim()) !== saved.baseUrl) return true;
  if (draft.apiKey.trim()) return true;
  const savedIds = new Set(saved.models.map((model) => model.id));
  return draft.models.some((model) => !savedIds.has(model.id));
}

/** Plain words for an origin, shown under the model name. */
export function originLabel(origin: ModelOrigin): string | null {
  switch (origin.kind) {
    case "matched": return `Settings from ${origin.match.modelId}`;
    case "listed": return "Settings from the provider";
    case "unknown": return null;
    case "template": return `Settings copied from ${origin.templateName}`;
    case "custom": return "Set up by hand";
    case "saved": return null;
  }
}

// --- Access ---

type Audience = GatewayAccessGrantWrite["audience"];

/** The grants to add and remove so the provider's first model group and key match "Who can use it". */
export function accessGrantChanges(
  provider: { accessGrants: readonly GatewayAccessGrant[] },
  groupId: string,
  setId: string,
  access: { orgWide: boolean; memberIds: readonly string[]; teamIds: readonly string[] },
): { add: Audience[]; remove: string[] } {
  const desired: Audience[] = [
    ...(access.orgWide ? [{ type: "organization" as const }] : []),
    ...(access.orgWide ? [] : [...new Set(access.teamIds)].map((teamId) => ({ type: "team" as const, teamId }))),
    ...(access.orgWide ? [] : [...new Set(access.memberIds)].map((memberId) => ({ type: "member" as const, memberId }))),
  ];
  const same = (a: Audience, b: Audience) => JSON.stringify(a) === JSON.stringify(b);
  const existing = provider.accessGrants.filter((grant) => grant.modelGroupId === groupId && grant.credentialSetId === setId);
  return {
    add: desired.filter((audience) => !existing.some((grant) => same(grant.audience, audience))),
    remove: existing.filter((grant) => !desired.some((audience) => same(audience, grant.audience))).map((grant) => grant.id),
  };
}
