import { z } from "zod";
import type { GatewayMemberConnection } from "./gateway-member-connections-data";
import { getProviderIconSlug } from "./llm-provider-data";

/**
 * The Models tab of My Library. Den knows the models the organization gives
 * a person through the AI Gateway, grouped by provider. The web cannot see
 * models that only live on someone's computer, so every row here comes from
 * the organization.
 */

const usableModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  upstreamModelId: z.string(),
  modelGroupName: z.string(),
  credentialSetId: z.string(),
  credentialSetName: z.string(),
});

const usableProviderSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  name: z.string(),
  credentialStatus: z.enum(["ready", "member_auth_required", "org_credential_missing"]),
  models: z.array(usableModelSchema),
  authorizationRequests: z.array(z.object({
    credentialSetId: z.string(),
    name: z.string(),
    models: z.array(usableModelSchema).optional(),
  })),
});

export const usableProvidersResponseSchema = z.object({ inferenceProviders: z.array(usableProviderSchema) });
export type UsableProvider = z.infer<typeof usableProviderSchema>;

export type LibraryModelState = "ready" | "needs_signin" | "blocked";

export type LibraryModel = {
  name: string;
  vendor: string;
  vendorIconSlug: string;
};

export type LibraryModelProvider = {
  id: string;
  providerKey: string;
  name: string;
  iconSlug: string;
  state: LibraryModelState;
  models: LibraryModel[];
  /** The credential set this person signs in to, when the provider uses their own account. */
  signInSet: GatewayMemberConnection | null;
  /** The account in use, once signed in. */
  account: string | null;
  /** The person's own credential sets for this provider; empty when the organization signs in for everyone. */
  memberSets: GatewayMemberConnection[];
  modelGroups: string[];
};

const VENDORS: readonly { test: RegExp; vendor: string; slug: string }[] = [
  { test: /gemini|gemma|palm/i, vendor: "Google", slug: "googlegemini" },
  { test: /claude/i, vendor: "Anthropic", slug: "anthropic" },
  { test: /^(gpt|o\d|chatgpt|openai)/i, vendor: "OpenAI", slug: "openai" },
  { test: /mistral|codestral|magistral|pixtral|ministral/i, vendor: "Mistral", slug: "mistralai" },
  { test: /llama/i, vendor: "Meta", slug: "meta" },
  { test: /deepseek/i, vendor: "DeepSeek", slug: "deepseek" },
  { test: /grok/i, vendor: "xAI", slug: "x" },
];

/** Who made a model, from its upstream id or name, so a Claude model on Google Cloud still shows Anthropic. */
export function modelVendor(model: { upstreamModelId: string; name: string }, provider: { name: string; providerId: string }): LibraryModel {
  const lastSegment = model.upstreamModelId.split("/").pop() ?? model.upstreamModelId;
  const match = VENDORS.find((entry) => entry.test.test(lastSegment) || entry.test.test(model.name));
  return {
    name: model.name,
    vendor: match?.vendor ?? provider.name,
    vendorIconSlug: match?.slug ?? getProviderIconSlug(provider.providerId),
  };
}

/** Real company logos for the providers people know by name. */
export function providerIconSlug(providerKey: string): string {
  if (providerKey.startsWith("google-vertex")) return "googlecloud";
  if (providerKey === "mistral") return "mistralai";
  return getProviderIconSlug(providerKey);
}

function uniqueModels(models: readonly LibraryModel[]): LibraryModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.name)) return false;
    seen.add(model.name);
    return true;
  });
}

function canSignIn(set: GatewayMemberConnection): boolean {
  return set.hasAccess && !set.configurationRequired;
}

export function buildLibraryModelProviders(providers: readonly UsableProvider[], connections: readonly GatewayMemberConnection[]): LibraryModelProvider[] {
  return providers.map((provider) => {
    const memberSets = connections.filter((connection) => connection.providerId === provider.id);
    const pendingModels = provider.authorizationRequests.flatMap((request) => request.models ?? []);
    const everyModel = [...provider.models, ...pendingModels];
    const models = uniqueModels(everyModel.map((model) => modelVendor(model, provider)))
      .sort((left, right) => left.name.localeCompare(right.name));
    const pendingSetIds = new Set(provider.authorizationRequests.map((request) => request.credentialSetId));
    const signInSet = memberSets.find((set) => pendingSetIds.has(set.credentialSetId) && canSignIn(set))
      ?? memberSets.find((set) => canSignIn(set) && !set.ready)
      ?? memberSets.find(canSignIn)
      ?? null;
    const needsSignIn = memberSets.some((set) => pendingSetIds.has(set.credentialSetId) && canSignIn(set));
    const state: LibraryModelState = needsSignIn && provider.models.length === 0
      ? "needs_signin"
      : provider.models.length > 0
        ? "ready"
        : needsSignIn ? "needs_signin" : "blocked";
    const account = memberSets.find((set) => set.hasCredential && set.accountEmail)?.accountEmail ?? null;
    const modelGroups = [...new Set(everyModel.map((model) => model.modelGroupName))].sort();
    return {
      id: provider.id,
      providerKey: provider.providerId,
      name: provider.name,
      iconSlug: providerIconSlug(provider.providerId),
      state,
      models,
      signInSet,
      account,
      memberSets,
      modelGroups,
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

/** "Gemini 2.5 Pro, Gemini 2.5 Flash, Claude Sonnet 4.5 and 9 more". */
export function modelNamesSummary(models: readonly LibraryModel[], shown = 3): string {
  if (models.length === 0) return "No models yet";
  const names = models.slice(0, shown).map((model) => model.name).join(", ");
  const rest = models.length - shown;
  return rest > 0 ? `${names} and ${rest} more` : names;
}

export function modelCount(count: number): string {
  return count === 1 ? "1 model" : `${count} models`;
}

/** The brand people sign in with; every member sign-in the Gateway supports today is Google. */
export function signInBrand(provider: Pick<LibraryModelProvider, "providerKey">): string {
  return provider.providerKey.startsWith("google") ? "Google" : "your account";
}

export function matchesModelQuery(provider: LibraryModelProvider, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${provider.name} ${provider.models.map((model) => model.name).join(" ")}`.toLowerCase().includes(needle);
}
