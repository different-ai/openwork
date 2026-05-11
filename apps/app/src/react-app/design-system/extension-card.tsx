/** @jsxImportSource react */
import { CheckCircle2, Loader2, Plug2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ExtensionKind } from "../../app/constants";

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
  /** Whether a connect operation is in progress. */
  connecting?: boolean;
  /** Whether interaction is disabled. */
  disabled?: boolean;
  /** Action label shown at bottom. */
  actionLabel?: string;
  /** Click handler. */
  onClick?: () => void;
};

const kindLabel: Record<ExtensionKind, string> = {
  mcp: "MCP",
  plugin: "Plugin",
  skill: "Skill",
};

const kindStyle: Record<ExtensionKind, string> = {
  mcp: "bg-dls-hover text-dls-secondary",
  plugin: "bg-violet-3 text-violet-11",
  skill: "bg-amber-3 text-amber-11",
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
    fallbackIcon: FallbackIcon = Plug2,
    kind = "mcp",
    connected = false,
    connecting = false,
    disabled = false,
    actionLabel,
    onClick,
  } = props;

  return (
    <button
      type="button"
      disabled={disabled || connected || connecting}
      onClick={onClick}
      className={`group w-full rounded-xl border p-4 text-left transition-all ${
        connected
          ? "border-green-6 bg-green-2"
          : "border-dls-border bg-dls-surface hover:bg-dls-hover"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className={`flex size-10 shrink-0 items-center justify-center rounded-lg border ${
            connected ? "border-green-6 bg-green-3" : "border-dls-border bg-dls-hover"
          }`}
        >
          {connecting ? (
            <Loader2 size={18} className="animate-spin text-dls-secondary" />
          ) : connected ? (
            <CheckCircle2 size={18} className="text-green-11" />
          ) : iconSrc ? (
            <img src={iconSrc} alt="" width={18} height={18} loading="lazy" style={{ display: "block" }} />
          ) : iconSlug ? (
            <img src={`https://cdn.simpleicons.org/${iconSlug}`} alt="" width={18} height={18} loading="lazy" style={{ display: "block" }} />
          ) : (
            <FallbackIcon size={18} className="text-dls-secondary" />
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h4 className="text-sm font-semibold text-dls-text">{name}</h4>
            {connected ? (
              <span className="rounded-md bg-green-3 px-1.5 py-0.5 text-[10px] font-medium text-green-11">
                Connected
              </span>
            ) : (
              <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${kindStyle[kind]}`}>
                {kindLabel[kind]}
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-dls-secondary">{description}</p>
          {!connected && !connecting && actionLabel ? (
            <div className="mt-2 text-[11px] font-medium text-dls-accent transition-colors group-hover:opacity-80">
              {actionLabel}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}
