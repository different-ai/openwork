import { resolveExtensionIconUrl } from "@/react-app/design-system/extension-icon-src";

const BUNDLED_LOGOS: { match: RegExp; iconSrc: string }[] = [
  { match: /\bslack\b|slack\.com/i, iconSrc: "/ext-slack.svg" },
  { match: /\bhub\s?spot\b|hubspot\.com/i, iconSrc: "/ext-hubspot.svg" },
  { match: /\bgithub\b|github\.com/i, iconSrc: "/ext-github.svg" },
  { match: /\bnotion\b|notion\.(so|com)/i, iconSrc: "/ext-notion.svg" },
  { match: /\blinear\b|linear\.app/i, iconSrc: "/ext-linear.svg" },
  { match: /\bgoogle\b|google\.com/i, iconSrc: "/ext-google-workspace.svg" },
  { match: /\bsentry\b|sentry\.io/i, iconSrc: "/ext-sentry.svg" },
  { match: /\bstripe\b|stripe\.com/i, iconSrc: "/ext-stripe.svg" },
  { match: /\bcontext7\b/i, iconSrc: "/ext-context7.svg" },
];

function isPublicServiceUrl(serviceUrl: string): boolean {
  try {
    const host = new URL(serviceUrl).hostname;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
    if (/^[\d.]+$/.test(host) || host.includes(":")) return false;
    return host.includes(".");
  } catch {
    return false;
  }
}

/** Candidate logo URLs, best first. An empty list means callers render a generic icon. */
export function composerConnectorLogoUrls(input: { name: string; serviceUrl?: string | null }): string[] {
  const serviceUrl = input.serviceUrl?.trim() ?? "";
  const bundled = BUNDLED_LOGOS.find((logo) => logo.match.test(input.name) || (serviceUrl && logo.match.test(serviceUrl)));
  const urls: string[] = [];
  if (bundled) {
    const url = resolveExtensionIconUrl({ iconSrc: bundled.iconSrc });
    if (url) urls.push(url);
  }
  if (serviceUrl && isPublicServiceUrl(serviceUrl)) {
    const favicon = resolveExtensionIconUrl({ serviceUrl });
    if (favicon) urls.push(favicon);
  }
  return urls;
}
