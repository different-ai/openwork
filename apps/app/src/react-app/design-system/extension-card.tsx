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
  "ui-control": "UI Control",
};

const kindStyle: Record<ExtensionKind, string> = {
  mcp: "bg-dls-hover text-dls-secondary",
  plugin: "bg-violet-3 text-violet-11",
  skill: "bg-amber-3 text-amber-11",
  "ui-control": "bg-blue-3 text-blue-11",
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
      disabled={disabled || connecting}
      onClick={onClick}
      className={`group w-full rounded-xl border p-4 text-left transition-all ${
        connected
          ? "border-green-6 bg-green-2"
          : "border-dls-border bg-dls-surface hover:bg-dls-hover"
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="relative shrink-0">
          <div
            className={`flex size-10 items-center justify-center rounded-lg border ${
              connected ? "border-green-6 bg-green-2" : "border-dls-border bg-dls-hover"
            }`}
          >
            {connecting ? (
              <Loader2 size={18} className="animate-spin text-dls-secondary" />
            ) : iconSrc ? (
              <div className="flex size-6 items-center justify-center rounded-md bg-white">
                <img src={iconSrc} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} />
              </div>
            ) : iconSlug ? (
              <div className="flex size-6 items-center justify-center rounded-md bg-white">
                <img src={`https://cdn.simpleicons.org/${iconSlug}`} alt="" width={16} height={16} loading="lazy" style={{ display: "block" }} />
              </div>
            ) : (
              <FallbackIcon size={18} className="text-dls-secondary" />
            )}
          </div>
          {connected ? (
            <div className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full border-2 border-dls-surface bg-green-9">
              <CheckCircle2 size={9} className="text-white" strokeWidth={3} />
            </div>
          ) : null}
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
            <div className="mt-2 text-[11px] font-medium text-dls-text transition-colors group-hover:opacity-80">
              {actionLabel}
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}
