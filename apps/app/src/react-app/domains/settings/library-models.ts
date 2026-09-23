import type { ProviderListItem } from "@/app/types";
import type { CloudImportedProvider } from "@/app/cloud/import-state";
import {
  gatewayConnectProviderKey,
  isCloudManagedProviderKey,
  type GatewayConnectProvider,
} from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import type { LibrarySection } from "./library-sharing";

/**
 * The Models tab of the Library: one row per model provider, grouped by where
 * it comes from, so a person can see every model they can use in the same
 * list as connectors, skills and plugins.
 */

export type LibraryModelState = "ready" | "api_key" | "needs_signin";

export type LibraryModel = {
  id: string;
  name: string;
  vendor: string;
  vendorIconSlug: string | null;
};

export type LibraryModelProvider = {
  /** Stable detail id suffix: the runtime provider id, or the cloud id for a provider that still needs sign-in. */
  key: string;
  providerId: string;
  name: string;
  iconSlug: string | null;
  section: LibrarySection;
  state: LibraryModelState;
  models: LibraryModel[];
  /** Credential sets this person still has to sign in to, with the engine's own provider shape. */
  pending: GatewayConnectProvider[];
  /** Provider id people know (anthropic, google-vertex), for technical details. */
  sourceProviderId: string;
};

const VENDORS: readonly { test: RegExp; vendor: string; slug: string }[] = [
  { test: /gemini|gemma/i, vendor: "Google", slug: "googlegemini" },
  { test: /claude/i, vendor: "Anthropic", slug: "anthropic" },
  { test: /^(gpt|o\d|chatgpt|codex)/i, vendor: "OpenAI", slug: "openai" },
  { test: /mistral|codestral|magistral|devstral|pixtral|ministral/i, vendor: "Mistral", slug: "mistralai" },
  { test: /llama/i, vendor: "Meta", slug: "meta" },
  { test: /deepseek/i, vendor: "DeepSeek", slug: "deepseek" },
  { test: /grok/i, vendor: "xAI", slug: "x" },
  { test: /qwen/i, vendor: "Alibaba", slug: "alibabacloud" },
];

const PROVIDER_ICON: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "googlegemini",
  "google-vertex": "googlecloud",
  "google-vertex-anthropic": "googlecloud",
  mistral: "mistralai",
  ollama: "ollama",
  openrouter: "openrouter",
  groq: "groq",
  deepseek: "deepseek",
  xai: "x",
  "amazon-bedrock": "amazonwebservices",
  azure: "microsoftazure",
  huggingface: "huggingface",
};

/** A provider that still needs sign-in has no local config yet; its name is all we have for a logo. */
function sourceProviderFromName(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.includes("vertex") || lower.includes("google cloud")) return "google-vertex";
  if (lower.includes("gemini") || lower.includes("google")) return "google";
  if (lower.includes("anthropic") || lower.includes("claude")) return "anthropic";
  if (lower.includes("openai")) return "openai";
  if (lower.includes("mistral")) return "mistral";
  if (lower.includes("bedrock")) return "amazon-bedrock";
  if (lower.includes("azure")) return "azure";
  return null;
}

export function providerIconSlug(sourceProviderId: string): string | null {
  return PROVIDER_ICON[sourceProviderId] ?? null;
}

/** Who made a model, so a Claude model served by Google Cloud still shows Anthropic. */
export function modelVendor(model: { id: string; name: string }, provider: { name: string; sourceProviderId: string }): Omit<LibraryModel, "id" | "name"> {
  const lastSegment = model.id.split("/").pop() ?? model.id;
  const match = VENDORS.find((entry) => entry.test.test(model.name) || entry.test.test(lastSegment));
  return match
    ? { vendor: match.vendor, vendorIconSlug: match.slug }
    : { vendor: provider.name, vendorIconSlug: providerIconSlug(provider.sourceProviderId) };
}

