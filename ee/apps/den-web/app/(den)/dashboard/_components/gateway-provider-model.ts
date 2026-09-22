/**
 * Pure helpers behind the AI Gateway provider form.
 *
 * The page shows one provider as one form: Key → Who can use it → Models.
 * Underneath, that is still exactly one inference provider + one credential
 * set + one model group + its access grants. These helpers map between the
 * two without touching the API shapes, so they stay free of React and fetch.
 */

import type { GatewayAccessGrant, GatewayAudience } from "@openwork/types/den/gateway";
import type { DenOrgContext } from "../../_lib/den-org";
import { isGoogleVertexNpm, type DenInferenceProvider, type DenInferenceProviderDetails } from "./inference-provider-request";
import type { DenModelsDevProviderSummary } from "./llm-provider-data";

/** `orgWide | teamIds | memberIds`, the access input Dashboards and Plugins use. */
export type GatewayWhoValue = { orgWide: boolean; teamIds: string[]; memberIds: string[] };

export const EVERYONE: GatewayWhoValue = { orgWide: true, teamIds: [], memberIds: [] };

// --- Catalog ---

/** Most common first. Anything else sorts by name behind "Show N more providers". */
export const FEATURED_CATALOG_PROVIDER_IDS = [
  "openrouter",
  "anthropic",
  "openai",
  "google",
  "google-vertex",
  "azure",
  "mistral",
  "groq",
  "deepseek",
  "xai",
] as const;

/** One short line per featured provider: what you get, not how it works (C3). */
const CATALOG_PROVIDER_BLURBS: Record<string, string> = {
  openrouter: "One key, hundreds of models from every vendor",
  anthropic: "Claude models",
  openai: "GPT models",
  google: "Gemini models",
  "google-vertex": "Gemini and Claude on Google Cloud, your team can sign in with Google",
  azure: "GPT models on your Azure resource",
  mistral: "Mistral and Codestral models",
  groq: "Fast open models",
  deepseek: "DeepSeek models",
  xai: "Grok models",
};

export function getCatalogProviderBlurb(providerId: string): string | null {
  return CATALOG_PROVIDER_BLURBS[providerId] ?? null;
}

export function sortCatalogProviders<T extends Pick<DenModelsDevProviderSummary, "id" | "name">>(providers: T[]): { featured: T[]; rest: T[] } {
  const featured = FEATURED_CATALOG_PROVIDER_IDS.flatMap((id) => providers.filter((provider) => provider.id === id));
  const rest = providers
    .filter((provider) => !FEATURED_CATALOG_PROVIDER_IDS.some((id) => id === provider.id))
    .sort((left, right) => left.name.localeCompare(right.name));
  return { featured, rest };
}

// --- Credential shape (Key panel) ---

export type GatewayKeyShape = "service_account" | "api_keys" | "api_key";

export function getKeyShape(npm: string | null, envNames: string[]): GatewayKeyShape {
  if (isGoogleVertexNpm(npm)) return "service_account";
  return envNames.length > 1 ? "api_keys" : "api_key";
}

const OPENAI_API_BASE = "https://api.openai.com/v1";

/**
 * `Test key` reuses the existing `/v1/llm-providers/test-connection` probe,
 * which only speaks the OpenAI `GET /models` dialect. Providers outside it
 * (Anthropic, Google, Vertex, Azure) get no Test key button rather than a new
 * endpoint.
 */
export function getTestKeyApiBase(npm: string | null, apiBase: string | null): string | null {
  if (npm === "@ai-sdk/openai") return apiBase ?? OPENAI_API_BASE;
  if (npm === "@ai-sdk/openai-compatible" || npm === "@openrouter/ai-sdk-provider") return apiBase;
  return null;
}

// --- Access (Who can use it) ---

export function audiencesFromWho(who: GatewayWhoValue): GatewayAudience[] {
  return [
    ...(who.orgWide ? [{ type: "organization" as const }] : []),
    ...[...new Set(who.teamIds)].map((teamId) => ({ type: "team" as const, teamId })),
    ...[...new Set(who.memberIds)].map((memberId) => ({ type: "member" as const, memberId })),
  ];
}

export function whoFromGrants(grants: Pick<GatewayAccessGrant, "audience">[]): GatewayWhoValue {
  return {
    orgWide: grants.some((grant) => grant.audience.type === "organization"),
    teamIds: grants.flatMap((grant) => (grant.audience.type === "team" ? [grant.audience.teamId] : [])),
    memberIds: grants.flatMap((grant) => (grant.audience.type === "member" ? [grant.audience.memberId] : [])),
  };
}

function audienceKey(audience: GatewayAudience) {
  if (audience.type === "organization") return "organization";
  return audience.type === "team" ? `team:${audience.teamId}` : `member:${audience.memberId}`;
}

