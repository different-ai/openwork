/**
 * Brand logo candidates for an LLM provider, tried in order and advanced on
 * `img` onError. Providers should almost always show their real logo, so the
 * monogram in `ProviderIcon` is the last resort rather than the default look.
 */

/** Providers whose Simple Icons slug differs from their OpenCode provider id. */
const SIMPLE_ICON_SLUGS: Record<string, string> = {
  google: "googlegemini",
  "google-vertex": "googlegemini",
  "google-vertex-anthropic": "googlegemini",
  gemini: "googlegemini",
  mistral: "mistralai",
  huggingface: "huggingface",
  xai: "x",
  azure: "microsoftazure",
  bedrock: "amazonwebservices",
  "amazon-bedrock": "amazonwebservices",
  vercel: "vercel",
  llama: "meta",
  meta: "meta",
};

/** Simple Icons has no icon for these, so skip straight to the favicon step. */
const SIMPLE_ICON_MISSES = new Set([
  "openai",
  "azure",
  "microsoftazure",
  "groq",
  "cohere",
  "together",
  "togetherai",
  "bedrock",
  "amazon-bedrock",
  "amazonwebservices",
  "fireworks",
  "opencode",
  "openwork",
]);

/** Apex domains for providers whose id does not resolve to their own domain. */
const PROVIDER_DOMAINS: Record<string, string> = {
  openai: "openai.com",
  anthropic: "anthropic.com",
  google: "ai.google",
  "google-vertex": "cloud.google.com",
  "google-vertex-anthropic": "cloud.google.com",
  azure: "azure.microsoft.com",
  bedrock: "aws.amazon.com",
  "amazon-bedrock": "aws.amazon.com",
  groq: "groq.com",
  cohere: "cohere.com",
  together: "together.ai",
  togetherai: "together.ai",
  fireworks: "fireworks.ai",
  mistral: "mistral.ai",
  deepseek: "deepseek.com",
  openrouter: "openrouter.ai",
  perplexity: "perplexity.ai",
  huggingface: "huggingface.co",
  ollama: "ollama.com",
  xai: "x.ai",
  opencode: "opencode.ai",
  openwork: "openworklabs.com",
  abacus: "abacus.ai",
};

/**
 * Long-tail catalog ids are slugified domains ("abliteration-ai", "302ai"),
 * so unslugging them recovers a real favicon instead of a monogram.
 */
function domainFromSlug(id: string): string | undefined {
  const dashed = id.match(/^(.+)-([a-z]{2,})$/);
  if (dashed) return `${dashed[1]}.${dashed[2]}`;
  const numeric = id.match(/^(\d+)(ai|com)$/);
  if (numeric) return `${numeric[1]}.${numeric[2]}`;
  return undefined;
}

function apexDomain(hostname: string) {
  const labels = hostname.split(".").filter(Boolean);
  return labels.length < 2 ? labels.join(".") : labels.slice(-2).join(".");
}

function faviconUrl(domain: string) {
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
}

/**
 * Ordered logo URLs for a provider. An id that already looks like a domain
 * ("302.ai") or a configured base URL both resolve through the favicon step,
 * which is what gives long-tail and custom providers a real mark.
 */
export function providerLogoCandidates(input: {
  providerId?: string | null;
  baseUrl?: string | null;
}): string[] {
  const id = input.providerId?.trim().toLowerCase() ?? "";
  const candidates: string[] = [];

  if (id) {
    const slug = SIMPLE_ICON_SLUGS[id] ?? id;
    if (!SIMPLE_ICON_MISSES.has(slug) && /^[a-z0-9]+$/.test(slug)) {
      candidates.push(`https://cdn.simpleicons.org/${slug}`);
    }

    const mapped = PROVIDER_DOMAINS[id] ?? (id.includes(".") ? apexDomain(id) : domainFromSlug(id));
    if (mapped) {
      candidates.push(faviconUrl(mapped));
    }
  }

  const baseUrl = input.baseUrl?.trim();
  if (baseUrl?.match(/^https?:\/\//i)) {
    try {
      candidates.push(faviconUrl(apexDomain(new URL(baseUrl).hostname)));
    } catch {
      // Ignore unparseable base URLs — the monogram still covers this provider.
    }
  }

  return [...new Set(candidates)];
}
