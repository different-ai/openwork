/** Curated selection policies, not model benchmarks. Review sources before updating a version. */
export type ModelLane = "quick" | "standard" | "deep";
export type ModelSelectionPreferences = {
  priority: "balanced" | "cost" | "capability";
  preferred: { quick: string[]; deep: string[] };
  avoided: string[];
};

export function modelSelectionDefaults(): ModelSelectionPreferences {
  return { priority: "balanced", preferred: { quick: [], deep: [] }, avoided: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact engine IDs; the model portion may contain more slashes (not a filesystem path). */
export function normalizeModelSelectionPreferences(input: unknown): ModelSelectionPreferences {
  const result = modelSelectionDefaults();
  if (!isRecord(input)) return result;
  if (input.priority === "cost" || input.priority === "capability") result.priority = input.priority;
  const ids = (value: unknown): string[] => {
    const clean: string[] = [];
    if (!Array.isArray(value)) return clean;
    for (const item of value) {
      if (typeof item !== "string") continue;
      const id = item.trim();
      if (id.length > 256 || !/^[A-Za-z0-9._:@+-]+\/[A-Za-z0-9._:@+/-]+$/.test(id)
        || id.endsWith("/") || id.includes("//") || clean.includes(id)) continue;
      clean.push(id);
      if (clean.length === 8) break;
    }
    return clean;
  };
  result.avoided = ids(input.avoided);
  if (isRecord(input.preferred)) {
    result.preferred.quick = ids(input.preferred.quick);
    result.preferred.deep = ids(input.preferred.deep);
  }
  return result;
}

export type RankingCriterion = "reasoning" | "preferred" | "cost" | "context" | "output" | "anchor" | "default" | "id";
type TaskPolicy = { purpose: string; reasoning: boolean | null; criteria: RankingCriterion[]; guard: string };
type ServiceFamily = "openrouter" | "openai" | "anthropic" | "google" | "vertex";
type SourceKey = "openrouterModels" | "openrouterRouting" | "aiSdk" | "openaiModels" | "anthropicModels" | "googleModels";
export type ModelIntelligenceIndex = {
  version: string;
  reviewedAt: string;
  sources: Record<SourceKey, string>;
  services: { family: ServiceFamily; providerIds: string[]; sourceKeys: SourceKey[]; caveat: string }[];
  adapters: { npm: string; family: ServiceFamily | null; caveat: string }[];
  caveats: string[];
  tasks: Record<ModelLane | "memory" | "facilitator", TaskPolicy>;
  priorities: Record<ModelSelectionPreferences["priority"], RankingCriterion[]>;
};

export const MODEL_INTELLIGENCE_INDEX: ModelIntelligenceIndex = {
  version: "2026-09-09.2",
  reviewedAt: "2026-09-09",
  sources: {
    openrouterModels: "https://openrouter.ai/docs/guides/overview/models",
    openrouterRouting: "https://openrouter.ai/docs/guides/routing/provider-selection",
    aiSdk: "https://ai-sdk.dev/docs/foundations/providers-and-models",
    openaiModels: "https://developers.openai.com/api/reference/resources/models/methods/list",
    anthropicModels: "https://platform.claude.com/docs/en/api/models/list",
    googleModels: "https://ai.google.dev/api/models",
  },
  services: [
    { family: "openrouter", providerIds: ["openrouter"], sourceKeys: ["openrouterModels", "openrouterRouting", "aiSdk"], caveat: "Aggregator model IDs can include publisher namespaces and suffixes. A catalog price is not an endpoint quote." },
    { family: "openai", providerIds: ["openai"], sourceKeys: ["openaiModels", "aiSdk"], caveat: "The models list establishes identifiers/access, not tools, reasoning, pricing or measured quality." },
    { family: "anthropic", providerIds: ["anthropic"], sourceKeys: ["anthropicModels", "aiSdk"], caveat: "ListModels is capability-rich, not identity-only: capabilities, max_input_tokens and max_tokens can carry nullable metadata. Null stays unknown; use only fields actually projected by the engine. Aliases can change, and listing capabilities does not establish pricing or measured quality." },
    { family: "google", providerIds: ["google"], sourceKeys: ["googleModels", "aiSdk"], caveat: "Google AI model limits and supported methods are not a blanket tool/reasoning guarantee." },
    { family: "vertex", providerIds: ["google-vertex"], sourceKeys: ["aiSdk"], caveat: "Vertex is distinct from Google AI: project, region, access and endpoint behavior are not interchangeable." },
  ],
  adapters: [
    { npm: "@openrouter/ai-sdk-provider", family: "openrouter", caveat: "OpenRouter protocol adapter; does not establish downstream endpoint or routing policy." },
    { npm: "@ai-sdk/openai", family: "openai", caveat: "OpenAI adapter, not evidence of OpenAI credentials, subscription, entitlement or endpoint ownership." },
    { npm: "@ai-sdk/anthropic", family: "anthropic", caveat: "Anthropic protocol adapter, not evidence of the authenticated service." },
    { npm: "@ai-sdk/google", family: "google", caveat: "Google AI adapter; do not treat it as Vertex authentication." },
    { npm: "@ai-sdk/google-vertex", family: "vertex", caveat: "Vertex adapter is separate from Google AI; project/region remain outside selection." },
    { npm: "@ai-sdk/openai-compatible", family: null, caveat: "Generic compatible transport: service identity, auth, privacy and capabilities are unknown." },
  ],
  caveats: [
    "Exact provider IDs identify registry defaults only, never authenticated service identity. SDK adapter != provider; never infer either from model names.",
    "Raw OpenRouter prices are per token (often strings); engine-catalog prices here are per million tokens. Do not convert engine prices again or ingest raw prices as engine prices.",
    "Only explicit finite nonnegative numeric prices are known; zero is valid. Missing metadata is unknown, not false or free.",
    "Observation time records local normalization, not upstream fetch time or catalog freshness. Capabilities and aliases can change on refresh.",
    "Model listings and adapter registries are not quality, latency, speed or accuracy benchmarks. Release dates and names never rank candidates.",
    "Same engine provider is a selection boundary, not proof of the actual route, privacy, retention or data residency. Provider params and fallback routing are not changed.",
    "Preferred IDs cannot override tool/status, price, provider, modality or context gates. Native memory/progress transport and budget guards remain authoritative.",
    "An explicit anchor may retain legacy display support when catalog tools/status are unknown; explicit unsupported text/tools or deprecation still block automatic use. New substitutions require confirmed tools and active status.",
    "In opted-in Automatic mode, a sibling's confirmed reasoning may satisfy a lane preference even when the anchor's reasoning is unknown, subject to all provider/price/modality/limit gates. This does not infer that the anchor lacks reasoning or that the sibling has higher quality. Unknown baseline capacity never establishes a capacity upgrade.",
  ],
  tasks: {
    quick: { purpose: "Short exchanges with confirmed non-reasoning metadata; lower token cost is a preference, not measured speed.", reasoning: false, criteria: ["reasoning", "preferred", "cost", "anchor", "default", "id"], guard: "Preserve known input modalities and limits; require tools and active status for substitutions." },
    standard: { purpose: "Ordinary tool work anchored to the coworker's standard model.", reasoning: null, criteria: ["anchor"], guard: "Never implicitly replace a missing, excluded or avoided explicit anchor." },
    deep: { purpose: "Substantive work prefers confirmed reasoning and known context/output capacity, not presumed quality.", reasoning: true, criteria: ["reasoning", "preferred", "context", "output", "anchor", "default", "id"], guard: "Same provider and both known token prices no higher than the anchor." },
    memory: { purpose: "Bounded structured recall extraction; prefer inexpensive confirmed non-reasoning text metadata.", reasoning: false, criteria: ["cost", "context", "default", "id"], guard: "Documentation only here: native memory eligibility, tool isolation, transport allowlist and budgets are unchanged." },
    facilitator: { purpose: "Bounded team routing with tool/text support and continuity before optional reasoning.", reasoning: null, criteria: ["anchor", "cost", "default", "id"], guard: "Documentation only here: existing facilitator selection, membership scope and native guards still own admission." },
  },
  priorities: { balanced: [], cost: ["cost"], capability: ["context", "output"] },
};
