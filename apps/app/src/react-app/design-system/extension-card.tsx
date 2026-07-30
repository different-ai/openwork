/** @jsxImportSource react */
import { AlertCircle, CheckCircle2, ChevronRight, Loader2 } from "lucide-react";
import type { EnablementResult } from "../../app/extensions";
import { t } from "../../i18n";
import {
  extensionTaxonomyLabel,
  type ExtensionTaxonomy,
} from "../domains/settings/extension-taxonomy";
import { resolveExtensionIconUrl } from "./extension-icon-src";
import { ExtensionMeshAvatar } from "./extension-mesh-avatar";

/** How the inventory is showing this extension: as a tile, or as a dense row. */
export type ExtensionLayout = "grid" | "list";

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
  /** Tile or dense row. Defaults to the tile. */
  layout?: ExtensionLayout;
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
  /** Secondary meta line under the description (e.g. "from Acme"). */
  meta?: string | null;
  /** Action label shown at bottom. */
  actionLabel?: string;
  /** Optional primary next-step label (signin/connect). */
  nextActionLabel?: string;
  /** Click handler for nextActionLabel; falls back to onClick. */
  onNextAction?: () => void;
  /** Click handler. */
  onClick?: () => void;
};

const taxonomyStyle: Record<ExtensionTaxonomy, string> = {
  app: "bg-teal-3 text-teal-11",
  connection: "bg-blue-3 text-blue-11",
  mcp: "bg-dls-hover text-dls-secondary",
  skill: "bg-amber-3 text-amber-11",
  plugin: "bg-violet-3 text-violet-11",
};

type ReadinessState = "ready" | "partial" | "none";

function readinessSurface(state: ReadinessState) {
  if (state === "ready") return "border-green-6 bg-green-2";
  if (state === "partial") return "border-amber-6 bg-amber-2";
  return "border-dls-border bg-dls-hover";
}

function ExtensionIcon(props: {
  name: string;
  taxonomy: ExtensionTaxonomy;
  iconSrc: string | null;
  connecting: boolean;
  readiness: ReadinessState;
  compact: boolean;
}) {
  const boxSize = props.compact ? "size-8" : "size-10";
  const avatarSize = props.compact ? "size-6" : "size-7";
  return (
    <div className="relative shrink-0">
      <div
        className={`flex ${boxSize} items-center justify-center rounded-lg border ${readinessSurface(props.readiness)}`}
      >
        {props.connecting ? (
          <Loader2 size={props.compact ? 15 : 18} className="animate-spin text-dls-secondary" />
        ) : props.iconSrc ? (
          <div className={`flex ${props.compact ? "size-5" : "size-6"} items-center justify-center rounded-md bg-white`}>
            <img src={props.iconSrc} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} />
          </div>
        ) : (
          <ExtensionMeshAvatar
            name={props.name}
            category={props.taxonomy}
            className={`${avatarSize} rounded-md shadow-inner`}
          />
        )}
      </div>
      {/* In the dense list, readiness lives as a dot next to the name instead of a corner overlay. */}
      {props.compact ? null : props.readiness === "ready" ? (
        <div className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-dls-surface bg-green-9">
          <CheckCircle2 size={9} className="text-white" strokeWidth={3} />
        </div>
      ) : props.readiness === "partial" ? (
        <div className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-dls-surface bg-amber-9">
          <AlertCircle size={9} className="text-white" strokeWidth={3} />
        </div>
      ) : null}
    </div>
  );
}

