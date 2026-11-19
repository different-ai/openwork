/** Registrable (apex) domain used by Den's existing favicon lookup. */
export function apexDomain(serviceUrl?: string | null): string | undefined {
  const trimmed = serviceUrl?.trim();
  if (!trimmed?.match(/^https?:\/\//i)) return undefined;
  try {
    const host = new URL(trimmed).hostname;
    const labels = host.split(".").filter(Boolean);
    if (labels.length < 2) return host;
    return labels.slice(-2).join(".");
  } catch {
    return undefined;
  }
}

const BUNDLED_ICONS_BY_APEX: Record<string, string> = {
  "notion.com": "/integrations/notion.svg",
  "linear.app": "/integrations/linear.svg",
  "okta.com": "/integrations/okta.svg",
  "slack.com": "/integrations/slack.svg",
  "stripe.com": "/integrations/stripe.svg",
  "sentry.dev": "/integrations/sentry.svg",
  "sentry.io": "/integrations/sentry.svg",
  "context7.com": "/integrations/context7.png",
  "google.com": "/integrations/google.svg",
  "openai.com": "/integrations/openai.svg",
  "openworklabs.com": "/openwork-mark.svg",
};

const BUNDLED_ICONS_BY_SLUG: Record<string, string> = {
  okta: "/integrations/okta.svg",
  openai: "/integrations/openai.svg",
  openwork: "/openwork-mark.svg",
  slack: "/integrations/slack.svg",
};

const SIMPLE_ICON_SLUG_BY_APEX: Record<string, string> = {
  "githubcopilot.com": "github",
  "github.com": "github",
  "slack.com": "slack",
  "granola.ai": "granola",
  "polar.sh": "polar",
  "exa.ai": "exa",
  "render.com": "render",
  // Brands without square Simple Icons marks use their apex favicon.
  "airtable.com": "airtable",
  "figma.com": "figma",
  "grafana.com": "grafana",
  "huggingface.co": "huggingface",
  "lucid.app": "lucid",
  "mural.co": "mural",
  "posthog.com": "posthog",
  "vercel.com": "vercel",
};

/** Den's permissive image sanitizer; Workbot uses the stricter trust policy below. */
export function safeBrandImageUrl(value?: string): string | undefined {
  if (!value) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159) || code === 92) return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("/") && !trimmed.startsWith("//")) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

function simpleIconUrl(slug?: string): string | undefined {
  const trimmed = slug?.trim();
  if (!trimmed || !/^[a-z0-9]+$/i.test(trimmed)) return undefined;
  return `https://cdn.simpleicons.org/${encodeURIComponent(trimmed)}`;
}

/** Den order is intentionally preserved: explicit, bundled, Simple Icons, favicon. */
export function brandIconCandidates(input: {
  iconUrl?: string;
  simpleIconSlug?: string;
  serviceUrl?: string | null;
}): string[] {
  const candidates: string[] = [];
  const iconUrl = safeBrandImageUrl(input.iconUrl);
  if (iconUrl) candidates.push(iconUrl);
  const apex = apexDomain(input.serviceUrl);
  const simpleIconSlug = input.simpleIconSlug ?? (apex ? SIMPLE_ICON_SLUG_BY_APEX[apex] : undefined);
  const bundledBySlug = simpleIconSlug ? BUNDLED_ICONS_BY_SLUG[simpleIconSlug.toLowerCase()] : undefined;
  const bundled = bundledBySlug ?? (apex ? BUNDLED_ICONS_BY_APEX[apex] : undefined);
  if (bundled) candidates.push(bundled);
  const simpleIcon = bundledBySlug ? undefined : simpleIconUrl(simpleIconSlug);
  if (simpleIcon) candidates.push(simpleIcon);
  if (apex) candidates.push(faviconUrl(apex));
  return candidates;
}

export type BrandHint = { simpleIconSlug?: string; serviceUrl?: string };

