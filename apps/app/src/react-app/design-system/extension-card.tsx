/** @jsxImportSource react */
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ExtensionKind } from "../../app/constants";
import type { EnablementResult } from "../../app/extensions";
import { resolveExtensionIconSrc } from "./extension-icon-src";
import { ExtensionMeshAvatar } from "./extension-mesh-avatar";

export type ExtensionCardProps = {
  name: string;
  description: string;
  /** Simple Icons slug for brand icon. When set, loads from CDN. */
  iconSlug?: string;
  /** Direct icon URL (e.g. local SVG). Takes priority over iconSlug. */
  iconSrc?: string;
  /** Lucide icon fallback when no iconSlug or iconSrc is provided. */
  fallbackIcon?: LucideIcon;
  /** Extension category badge. */
  kind?: ExtensionKind;
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
  /** Reason this item is visible but unavailable. */
  disabledReason?: string | null;
  /** Action label shown at bottom. */
  actionLabel?: string;
  /** Click handler. */
  onClick?: () => void;
};

const kindLabel: Record<ExtensionKind, string> = {
  mcp: "MCP",
  plugin: "Plugin",
  skill: "Skill",
  "ui-control": "UI Control",
  extension: "OpenWork Extension",
};

const kindStyle: Record<ExtensionKind, string> = {
  mcp: "bg-dls-hover text-dls-secondary",
  plugin: "bg-violet-3 text-violet-11",
  skill: "bg-amber-3 text-amber-11",
  "ui-control": "bg-blue-3 text-blue-11",
  extension: "bg-teal-3 text-teal-11",
};

/**
 * A reusable card for displaying an extension (MCP server, plugin, or skill)
 * in the extensions directory. Supports brand icons from Simple Icons CDN,
 * Lucide icon fallbacks, kind badges, and connected/connecting states.
 */
export function ExtensionCard(props: ExtensionCardProps) {
  const {
    name,
    description,
    iconSlug,
    iconSrc,
    kind = "mcp",
    connected: connectedProp = false,
    connectedLabel = "Connected",
    enablement,
    connecting = false,
    disabled = false,
    hidden = false,
    preview = false,
    disabledReason = null,
    actionLabel,
    onClick,
  } = props;

  // When enablement results are provided, derive connected + partial state from them.
  const allMet = enablement ? enablement.every((r) => r.met) : connectedProp;
  const someMet = enablement ? enablement.some((r) => r.met) && !allMet : false;
  const connected = allMet;
  const resolvedIconSrc = iconSrc ? resolveExtensionIconSrc(iconSrc) : undefined;

  return (
    <button
      type="button"
      disabled={disabled || connecting}
      onClick={onClick}
      className={`group w-full rounded-xl border p-4 text-left transition-all ${
        connected
          ? "border-green-6 bg-green-2"
          : someMet
          ? "border-amber-6 bg-amber-2"
          : "border-dls-border bg-dls-surface hover:bg-dls-hover"
      } ${hidden ? "border-dashed opacity-70" : ""}`}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="relative shrink-0">
          <div
            className={`flex size-10 items-center justify-center rounded-lg border ${
              connected ? "border-green-6 bg-green-2" : someMet ? "border-amber-6 bg-amber-2" : "border-dls-border bg-dls-hover"
            }`}
          >
            {connecting ? (
              <Loader2 size={18} className="animate-spin text-dls-secondary" />
            ) : resolvedIconSrc ? (
              <div className="flex size-6 items-center justify-center rounded-md bg-white">
                <img src={resolvedIconSrc} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} />
              </div>
            ) : iconSlug ? (
              <div className="flex size-6 items-center justify-center rounded-md bg-white">
                <img src={`https://cdn.simpleicons.org/${iconSlug}`} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} />
              </div>
            ) : (
              <ExtensionMeshAvatar
                name={name}
                category={kind}
                className="size-7 rounded-md shadow-inner"
              />
            )}
          </div>
          {connected ? (
            <div className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-dls-surface bg-green-9">
              <CheckCircle2 size={9} className="text-white" strokeWidth={3} />
            </div>
          ) : someMet ? (
            <div className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-dls-surface bg-amber-9">
              <AlertCircle size={9} className="text-white" strokeWidth={3} />
            </div>
          ) : null}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h4 className="min-w-0 break-words text-sm font-semibold text-dls-text">{name}</h4>
            {connected ? (
              <span className="shrink-0 rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">
                {connectedLabel}
              </span>
            ) : someMet ? (
              <span className="shrink-0 rounded-md bg-amber-3 px-1.5 py-0.5 text-[10px] font-medium text-amber-11">
                Partially set up
              </span>
            ) : (
              <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${kindStyle[kind]}`}>
                {kindLabel[kind]}
              </span>
            )}
            {hidden ? (
              <span className="shrink-0 rounded-md bg-gray-3 px-1.5 py-0.5 text-[10px] font-medium text-gray-11">
                Hidden
              </span>
            ) : null}
            {preview ? (
              <span className="rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">
                Preview
              </span>
            ) : null}
            {disabledReason ? (
              <span className="shrink-0 rounded-md bg-amber-3 px-1.5 py-0.5 text-[10px] font-medium text-amber-11">
                Disabled
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-dls-secondary">{description}</p>
          {disabledReason ? (
            <div className="mt-2 text-[11px] font-medium text-amber-11">
              {disabledReason}
            </div>
          ) : null}
          {!disabledReason && !connecting && actionLabel ? (
            <div className="mt-2 text-[11px] font-medium text-dls-text transition-colors group-hover:opacity-80">
              {actionLabel}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}
