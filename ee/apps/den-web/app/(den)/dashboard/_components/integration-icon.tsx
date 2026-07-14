"use client";

import { useMemo, useState } from "react";
import { Plug } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Registrable (apex) domain for favicon lookups. MCP servers usually live on
 * subdomains without favicons (mcp.notion.com), while the apex (notion.com)
 * serves the real brand icon.
 */
function apexDomain(serviceUrl?: string): string | undefined {
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
 * then the apex-domain favicon. The <img> onError handler walks this list so
 * one blocked CDN or missing favicon never leaves a broken tile — worst case
 * we land on the lucide fallback glyph.
 */
function iconCandidates(input: {
  iconUrl?: string;
  simpleIconSlug?: string;
  serviceUrl?: string;
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

export function IntegrationIcon({
  name,
  iconUrl,
  simpleIconSlug,
  serviceUrl,
  fallbackIcon: FallbackIcon = Plug,
  className = "h-10 w-10 rounded-[12px]",
  imageClassName = "h-5 w-5",
}: {
  name: string;
  iconUrl?: string;
  simpleIconSlug?: string;
  serviceUrl?: string;
  fallbackIcon?: LucideIcon;
  className?: string;
  imageClassName?: string;
}) {
  const candidates = useMemo(
    () => iconCandidates({ iconUrl, simpleIconSlug, serviceUrl }),
    [iconUrl, simpleIconSlug, serviceUrl],
  );
  const [failedCount, setFailedCount] = useState(0);
  const src = candidates[failedCount];

  return (
    <div className={`flex shrink-0 items-center justify-center border border-gray-100 bg-white shadow-sm ${className}`}>
      {src ? (
        <img
          key={src}
          src={src}
          alt={`${name} icon`}
          loading="lazy"
          onError={() => setFailedCount((count) => count + 1)}
          className={`object-contain ${imageClassName}`}
        />
      ) : (
        <FallbackIcon className="h-5 w-5 text-gray-500" aria-hidden />
      )}
    </div>
  );
}
