"use client";

import { FileText, Plug, SquareTerminal } from "lucide-react";
import { preload } from "react-dom";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { brandHintFor } from "@openwork/types/connector-brand";
import { brandIconCandidates } from "../../_lib/brand-icon";

export { brandHintFor } from "@openwork/types/connector-brand";

/** Starts downloading the logo a ConnectorLogo would show, before its row renders. */
export function preloadConnectorLogo(name: string, url?: string | null) {
  const [src] = brandIconCandidates(brandHintFor(name, url));
  if (src) preload(src, { as: "image" });
}

const SIZE = {
  xs: { box: "h-6 w-6 rounded-md border-gray-200", image: "h-3.5 w-3.5" },
  sm: { box: "h-8 w-8 rounded-lg border-gray-200", image: "h-[18px] w-[18px]" },
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

/** Resolve real named-service marks without inventing a logo for a person's plugin. */
export function PluginLogo({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  const hint = brandHintFor(name);
  return hint.simpleIconSlug || hint.serviceUrl
    ? <ConnectorLogo name={name} size={size} />
    : <LetterTile name={name} size={size} />;
}

/** Plugins and skills are not brands, so they get a quiet gray tile. */
export function LetterTile({ name, size = "sm" }: { name: string; size?: "sm" | "lg" }) {
  const letter = name.trim().charAt(0).toUpperCase() || "P";
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center bg-[var(--dls-hover)] font-medium text-[var(--dls-text-secondary)] ${size === "lg" ? "h-10 w-10 rounded-xl text-[16px]" : "h-8 w-8 rounded-lg text-[13px]"}`}
    >
      {letter}
    </span>
  );
}

export function KindTile({ kind }: { kind: "skill" | "command" }) {
  const Icon = kind === "skill" ? FileText : SquareTerminal;
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--dls-hover)] text-[var(--dls-text-secondary)]">
      <Icon className="h-4 w-4" strokeWidth={1.5} />
    </span>
  );
}