/** Official domains, not an MCP server's deployment address. */
const BRAND_BY_NAME: Record<string, BrandHint> = {
  asana: { simpleIconSlug: "asana" },
  confluence: { simpleIconSlug: "confluence" },
  context7: { serviceUrl: "https://context7.com" },
  deepwiki: { serviceUrl: "https://deepwiki.com" },
  exa: { serviceUrl: "https://exa.ai" },
  figma: { simpleIconSlug: "figma" },
  github: { simpleIconSlug: "github" },
  gmail: { simpleIconSlug: "gmail" },
  "google calendar": { simpleIconSlug: "googlecalendar" },
  "google drive": { simpleIconSlug: "googledrive" },
  "google workspace": { serviceUrl: "https://google.com" },
  granola: { simpleIconSlug: "granola" },
  hubspot: { simpleIconSlug: "hubspot" },
  jira: { simpleIconSlug: "jira" },
  linear: { serviceUrl: "https://linear.app" },
  "microsoft 365": { serviceUrl: "https://microsoft.com" },
  "microsoft entra id": { serviceUrl: "https://microsoft.com" },
  notion: { serviceUrl: "https://notion.com" },
  okta: { simpleIconSlug: "okta" },
  salesforce: { simpleIconSlug: "salesforce" },
  sentry: { serviceUrl: "https://sentry.io" },
  slack: { serviceUrl: "https://slack.com" },
  stripe: { serviceUrl: "https://stripe.com" },
  zendesk: { simpleIconSlug: "zendesk" },
};
const BRAND_NAMES = Object.keys(BRAND_BY_NAME).sort((a, b) => b.length - a.length);

/** Remove only a redundant slash-separated slug; retain distinct connection labels. */
export function connectorDisplayName(name: string): string {
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+\/\s+/);
  if (parts.length !== 2) return trimmed;
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return normalize(parts[0]!) === normalize(parts[1]!) ? parts[0]!.trim() : trimmed;
}

function knownBrandHint(name: string): BrandHint | undefined {
  const normalized = connectorDisplayName(name).toLowerCase().replace(/[-_]+/g, " ");
  const key = BRAND_NAMES.find((brand) => {
    const start = normalized.indexOf(brand);
    if (start < 0) return false;
    // A brand is a whole word/phrase, never a substring of a different name.
    return new RegExp(`(^|[^a-z0-9])${brand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(normalized);
  });
  return key ? { ...BRAND_BY_NAME[key] } : undefined;
}

/** Public hostname only: no credentials, IP literals, internal suffixes or URL secrets. */
function publicHostname(value?: string | null): string | undefined {
  if (!value || /[\u0000-\u0020\u007f-\u009f\\]/.test(value.trim())) return undefined;
  try {
    const url = new URL(value.trim());
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return undefined;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname.includes(".") || hostname.includes(":") || /^[\d.]+$/.test(hostname)) return undefined;
    if (/(^|\.)(localhost|test|local|internal)$/.test(hostname)) return undefined;
    if (!hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return undefined;
    return hostname;
  } catch {
    return undefined;
  }
}

export function brandHintFor(name: string, url?: string | null): BrandHint {
  const known = knownBrandHint(name);
  if (known) return known;
  const hostname = publicHostname(url);
  return hostname ? { serviceUrl: `https://${hostname}` } : {};
}

function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}`;
}

/** Accept only public static logo sources, without query strings or fragments. */
function trustedConnectorIcon(value?: string | null): string | undefined {
  const safe = safeBrandImageUrl(value ?? undefined);
  if (!safe) return undefined;
  if (/^\/integrations\/[a-z0-9_-]+\.(svg|png|webp|jpe?g)$/i.test(safe)) return safe;
  if (!/^https:\/\/cdn\.simpleicons\.org\/[a-z0-9]+(?:\/[a-z0-9]+)?\/?$/i.test(safe)) return undefined;
  try {
    const url = new URL(safe);
    if (url.hostname !== "cdn.simpleicons.org" || url.port || url.search || url.hash) return undefined;
    if (!/^\/[a-z0-9]+(?:\/[a-z0-9]+)?\/?$/i.test(url.pathname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Workbot: native identity/known brand first, trusted metadata second, official
 * domain favicon last. Unknown public servers use Den's apex favicon proxy;
 * server paths, queries, credentials and arbitrary image hosts never escape.
 * Pure: does not fetch metadata or remote images.
 */
export function connectorIconCandidates(input: {
  name: string;
  url?: string | null;
  nativeProviderKey?: string | null;
  iconUrl?: string | null;
}): string[] {
  const nativeName = input.nativeProviderKey === "google-workspace" ? "google workspace"
    : input.nativeProviderKey === "microsoft-365" ? "microsoft 365" : undefined;
  const hint = knownBrandHint(nativeName ?? input.name) ?? brandHintFor(input.name, input.url);
  const brandCandidates = brandIconCandidates(hint);
  const primary = brandCandidates.filter((candidate) => !candidate.startsWith("https://www.google.com/s2/favicons?"));
  const favicons = brandCandidates.filter((candidate) => candidate.startsWith("https://www.google.com/s2/favicons?"));
  const explicit = trustedConnectorIcon(input.iconUrl);
  // A native provider is authoritative even when its only mark is a favicon.
  if (nativeName) return [...new Set([...brandCandidates, ...(explicit ? [explicit] : [])])];
  return [...new Set([...primary, ...(explicit ? [explicit] : []), ...favicons])];
}
