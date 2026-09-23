"use client";

import { FileText, Plug, SquareTerminal } from "lucide-react";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { apexDomain } from "../../_lib/brand-icon";

type BrandHint = { simpleIconSlug?: string; serviceUrl?: string };

/** Well-known services, by display name, so a server on any address still shows its real logo. */
const BRAND_BY_NAME: Record<string, BrandHint> = {
  asana: { simpleIconSlug: "asana" },
  confluence: { simpleIconSlug: "confluence" },
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
  notion: { serviceUrl: "https://notion.com" },
  salesforce: { simpleIconSlug: "salesforce" },
  sentry: { serviceUrl: "https://sentry.io" },
  slack: { serviceUrl: "https://slack.com" },
  stripe: { serviceUrl: "https://stripe.com" },
  zendesk: { simpleIconSlug: "zendesk" },
};

function isPublicServiceUrl(url: string | null | undefined): boolean {
  const apex = apexDomain(url);
  if (!apex) return false;
  return apex.includes(".") && !/^(localhost|\d+\.\d+)$/.test(apex) && !apex.endsWith(".test") && !apex.endsWith(".local");
}

export function brandHintFor(name: string, url?: string | null): BrandHint {
  const known = BRAND_BY_NAME[name.trim().toLowerCase()];
  if (known) return known;
  return isPublicServiceUrl(url) && url ? { serviceUrl: url } : {};
}

const SIZE = {
  xs: { box: "h-6 w-6 rounded-md border-gray-200", image: "h-3.5 w-3.5" },
  sm: { box: "h-8 w-8 rounded-[7px] border-gray-200", image: "h-[18px] w-[18px]" },
  md: { box: "h-10 w-10 rounded-[10px] border-gray-200", image: "h-5 w-5" },
  lg: { box: "h-10 w-10 rounded-xl border-gray-200", image: "h-5 w-5" },
} as const;

export function ConnectorLogo({ name, url, iconUrl, size = "sm" }: {
  name: string;
  url?: string | null;
  iconUrl?: string;
  size?: keyof typeof SIZE;
}) {
  const hint = brandHintFor(name, url);
  if (!iconUrl && !hint.simpleIconSlug && !hint.serviceUrl) {
    return (
      <span className={`flex shrink-0 items-center justify-center border bg-white text-gray-500 ${SIZE[size].box}`}>
        <Plug className="h-4 w-4" aria-hidden />
      </span>
    );
  }
  return (
    <DenBrandMark
      name={name}
      iconUrl={iconUrl}
      simpleIconSlug={hint.simpleIconSlug}
      serviceUrl={hint.serviceUrl}
      className={SIZE[size].box}
      imageClassName={SIZE[size].image}
    />
  );
}

/** Plugins and skills are not brands, so they get a quiet gray tile. */
export function LetterTile({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  const letter = name.trim().charAt(0).toUpperCase() || "P";
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center bg-gray-100 font-medium text-gray-500 ${size === "lg" ? "h-10 w-10 rounded-xl text-[16px]" : "h-8 w-8 rounded-[7px] text-[13px]"}`}
    >
      {letter}
    </span>
  );
}

export function KindTile({ kind }: { kind: "skill" | "command" }) {
  const Icon = kind === "skill" ? FileText : SquareTerminal;
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px] bg-gray-50 text-gray-500">
      <Icon className="h-4 w-4" strokeWidth={1.8} />
    </span>
  );
}
