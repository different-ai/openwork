import type { EngineModelOption, ModelTier } from "./threads.ts";
import { MODEL_INTELLIGENCE_INDEX, normalizeModelSelectionPreferences, type ModelLane, type ModelSelectionPreferences, type RankingCriterion } from "./model-intelligence-index.ts";

/**
 * Tiers an implicit anchor may come from, best first; mirrors `MODEL_TIER_ORDER`
 * in `threads.ts` (kept local to avoid a module cycle). OpenCode's own catalog
 * is absent on purpose: it is selectable, never chosen for the person.
 */
const IMPLICIT_ANCHOR_TIERS: readonly ModelTier[] = ["cloud", "key", "local-server", "free"];

export { modelSelectionDefaults, normalizeModelSelectionPreferences, MODEL_INTELLIGENCE_INDEX } from "./model-intelligence-index.ts";
export type { ModelSelectionPreferences } from "./model-intelligence-index.ts";

type Fact = boolean | null;
type Modalities = Record<"text" | "image" | "audio" | "video" | "pdf", Fact>;
export type ModelIntelligence = {
  provenance: "engine-catalog";
  observedAt: number;
  tools: Fact;
  reasoning: Fact;
  input: Modalities;
  output: Modalities;
  limits: { context: number | null; input: number | null; output: number | null };
  cost: { input: number | null; output: number | null; unit: "per-million-tokens" };
  status: string | null;
  adapterNpm: string | null;
  apiModelId: string | null;
  serviceFamily: string | null;
  serviceEvidence: "provider-registry-default" | null;
};

const numberFact = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const booleanFact = (value: unknown): Fact => typeof value === "boolean" ? value : null;
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const record = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};

/** Whitelist raw metadata BEFORE legacy UI defaults. Never retain URLs, options, headers or credentials. */
export function normalizeModelIntelligence(raw: unknown, providerId: string, observedAt: number): ModelIntelligence {
  const model = record(raw), capabilities = record(model.capabilities), api = record(model.api);
  const cost = record(model.cost), limit = record(model.limit);
  const modalities = (value: unknown): Modalities => {
    const fields = record(value);
    return { text: booleanFact(fields.text), image: booleanFact(fields.image), audio: booleanFact(fields.audio), video: booleanFact(fields.video), pdf: booleanFact(fields.pdf) };
  };
  const service = MODEL_INTELLIGENCE_INDEX.services.find((entry) => entry.providerIds.includes(providerId));
  return {
    provenance: "engine-catalog", observedAt,
    tools: booleanFact(capabilities.toolcall), reasoning: booleanFact(capabilities.reasoning),
    input: modalities(capabilities.input), output: modalities(capabilities.output),
    limits: { context: numberFact(limit.context), input: numberFact(limit.input), output: numberFact(limit.output) },
    cost: { input: numberFact(cost.input), output: numberFact(cost.output), unit: "per-million-tokens" },
    status: typeof model.status === "string" ? model.status : null,
    adapterNpm: typeof api.npm === "string" && api.npm ? api.npm : null,
    apiModelId: typeof api.id === "string" && api.id ? api.id : null,
    serviceFamily: service?.family ?? null, serviceEvidence: service ? "provider-registry-default" : null,
  };
}

export type ModelCatalogIdentity = { upstreamModelId?: string; modelGroupId?: string; credentialSetId?: string };

export function modelCatalogIdentity(raw: unknown): ModelCatalogIdentity {
  const value = record(raw);
  const id = (value: unknown) => typeof value === "string" && value.length <= 256 && /^[A-Za-z0-9._:@+/-]+$/.test(value) ? value : undefined;
  return {
    upstreamModelId: id(value.upstreamModelId),
    modelGroupId: id(value.modelGroupId),
    credentialSetId: id(value.credentialSetId),
  };
}

export function sameModelBoundary(candidate: EngineModelOption, anchor: EngineModelOption): boolean {
  if (candidate.providerId !== anchor.providerId || candidate.tier !== anchor.tier) return false;
  if (!/^ipr_/i.test(anchor.providerId)) return true;
  return Boolean(anchor.modelGroupId && anchor.credentialSetId
    && candidate.modelGroupId === anchor.modelGroupId && candidate.credentialSetId === anchor.credentialSetId);
}