/** Grants to create and delete so the pair's audiences equal `who`. */
export function planGrantChanges(existing: GatewayAccessGrant[], who: GatewayWhoValue) {
  const desired = audiencesFromWho(who);
  const desiredKeys = new Set(desired.map(audienceKey));
  const existingKeys = new Set(existing.map((grant) => audienceKey(grant.audience)));
  return {
    create: desired.filter((audience) => !existingKeys.has(audienceKey(audience))),
    removeGrantIds: existing.filter((grant) => !desiredKeys.has(audienceKey(grant.audience))).map((grant) => grant.id),
  };
}

export function sameWho(left: GatewayWhoValue, right: GatewayWhoValue) {
  const sort = (values: string[]) => [...new Set(values)].sort().join(",");
  return left.orgWide === right.orgWide && sort(left.teamIds) === sort(right.teamIds) && sort(left.memberIds) === sort(right.memberIds);
}

// --- One provider = one set + one group + its grants ---

export type GatewayPrimaryPair = { credentialSetId: string | null; modelGroupId: string | null };

/**
 * The credential set and model group this page edits. Providers created here
 * have exactly one of each. Older providers may have more; the pair most
 * grants use wins, and `isSimpleProvider` tells the page to show the rest.
 */
export function resolvePrimaryPair(provider: Pick<DenInferenceProviderDetails, "credentialSets" | "modelGroups" | "accessGrants">): GatewayPrimaryPair {
  const counts = new Map<string, { credentialSetId: string; modelGroupId: string; count: number }>();
  for (const grant of provider.accessGrants) {
    const key = `${grant.credentialSetId}|${grant.modelGroupId}`;
    const entry = counts.get(key) ?? { credentialSetId: grant.credentialSetId, modelGroupId: grant.modelGroupId, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const top = [...counts.values()].sort((left, right) => right.count - left.count)[0];
  if (top) return { credentialSetId: top.credentialSetId, modelGroupId: top.modelGroupId };
  return {
    credentialSetId: provider.credentialSets.find((set) => set.status === "active")?.id ?? provider.credentialSets[0]?.id ?? null,
    modelGroupId: provider.modelGroups.find((group) => group.status === "active")?.id ?? provider.modelGroups[0]?.id ?? null,
  };
}

export function isSimpleProvider(provider: Pick<DenInferenceProviderDetails, "credentialSets" | "modelGroups" | "accessGrants">): boolean {
  if (provider.credentialSets.length > 1 || provider.modelGroups.length > 1) return false;
  const pair = resolvePrimaryPair(provider);
  return provider.accessGrants.every((grant) => grant.credentialSetId === pair.credentialSetId && grant.modelGroupId === pair.modelGroupId);
}

// --- Provider row ---

export type GatewayRowStatus = "ready" | "give_access" | "key_missing" | "sign_in" | "off";

export function describeProviderRow(
  provider: Pick<DenInferenceProvider, "status" | "modelIds" | "credentialSets" | "accessGrants">,
  orgContext: Pick<DenOrgContext, "teams" | "members"> | null,
): { models: string; who: string; status: GatewayRowStatus } {
  const modelIds = provider.modelIds ?? [];
  const models = modelIds.length === 0 ? "All models" : `${modelIds.length} ${modelIds.length === 1 ? "model" : "models"}`;
  const grants = provider.accessGrants ?? [];
  const who = describeWho(whoFromGrants(grants), orgContext);
  const sets = provider.credentialSets ?? [];
  let status: GatewayRowStatus = "ready";
  if (provider.status !== "active") status = "off";
  else if (!sets.some((set) => set.status === "active" && (set.configured || set.credentialMode === "member"))) status = "key_missing";
  else if (!grants.length) status = "give_access";
  else if (sets.every((set) => set.credentialMode === "member")) status = "sign_in";
  return { models, who, status };
}

export function describeWho(who: GatewayWhoValue, orgContext: Pick<DenOrgContext, "teams" | "members"> | null): string {
  if (who.orgWide) return "Everyone";
  const names = [
    ...who.teamIds.map((id) => orgContext?.teams.find((team) => team.id === id)?.name ?? "Removed team"),
    ...who.memberIds.map((id) => orgContext?.members.find((member) => member.id === id)?.user.name ?? "Removed member"),
  ];
  if (!names.length) return "Nobody yet";
  return names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ");
}

export const ROW_STATUS_LABEL: Record<GatewayRowStatus, string> = {
  ready: "Ready",
  give_access: "Give access",
  key_missing: "Add key",
  sign_in: "People sign in",
  off: "Off",
};

/** A second instance of the same provider needs a name; the first does not. */
export function needsInstanceName(providerId: string, existing: Pick<DenInferenceProvider, "id" | "providerId">[], selfId: string | null) {
  return existing.some((provider) => provider.providerId === providerId && provider.id !== selfId);
}
