/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { ArrowRight, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

import type { EnablementResult } from "../../app/extensions";
import {
  extensionTaxonomyLabel,
  type ExtensionTaxonomy,
} from "../domains/settings/extension-taxonomy";
import { resolveExtensionIconUrl } from "./extension-icon-src";

export type ExtensionCardProps = {
  name: string;
  description: string;
  /** Simple Icons slug for brand icon. When set, loads from CDN. */
  iconSlug?: string;
  /** Direct icon URL (e.g. local SVG). Takes priority over iconSlug. */
  iconSrc?: string;
  /** Related service URL used for favicon fallback when no icon is configured. */
  url?: string;
  /** What this row is: a local app, an account connection, an MCP server, a skill, or a plugin. */
  taxonomy?: ExtensionTaxonomy;
  /** Whether the extension is already installed/connected. */
  connected?: boolean;
  /** Specific connected account state, including limited access. */
  connectedLabel?: string;
  /** Recorded server-check state, independent of whether an account is signed in. */
  stateLabel?: string;
  /** Per-condition enablement results. When provided, overrides `connected`. */
  enablement?: EnablementResult[];
  /** Whether a connect operation is in progress. */
  connecting?: boolean;
  /** Whether interaction is disabled. */
  disabled?: boolean;
  /** Whether this item is hidden from the normal catalog view. */
  hidden?: boolean;
  /** Reason this item is visible but unavailable. */
  disabledReason?: string | null;
  /** Optional primary next-step label (signin/connect). */
  nextActionLabel?: string;
  /** Click handler for nextActionLabel; falls back to onClick. */
  onNextAction?: () => void;
  /** Click handler. */
  onClick?: () => void;
  /** A short state for the status slot; blocked states also show a lock. */
  statusChip?: { label: string; tone: "attention" | "setup" | "blocked" };
  /** A control after the row, outside its button, e.g. a ⋯ menu. */
  trailing?: ReactNode;
};

type ReadinessState = "ready" | "partial" | "none";

function ExtensionIcon(props: {
  name: string;
  iconSrc: string | null;
  connecting: boolean;
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-dls-hover">
      {props.connecting ? (
        <Loader2 size={15} className="animate-spin text-dls-secondary" />
      ) : props.iconSrc && failedSrc !== props.iconSrc ? (
        <div className="flex size-5 items-center justify-center rounded-md bg-white">
          <img src={props.iconSrc} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} onError={() => setFailedSrc(props.iconSrc)} />
        </div>
      ) : <span aria-hidden className="text-[13px] font-medium text-muted-foreground">{props.name.trim().charAt(0).toUpperCase()}</span>}
    </div>
  );
}

/** One Library row: logo tile, name, what it does, its state, and one trailing action. */
export function ExtensionCard(props: ExtensionCardProps) {
  const {
    name,
    description,
    iconSlug,
    iconSrc,
    url,
    taxonomy = "mcp",
    connected: connectedProp = false,
    connectedLabel = "Connected",
    enablement,
    connecting = false,
    disabled = false,
    hidden = false,
    disabledReason = null,
    nextActionLabel,
    onNextAction,
    onClick,
  } = props;

  // When enablement results are provided, derive connected + partial state from them.
  const allMet = enablement ? enablement.every((r) => r.met) : connectedProp;
  const someMet = enablement ? enablement.some((r) => r.met) && !allMet : false;
  const readiness: ReadinessState = allMet ? "ready" : someMet ? "partial" : "none";
  const resolvedIconSrc = resolveExtensionIconUrl({ iconSrc, iconSlug, serviceUrl: url }) ?? null;
  // Specific account states must stay visible, not only in an accessible label.
  const connectedState = !props.stateLabel && readiness === "ready" && connectedLabel !== "Connected" ? connectedLabel : null;
  const summary = disabledReason ?? connectedState ?? description;
  const blocked = Boolean(disabledReason) || props.statusChip?.tone === "blocked";
  const state = blocked ? "Blocked" : hidden ? "Hidden" : props.stateLabel ?? props.statusChip?.label ?? connectedState ?? (readiness === "ready" ? "Ready" : "Set up");

  return (
    <div className="group flex h-[52px] w-full items-center gap-3" data-library-integrated-row>
      <button type="button" disabled={disabled || connecting} onClick={onClick} data-library-row={name} title={summary || undefined} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ExtensionIcon name={name} iconSrc={resolvedIconSrc} connecting={connecting} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-foreground">{name}</span>
          <span data-library-description className="truncate text-xs text-muted-foreground">{summary || extensionTaxonomyLabel(taxonomy)}</span>
        </span>
      </button>
      <span data-library-status title={state} className="w-28 shrink-0 text-right text-xs text-muted-foreground">
        <span className="line-clamp-2">{blocked ? <Lock className="mr-1 inline" size={16} strokeWidth={1.5} aria-hidden /> : null}{state}</span>
      </span>
      <span data-library-action className="flex min-w-[72px] shrink-0 items-center justify-end gap-1">
        {!blocked && !connecting && nextActionLabel ? <Button variant="outline" size="icon-sm" aria-label={nextActionLabel} onClick={() => (onNextAction ? onNextAction() : onClick?.())}><ArrowRight data-icon="inline-start" /></Button> : null}
        {props.trailing}
      </span>
    </div>
  );
}