export function preferredRoleModel(
  catalog: { models: EngineModelOption[] },
  purpose: "conversation" | "delivery" | "thinking",
  options: ModelSelectionOptions = {},
): EngineModelOption | null {
  const preferences = normalizeModelSelectionPreferences(options.preferences);
  const excluded = new Set([...(options.exclude ?? []), ...preferences.avoided]);
  const anchor = options.standard === undefined ? undefined : catalog.models.find((model) => model.id === options.standard);
  if (options.standard !== undefined && (!anchor || !usable(anchor, true) || excluded.has(anchor.id))) return null;
  const tier = anchor?.tier ?? IMPLICIT_ANCHOR_TIERS.find((tier) => catalog.models.some((model) => model.tier === tier && usable(model) && !excluded.has(model.id)));
  const wanted = purpose === "thinking" ? "gpt-6-astra" : "gpt-5.6-luna";
  const pool = catalog.models.filter((model) => {
    if (model.tier !== tier || model.tier === "opencode" || model.providerId === "opencode" || !usable(model) || excluded.has(model.id)) return false;
    const gateway = /^ipr_/i.test(model.providerId);
    const identity = model.upstreamModelId ?? (gateway ? undefined : model.intelligence?.apiModelId ?? model.modelId);
    if (identity !== wanted && identity !== `openai/${wanted}`) return false;
    if (gateway && (!model.modelGroupId || !model.credentialSetId)) return false;
    if (purpose === "thinking" && (!model.variants.includes("medium") || !(model.intelligence?.reasoning ?? model.reasoning))) return false;
    return !anchor || model.id === anchor.id || (sameModelBoundary(model, anchor) && costsNoMoreThan(model, anchor) && preserves(model, anchor));
  });
  const first = pool[0];
  if (!first || pool.some((model) => !sameModelBoundary(model, first))) return null;
  return pool.find((model) => model.id === anchor?.id)
    ?? [...pool].sort((a, b) => Number(b.isProviderDefault) - Number(a.isProviderDefault) || a.id.localeCompare(b.id))[0] ?? null;
}

export function chooseAutomaticRoleModel(
  catalog: { models: EngineModelOption[] },
  purpose: "conversation" | "delivery" | "thinking",
  options: ModelSelectionOptions = {},
): ModelSelectionDecision & { variant?: string } {
  const models = catalog.models.filter((model) => model.providerId !== "opencode" && model.tier !== "opencode");
  const preferences = normalizeModelSelectionPreferences(options.preferences);
  const excluded = new Set([...(options.exclude ?? []), ...preferences.avoided]);
  const preferred = preferredRoleModel({ models }, purpose, { preferences, exclude: [...excluded] });
  if (preferred) return {
    model: preferred, reason: `Selected the requested connected ${purpose} default from the current catalog.`,
    indexVersion: MODEL_INTELLIGENCE_INDEX.version, ...(purpose === "thinking" ? { variant: "medium" } : {}),
  };
  const anchor = models.find((model) => model.id === options.standard && usable(model, true) && !excluded.has(model.id));
  const decision = chooseIndexedModel({ models }, purpose === "thinking" ? "deep" : purpose === "delivery" ? "standard" : "quick", {
    ...options, standard: anchor?.id,
  });
  const selected = decision.model;
  if (!anchor && selected?.upstreamModelId && models.some((model) => model.upstreamModelId === selected.upstreamModelId
    && usable(model) && !excluded.has(model.id) && !sameModelBoundary(model, selected))) {
    return { ...decision, model: null, reason: "Multiple connected credential choices offer this model. Choose an explicit role default; no credential set was selected automatically." };
  }
  return decision;
}

export type ModelSelectionOptions = { standard?: string; exclude?: readonly string[]; preferences?: ModelSelectionPreferences };
export type ModelSelectionDecision = { model: EngineModelOption | null; reason: string; indexVersion: string };
type PricedModel = Pick<EngineModelOption, "cost" | "knownPrice" | "intelligence">;

function prices(model: PricedModel) {
  // A normalized observation is the authority; legacy display edits do not refresh it.
  if (model.intelligence) return model.intelligence.cost;
  return { input: model.knownPrice === true ? numberFact(model.cost.input) : null, output: model.knownPrice === true ? numberFact(model.cost.output) : null };
}

export function costsNoMoreThan(candidate: PricedModel, standard: PricedModel): boolean {
  const next = prices(candidate), base = prices(standard);
  return next.input !== null && next.output !== null && base.input !== null && base.output !== null
    && numberFact(next.input) !== null && numberFact(next.output) !== null && numberFact(base.input) !== null && numberFact(base.output) !== null
    && next.input <= base.input && next.output <= base.output;
}

function usable(model: EngineModelOption, allowUnknown = false): boolean {
  const facts = model.intelligence;
  if (!facts) return model.toolCall === true && model.status !== "deprecated";
  if (facts.input.text === false || facts.output.text === false) return false;
  // Retaining an explicit anchor is not a new capability claim. Substitutions require evidence.
  return allowUnknown ? (facts.tools ?? model.toolCall) === true && (facts.status ?? model.status) !== "deprecated"
    : facts.tools === true && facts.status === "active";
}

function preserves(candidate: EngineModelOption, anchor: EngineModelOption): boolean {
  const base = anchor.intelligence, next = candidate.intelligence;
  if (!base) return true;
  if (!next) return false;
  for (const modality of ["text", "image", "audio", "video", "pdf"] as const) {
    if (base.input[modality] === true && next.input[modality] !== true) return false;
    if (base.output[modality] === true && next.output[modality] !== true) return false;
  }
  for (const key of ["context", "input", "output"] as const) {
    const required = base.limits[key], available = next.limits[key];
    if (required !== null && (available === null || available < required)) return false;
  }
  return true;
}

