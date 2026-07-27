/**
 * Registrable (apex) domain for favicon lookups. Service URLs usually point at
 * a subdomain or a docs path (mcp.notion.com, docs.anthropic.com) while the
 * apex (notion.com, anthropic.com) serves the real brand icon.
 */
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

/** Bundled brand icons keyed by apex domain — no network, no adblock, no flaky favicons. */
const BUNDLED_ICONS_BY_APEX: Record<string, string> = {
  "notion.com": "/integrations/notion.svg",
  "linear.app": "/integrations/linear.svg",
  "stripe.com": "/integrations/stripe.svg",
  "sentry.dev": "/integrations/sentry.svg",
  "sentry.io": "/integrations/sentry.svg",
  "context7.com": "/integrations/context7.png",
  "google.com": "/integrations/google.svg",
};

const SIMPLE_ICON_SLUG_BY_APEX: Record<string, string> = {
  "slack.com": "slack",
  "granola.ai": "granola",
  "polar.sh": "polar",
  "exa.ai": "exa",
  "render.com": "render",
};

/**
 * Ordered icon candidates: explicit URL first, then a bundled brand icon
 * matched from the service URL (never flaky), then the Simple Icons CDN,
 * then the apex-domain favicon. Consumers walk this list on image error so
 * one blocked CDN or missing favicon never leaves a broken tile.
 */
export function brandIconCandidates(input: {
  iconUrl?: string;
  simpleIconSlug?: string;
  serviceUrl?: string | null;
}): string[] {
  const candidates: string[] = [];
  if (input.iconUrl) candidates.push(input.iconUrl);
  const apex = apexDomain(input.serviceUrl);
  const bundled = apex ? BUNDLED_ICONS_BY_APEX[apex] : undefined;
  const simpleIconSlug = input.simpleIconSlug ?? (apex ? SIMPLE_ICON_SLUG_BY_APEX[apex] : undefined);
  if (bundled) candidates.push(bundled);
  if (simpleIconSlug) candidates.push(`https://cdn.simpleicons.org/${simpleIconSlug}`);
  if (apex) candidates.push(`https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(apex)}`);
  return candidates;
}
