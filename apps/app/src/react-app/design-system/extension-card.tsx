/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { Loader2, Lock } from "lucide-react";
import type { EnablementResult } from "../../app/extensions";
import { t } from "../../i18n";
import {
  extensionTaxonomyLabel,
  type ExtensionTaxonomy,
} from "../domains/settings/extension-taxonomy";
import { resolveExtensionIconUrl } from "./extension-icon-src";
import { ExtensionMeshAvatar } from "./extension-mesh-avatar";

/**
 * Column widths shared by every Library row and the column header above
 * them, so names, kinds, sources and actions form straight lanes. Short,
 * fixed columns come first and the long "What it does" text comes last and
 * takes the remaining width, so a wide window never opens a gap between a
 * row's name and its kind. Below `lg` a row reads Name · Kind · caption.
 */
export const libraryRowLanes = {
  name: "w-[150px] md:w-[190px] 2xl:w-[220px]",
  kind: "hidden w-[84px] sm:block",
  from: "min-w-0 flex-1 lg:w-[160px] lg:flex-none",
  description: "hidden min-w-0 flex-1 lg:block",
  action: "min-w-[96px]",
} as const;

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
  connectedLabel?: string;
  /** Per-condition enablement results. When provided, overrides `connected`. */
  enablement?: EnablementResult[];
  /** Whether a connect operation is in progress. */
  connecting?: boolean;
  /** Whether interaction is disabled. */
  disabled?: boolean;
  /** Whether this item is hidden from the normal catalog view. */
  hidden?: boolean;
  /** Whether this extension is still in preview. */
  preview?: boolean;
  /** Whether this extension is beta / untested. */
  beta?: boolean;
  /** Reason this item is visible but unavailable. */
  disabledReason?: string | null;
  /** Where the row came from, e.g. "From Acme". Shown in the From column. */
  meta?: string | null;
  /** Optional primary next-step label (signin/connect). */
  nextActionLabel?: string;
  /** Click handler for nextActionLabel; falls back to onClick. */
  onNextAction?: () => void;
  /** Click handler. */
  onClick?: () => void;
  /** A short state for assistive tech and filters; blocked states also show a lock chip. */
  statusChip?: { label: string; tone: "attention" | "setup" | "blocked" };
  /** A control after the row, outside its button, e.g. a ⋯ menu. */
  trailing?: ReactNode;
};

type ReadinessState = "ready" | "partial" | "none";

function ExtensionIcon(props: {
  name: string;
  taxonomy: ExtensionTaxonomy;
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
      ) : (
        <ExtensionMeshAvatar
          name={props.name}
          category={props.taxonomy}
          className="size-6 rounded-md shadow-inner"
        />
      )}
    </div>
  );
}

/** Skills and plugins are simply there once added; only things that reach another service show a live dot. */
function connectsToSomething(taxonomy: ExtensionTaxonomy) {
  return taxonomy === "connection" || taxonomy === "mcp" || taxonomy === "app";
}

/**
 * One Library row: logo tile, name with a ready dot, what it does (wide
 * screens), kind, where it came from, and one trailing action. Fixed lanes
 * from `libraryRowLanes` keep rows aligned with the column header.
 */
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
    preview = false,
    beta = false,
    disabledReason = null,
    meta = null,
    nextActionLabel,
    onNextAction,
    onClick,
  } = props;

  // When enablement results are provided, derive connected + partial state from them.
  const allMet = enablement ? enablement.every((r) => r.met) : connectedProp;
  const someMet = enablement ? enablement.some((r) => r.met) && !allMet : false;
  const readiness: ReadinessState = allMet ? "ready" : someMet ? "partial" : "none";
  const resolvedIconSrc = resolveExtensionIconUrl({ iconSrc, iconSlug, serviceUrl: url }) ?? null;
  const readyDot = readiness === "ready" && connectsToSomething(taxonomy) ? (
    <span data-library-ready role="img" aria-label={connectedLabel} className="size-1.5 shrink-0 rounded-full bg-green-9" />
  ) : readiness === "partial" ? (
    <span className="size-1.5 shrink-0 rounded-full bg-amber-9" />
  ) : null;
  // A specific connected state (such as limited access) must be visible at every width, not only the dot's accessible label.
  const connectedState = readiness === "ready" && connectedLabel !== "Connected" ? connectedLabel : null;
  const summary = disabledReason ?? connectedState ?? description;
  const caption = disabledReason ?? connectedState ?? meta ?? description;

  return (
    <div className={`group flex h-[52px] w-full items-center gap-3 ${hidden ? "opacity-60" : ""}`}>
      <button
        type="button"
        disabled={disabled || connecting}
        onClick={onClick}
        data-library-row={name}
        title={summary || undefined}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ExtensionIcon name={name} taxonomy={taxonomy} iconSrc={resolvedIconSrc} connecting={connecting} />
        <div className={`flex shrink-0 items-center gap-1.5 ${libraryRowLanes.name}`}>
          <h4 className="min-w-0 truncate text-[13px] font-medium text-dls-text group-hover:underline group-hover:decoration-dls-border group-hover:underline-offset-4">{name}</h4>
          {readyDot}
          {props.statusChip ? (
            props.statusChip.tone === "blocked" ? (
              <span data-library-status={props.statusChip.label} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-dls-hover px-1.5 py-0.5 text-[10px] font-medium text-dls-text">
                <Lock size={16} strokeWidth={1.5} aria-hidden />
                {props.statusChip.label}
              </span>
            ) : (
              <span data-library-status={props.statusChip.label} className="sr-only">{props.statusChip.label}</span>
            )
          ) : null}
          {preview ? <span className="shrink-0 rounded-md bg-dls-hover px-1.5 py-0.5 text-[11px] text-dls-secondary">Preview</span> : null}
          {beta ? <span className="shrink-0 rounded-md bg-dls-hover px-1.5 py-0.5 text-[11px] text-dls-secondary">{t("common.beta")}</span> : null}
        </div>
        <span data-library-kind className={`shrink-0 text-xs text-dls-secondary ${libraryRowLanes.kind}`}>{extensionTaxonomyLabel(taxonomy)}</span>
        {meta ? (
          <p data-library-caption className={`truncate text-xs text-dls-secondary ${libraryRowLanes.from}`}>
            <span className="lg:hidden">{caption}</span>
            <span className="hidden lg:inline">{meta}</span>
          </p>
        ) : (
          // Nothing to say about the source: narrow rows fall back to what it
          // does, wide rows keep the empty lane so the next column stays aligned.
          <p className={`truncate text-xs text-dls-secondary ${libraryRowLanes.from}`}>
            <span className="lg:hidden">{summary}</span>
          </p>
        )}
        <p data-library-description className={`truncate text-xs text-dls-secondary ${libraryRowLanes.description}`}>{summary}</p>
      </button>
      <div className={`flex shrink-0 items-center justify-end gap-1 ${libraryRowLanes.action}`}>
        {!disabledReason && !connecting && nextActionLabel ? (
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center rounded-lg px-3 text-xs text-dls-text shadow-[0_0_0_1px_var(--dls-border)] transition-colors hover:bg-dls-hover"
            onClick={() => (onNextAction ? onNextAction() : onClick?.())}
          >
            {nextActionLabel}
          </button>
        ) : null}
        {props.trailing}
      </div>
    </div>
  );
}