/** Pure, deterministic ranking. An explicit fallback keeps the ORIGINAL anchor's safety gates. */
function choose(catalog: { models: EngineModelOption[] }, lane: ModelLane, options: ModelSelectionOptions, fallback: boolean): ModelSelectionDecision {
  const preferences = normalizeModelSelectionPreferences(options.preferences);
  const excluded = new Set([...(options.exclude ?? []), ...preferences.avoided]);
  const decision = (model: EngineModelOption | null, reason: string): ModelSelectionDecision => ({ model, reason, indexVersion: MODEL_INTELLIGENCE_INDEX.version });
  const reasoning = (model: EngineModelOption) => model.intelligence ? model.intelligence.reasoning : booleanFact(model.reasoning);
  const anchor = options.standard !== undefined ? catalog.models.find((model) => model.id === options.standard)
    : catalog.models.filter((model) => usable(model) && !excluded.has(model.id) && IMPLICIT_ANCHOR_TIERS.includes(model.tier)).sort((a, b) =>
      IMPLICIT_ANCHOR_TIERS.indexOf(a.tier) - IMPLICIT_ANCHOR_TIERS.indexOf(b.tier) || Number(b.isProviderDefault) - Number(a.isProviderDefault)
      || Number(reasoning(b) === true) - Number(reasoning(a) === true) || a.id.localeCompare(b.id))[0];
  if (!anchor) {
    return decision(null, options.standard === undefined
      ? "No model is set and none is recommended yet. Sign in to OpenWork or connect an AI provider, or choose a model in Coworker settings."
      : "The standard model is unavailable; no implicit replacement was selected.");
  }
  if (fallback && (preferences.avoided.includes(anchor.id) || !costsNoMoreThan(anchor, anchor))) return decision(null, "The original standard is avoided or lacks both known token prices; no fallback was selected.");
  if (!fallback && (!usable(anchor, true) || excluded.has(anchor.id))) return decision(null, "The standard model is excluded, avoided, deprecated, or reports unsupported tools/text.");
  if (lane === "standard" && !fallback) return decision(anchor, "Ordinary work keeps the standard model.");
  const policy = MODEL_INTELLIGENCE_INDEX.tasks[lane];
  const pool = catalog.models.filter((model) => {
    if (excluded.has(model.id)) return false;
    if (model.id === anchor.id) return usable(model, true);
    if (!usable(model)) return false;
    return sameModelBoundary(model, anchor) && costsNoMoreThan(model, anchor) && preserves(model, anchor)
      // Unknown reasoning never qualifies a substitute for either automatic lane.
      && (policy.reasoning === null || reasoning(model) !== null);
  });
  const preferred = lane === "standard" ? [] : preferences.preferred[lane];
  const criteria = [...new Set<RankingCriterion>([...MODEL_INTELLIGENCE_INDEX.priorities[preferences.priority], ...policy.criteria, "anchor", "default", "id"])];
  const score = (model: EngineModelOption, criterion: RankingCriterion): number => {
    switch (criterion) {
      case "reasoning": return Number(policy.reasoning !== null && reasoning(model) === policy.reasoning);
      case "preferred": { const position = preferred.indexOf(model.id); return position < 0 ? 0 : preferred.length - position; }
      case "cost": { const cost = prices(model); return cost.input !== null && cost.output !== null ? -(cost.input + cost.output) : -Infinity; }
      // Unknown baseline capacity is not evidence that a sibling is an upgrade.
      case "context": case "output": return anchor.intelligence?.limits[criterion] != null ? model.intelligence?.limits[criterion] ?? -1 : 0;
      case "anchor": return Number(model.id === anchor.id);
      case "default": return Number(model.isProviderDefault);
      default: return 0;
    }
  };
  pool.sort((a, b) => {
    for (const criterion of criteria) {
      if (criterion === "id") return a.id.localeCompare(b.id);
      const left = score(a, criterion), right = score(b, criterion);
      if (left !== right) return left > right ? -1 : 1;
    }
    return 0;
  });
  const selected = pool[0] ?? null;
  if (!selected) return decision(null, "No eligible replacement preserves the original provider, known token price caps, modalities and limits.");
  if (selected.id === anchor.id) return decision(selected, "Kept the standard model: no eligible sibling ranked ahead under the selected preferences.");
  const reasoningFact = reasoning(selected);
  return decision(selected, `Selected a same-provider model within both known token price caps, preserving known modalities and limits. ${reasoningFact === null ? "Tool support is confirmed" : reasoningFact ? "Reasoning is confirmed" : "Non-reasoning is confirmed"}; ${preferences.priority} ranking uses ${criteria.join(", ")}. These are catalog facts and preferences, not measured quality or speed.`);
}

export function chooseIndexedModel(catalog: { models: EngineModelOption[] }, lane: ModelLane, options: ModelSelectionOptions = {}): ModelSelectionDecision {
  return choose(catalog, lane, options, false);
}

/** Caller still owns consent and the one-retry limit; this never performs inference or retries. */
export function chooseIndexedFallbackModel(catalog: { models: EngineModelOption[] }, lane: ModelLane, options: ModelSelectionOptions & { standard: string; exclude: readonly string[] }): ModelSelectionDecision {
  return choose(catalog, lane, options, true);
}