function toModels(entries: readonly { id: string; name: string }[], provider: { name: string; sourceProviderId: string }): LibraryModel[] {
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      const key = entry.name || entry.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((entry) => ({ id: entry.id, name: entry.name || entry.id, ...modelVendor(entry, provider) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Where a provider sits in the Library. */
export function librarySectionForProvider(provider: Pick<ProviderListItem, "id" | "source">): LibrarySection {
  if (isCloudManagedProviderKey(provider.id)) return "openwork";
  if (provider.source === "api") return "mine";
  return "mac";
}

export function buildLibraryModelProviders(input: {
  connected: readonly ProviderListItem[];
  pending: readonly GatewayConnectProvider[];
  importedCloudProviders: Record<string, CloudImportedProvider>;
  isAllowed: (providerId: string) => boolean;
}): LibraryModelProvider[] {
  const imported = Object.values(input.importedCloudProviders);
  const rows = new Map<string, LibraryModelProvider>();

  for (const provider of input.connected) {
    if (!input.isAllowed(provider.id)) continue;
    const cloud = imported.find((entry) => entry.providerId === provider.id);
    const sourceProviderId = cloud?.sourceProviderId || provider.id;
    const name = cloud?.name?.trim() || provider.name || provider.id;
    const models = toModels(
      Object.entries(provider.models ?? {}).map(([id, model]) => ({ id, name: model.name ?? id })),
      { name, sourceProviderId },
    );
    if (models.length === 0) continue;
    rows.set(provider.id, {
      key: provider.id,
      providerId: provider.id,
      name,
      iconSlug: providerIconSlug(sourceProviderId),
      section: librarySectionForProvider(provider),
      state: provider.source === "api" && !isCloudManagedProviderKey(provider.id) ? "api_key" : "ready",
      models,
      pending: [],
      sourceProviderId,
    });
  }

  for (const provider of input.pending) {
    if (!input.isAllowed(provider.providerId)) continue;
    const existing = rows.get(provider.providerId);
    if (existing) {
      existing.pending.push(provider);
      continue;
    }
    const cloud = imported.find((entry) => entry.cloudProviderId === provider.cloudProviderId);
    const sourceProviderId = cloud?.sourceProviderId || sourceProviderFromName(provider.name) || provider.providerId;
    const key = `pending:${provider.cloudProviderId}`;
    const current = rows.get(key);
    const models = toModels([...(current?.models ?? []), ...(provider.models ?? []).map((model) => ({ id: model.upstreamModelId || model.id, name: model.name }))], { name: provider.name, sourceProviderId });
    rows.set(key, {
      key,
      providerId: provider.providerId,
      name: provider.name,
      iconSlug: providerIconSlug(sourceProviderId),
      section: "openwork",
      state: "needs_signin",
      models,
      pending: [...(current?.pending ?? []), provider],
      sourceProviderId,
    });
  }

  return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** "Claude Sonnet 4.5, GPT-5.4, Gemini 2.5 Flash and 9 more". */
export function modelNamesSummary(models: readonly Pick<LibraryModel, "name">[], shown = 3): string {
  if (models.length === 0) return "";
  const names = models.slice(0, shown).map((model) => model.name).join(", ");
  const rest = models.length - shown;
  return rest > 0 ? `${names} and ${rest} more` : names;
}

export function modelCountLabel(count: number): string {
  return count === 1 ? "1 model" : `${count} models`;
}

export const libraryModelDetailId = (provider: Pick<LibraryModelProvider, "key">) => `model:${provider.key}`;

export function parseLibraryModelDetailId(detailId: string): string | null {
  return detailId.startsWith("model:") ? detailId.slice("model:".length) : null;
}

/** The first credential set to sign in to, keyed the way the sign-in engine tracks it. */
export function libraryModelSignInKey(provider: LibraryModelProvider): string | null {
  const first = provider.pending[0];
  return first ? gatewayConnectProviderKey(first) : null;
}