function ExtensionBadges(props: {
  readiness: ReadinessState;
  taxonomy: ExtensionTaxonomy;
  connectedLabel: string;
  hidden: boolean;
  preview: boolean;
  beta: boolean;
  disabledReason: string | null;
}) {
  return (
    <>
      {props.readiness === "ready" ? (
        <span className="shrink-0 rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">
          {props.connectedLabel}
        </span>
      ) : props.readiness === "partial" ? (
        <span className="shrink-0 rounded-md bg-amber-3 px-1.5 py-0.5 text-[10px] font-medium text-amber-11">
          Partially set up
        </span>
      ) : (
        <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${taxonomyStyle[props.taxonomy]}`}>
          {extensionTaxonomyLabel(props.taxonomy)}
        </span>
      )}
      {props.hidden ? (
        <span className="shrink-0 rounded-md bg-gray-3 px-1.5 py-0.5 text-[10px] font-medium text-gray-11">
          Hidden
        </span>
      ) : null}
      {props.preview ? (
        <span className="rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">
          Preview
        </span>
      ) : null}
      {props.beta ? (
        <span className="shrink-0 rounded-md bg-amber-3 px-1.5 py-0.5 text-[10px] font-medium text-amber-11">
          {t("common.beta")}
        </span>
      ) : null}
      {props.disabledReason ? (
        <span className="shrink-0 rounded-md bg-amber-3 px-1.5 py-0.5 text-[10px] font-medium text-amber-11">
          Disabled
        </span>
      ) : null}
    </>
  );
}

/**
 * A reusable card for displaying an extension (MCP server, plugin, or skill)
 * in the extensions directory. Supports brand icons from Simple Icons CDN,
 * favicon fallbacks, kind badges, and connected/connecting states.
 */
export function ExtensionCard(props: ExtensionCardProps) {
  const {
    name,
    description,
    iconSlug,
    iconSrc,
    url,
    taxonomy = "mcp",
    layout = "grid",
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
    actionLabel,
    nextActionLabel,
    onNextAction,
    onClick,
  } = props;

  // When enablement results are provided, derive connected + partial state from them.
  const allMet = enablement ? enablement.every((r) => r.met) : connectedProp;
  const someMet = enablement ? enablement.some((r) => r.met) && !allMet : false;
  const readiness: ReadinessState = allMet ? "ready" : someMet ? "partial" : "none";
  const resolvedIconSrc = resolveExtensionIconUrl({ iconSrc, iconSlug, serviceUrl: url }) ?? null;
  const shellState = readiness === "ready"
    ? "border-green-6 bg-green-2"
    : readiness === "partial"
      ? "border-amber-6 bg-amber-2"
      : "border-dls-border bg-dls-surface hover:bg-dls-hover";
  const shellClassName = `group w-full border text-left transition-all ${shellState} ${hidden ? "border-dashed opacity-70" : ""}`;
  const badges = (
    <ExtensionBadges
      readiness={readiness}
      taxonomy={taxonomy}
      connectedLabel={connectedLabel}
      hidden={hidden}
      preview={preview}
      beta={beta}
      disabledReason={disabledReason}
    />
  );
  const icon = (
    <ExtensionIcon
      name={name}
      taxonomy={taxonomy}
      iconSrc={resolvedIconSrc}
      connecting={connecting}
      readiness={readiness}
      compact={layout === "list"}
    />
  );
  const nextAction = !disabledReason && !connecting && nextActionLabel ? (
    <div
      className="text-[11px] font-medium text-dls-text transition-colors group-hover:opacity-80"
      onClick={(event) => {
        if (!onNextAction) return;
        event.stopPropagation();
        onNextAction();
      }}
    >
      {nextActionLabel}
    </div>
  ) : !disabledReason && !connecting && actionLabel ? (
    <div className="text-[11px] font-medium text-dls-text transition-colors group-hover:opacity-80">
      {actionLabel}
    </div>
  ) : null;

  if (layout === "list") {
    // Dense single-line row. Readiness is carried by the group header and a
    // small dot; the per-row badge only says what kind of extension this is.
    return (
      <button
        type="button"
        disabled={disabled || connecting}
        onClick={onClick}
        className={`group flex w-full items-center gap-3 px-3.5 py-2 text-left transition-colors hover:bg-dls-hover ${hidden ? "opacity-60" : ""}`}
      >
        {icon}
        <div className="flex w-44 shrink-0 items-center gap-1.5">
          <h4 className="min-w-0 truncate text-[13px] font-medium text-dls-text">{name}</h4>
          {readiness === "ready" ? (
            <span className="size-1.5 shrink-0 rounded-full bg-green-9" />
          ) : readiness === "partial" ? (
            <span className="size-1.5 shrink-0 rounded-full bg-amber-9" />
          ) : null}
        </div>
        <div className="flex w-20 shrink-0 items-center">
          <span className="rounded-md bg-dls-hover px-1.5 py-0.5 text-[10px] font-medium text-dls-secondary">
            {extensionTaxonomyLabel(taxonomy)}
          </span>
        </div>
        <p className="hidden min-w-0 flex-1 truncate text-xs text-dls-secondary sm:block">
          {disabledReason ?? description}
        </p>
        {preview ? (
          <span className="shrink-0 rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">
            Preview
          </span>
        ) : null}
        {beta ? (
          <span className="shrink-0 rounded-md bg-amber-3 px-1.5 py-0.5 text-[10px] font-medium text-amber-11">
            {t("common.beta")}
          </span>
        ) : null}
        {meta ? (
          <div className="hidden shrink-0 text-[11px] text-dls-secondary md:block">{meta}</div>
        ) : null}
        {!disabledReason && !connecting && nextActionLabel ? (
          <span
            className="inline-flex h-7 shrink-0 items-center rounded-lg border border-dls-border px-3 text-xs font-medium text-dls-text transition-colors group-hover:border-dls-secondary/40"
            onClick={(event) => {
              if (!onNextAction) return;
              event.stopPropagation();
              onNextAction();
            }}
          >
            {nextActionLabel}
          </span>
        ) : (
          <ChevronRight size={14} className="shrink-0 text-dls-secondary" />
        )}
      </button>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled || connecting}
      onClick={onClick}
      className={`${shellClassName} rounded-xl p-4`}
    >
      <div className="flex items-start gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="min-w-0 break-words text-sm font-semibold text-dls-text">{name}</h4>
            {badges}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-dls-secondary">{description}</p>
          {meta ? (
            <div className="mt-1 text-[11px] text-dls-secondary">{meta}</div>
          ) : null}
          {disabledReason ? (
            <div className="mt-2 text-[11px] font-medium text-amber-11">
              {disabledReason}
            </div>
          ) : null}
          {nextAction ? <div className="mt-2">{nextAction}</div> : null}
        </div>
      </div>
    </button>
  );
}
