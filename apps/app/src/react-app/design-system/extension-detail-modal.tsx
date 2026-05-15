/** @jsxImportSource react */
import { CheckCircle2, ExternalLink, Loader2, Plug2, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ExtensionKind } from "../../app/constants";
import { MarkdownBlock } from "../domains/session/surface/markdown";
import {
  modalOverlayClass,
  modalShellClass,
  modalHeaderClass,
  modalHeaderButtonClass,
  modalTitleClass,
  modalSubtitleClass,
  modalBodyClass,
  modalFooterClass,
  pillPrimaryClass,
  pillGhostClass,
  surfaceCardClass,
} from "../domains/workspace/modal-styles";

export type ExtensionDetailModalProps = {
  open: boolean;
  onClose: () => void;
  name: string;
  description: string;
  iconSlug?: string;
  iconSrc?: string;
  fallbackIcon?: LucideIcon;
  kind?: ExtensionKind;
  connected?: boolean;
  connecting?: boolean;
  /** Remote URL if applicable. */
  url?: string;
  /** Whether OAuth is required. */
  oauth?: boolean;
  /** Exact local command this extension will launch, when known. */
  launchCommand?: string[];
  /** Environment passed to the local MCP process, when known. */
  environment?: Record<string, string>;
  /** Filesystem path (for skills). Not shown directly, used for reveal. */
  path?: string;
  /** Skill trigger phrase (e.g. "when user asks to create an agent"). */
  trigger?: string;
  /** Reveal the file in Finder/Explorer. */
  onReveal?: () => void;
  /** Skill content preview (first ~500 chars of the SKILL.md). */
  contentPreview?: string;
  /** Connect handler. */
  onConnect?: () => void;
  /** Uninstall/disconnect handler. Shown when connected. */
  onUninstall?: () => void;
};

const kindLabel: Record<ExtensionKind, string> = {
  mcp: "MCP Server",
  plugin: "Plugin",
  skill: "Skill",
  "ui-control": "UI Control",
};

const kindDesc: Record<ExtensionKind, string> = {
  mcp: "Connects as a Model Context Protocol server, giving your agent access to external tools and data.",
  plugin: "Extends OpenWork with additional capabilities managed by your organization.",
  skill: "A reusable workflow that your agent can execute on demand.",
  "ui-control": "Lets another MCP client inspect and drive this OpenWork desktop UI through a local stdio wrapper.",
};

const uiControlClientConfig = `{
  "mcpServers": {
    "openwork-ui": {
      "command": "npx",
      "args": ["-y", "openwork-ui-mcp"]
    }
  }
}`;

function uiControlOpencodeConfig(command: string[], environment?: Record<string, string>) {
  return JSON.stringify({
    mcp: {
      "openwork-ui": {
        type: "local",
        command,
        ...(environment ? { environment } : {}),
        enabled: true,
      },
    },
  }, null, 2);
}

const fallbackUiControlCommand = ["npx", "-y", "openwork-ui-mcp"];

const fallbackUiControlOpencodeConfig = `{
  "mcp": {
    "openwork-ui": {
      "type": "local",
      "command": ["npx", "-y", "openwork-ui-mcp"],
      "enabled": true
    }
  }
}`;

/**
 * Strip YAML-like frontmatter from the beginning of a skill content string.
 * Handles both `---` delimited blocks and bare `key: value` lines at the top.
 */
function stripSkillFrontmatter(content: string): string {
  let text = content;

  // Handle --- delimited frontmatter block
  const fencedMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fencedMatch) {
    text = text.slice(fencedMatch[0].length);
  } else {
    // Handle bare key: value lines at the top
    const lines = text.split("\n");
    let startIndex = 0;

    // Skip leading blank lines
    while (startIndex < lines.length && !lines[startIndex].trim()) {
      startIndex++;
    }

    // Skip any key: value lines (common frontmatter keys)
    while (startIndex < lines.length) {
      const line = lines[startIndex].trim();
      if (/^[a-zA-Z_-]+\s*:/.test(line) && !line.startsWith("#")) {
        startIndex++;
      } else {
        break;
      }
    }

    if (startIndex > 0) {
      text = lines.slice(startIndex).join("\n");
    }
  }

  // Trim leading blank lines
  return text.replace(/^\s*\n/, "");
}

export function ExtensionDetailModal(props: ExtensionDetailModalProps) {
  const {
    open,
    onClose,
    name,
    description,
    iconSlug,
    iconSrc,
    fallbackIcon: FallbackIcon = Plug2,
    kind = "mcp",
    connected = false,
    connecting = false,
    url,
    oauth,
    launchCommand,
    environment,
    path,
    trigger,
    contentPreview,
    onReveal,
    onConnect,
    onUninstall,
  } = props;

  if (!open) return null;

  return (
    <div className={modalOverlayClass} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className={`${modalShellClass} max-w-[520px]`}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className={modalHeaderClass}>
          <div className="flex min-w-0 items-start gap-4">
            {/* Icon */}
            <div className="relative shrink-0">
              <div
                className={`flex size-12 items-center justify-center rounded-xl border ${
                  connected ? "border-green-6 bg-green-2" : "border-dls-border bg-dls-hover"
                }`}
              >
                {iconSrc ? (
                  <div className="flex size-8 items-center justify-center rounded-md bg-white">
                    <img src={iconSrc} alt="" width={20} height={20} loading="lazy" style={{ display: "block" }} />
                  </div>
                ) : iconSlug ? (
                  <div className="flex size-8 items-center justify-center rounded-md bg-white">
                    <img src={`https://cdn.simpleicons.org/${iconSlug}`} alt="" width={20} height={20} loading="lazy" style={{ display: "block" }} />
                  </div>
                ) : (
                  <FallbackIcon size={24} className="text-dls-secondary" />
                )}
              </div>
              {connected ? (
                <div className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border-2 border-dls-surface bg-green-9">
                  <CheckCircle2 size={11} className="text-white" strokeWidth={3} />
                </div>
              ) : null}
            </div>

            <div className="min-w-0">
              <h3 className={modalTitleClass}>{name}</h3>
              <p className={modalSubtitleClass}>{kindLabel[kind]}</p>
            </div>
          </div>

          <button type="button" onClick={onClose} className={modalHeaderButtonClass} aria-label="Close">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className={modalBodyClass}>
          <div className="space-y-5">
            {/* Description */}
            <div className="text-[14px] leading-relaxed text-dls-text">
              {description}
            </div>

            {/* Details */}
            <div className={`${surfaceCardClass} space-y-3 p-4`}>
              <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
                Details
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-dls-secondary">Type</span>
                  <span className="font-medium text-dls-text">{kindLabel[kind]}</span>
                </div>

                {url ? (
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-dls-secondary">Endpoint</span>
                    <span className="flex items-center gap-1.5 truncate font-mono text-[11px] text-dls-text">
                      {url.replace(/^https?:\/\//, "").slice(0, 40)}
                      <ExternalLink size={10} className="shrink-0 text-dls-secondary" />
                    </span>
                  </div>
                ) : null}

                {kind === "ui-control" ? (
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-dls-secondary">Launch</span>
                    <span className="max-w-[300px] truncate font-mono text-[11px] text-dls-text">{(launchCommand ?? fallbackUiControlCommand).join(" ")}</span>
                  </div>
                ) : null}

                {path && onReveal ? (
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-dls-secondary">Location</span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 font-medium text-dls-text transition-colors hover:text-dls-accent"
                      onClick={onReveal}
                    >
                      Reveal in Finder
                      <ExternalLink size={10} />
                    </button>
                  </div>
                ) : null}

                {oauth ? (
                  <div className="flex items-center justify-between text-[13px]">
                    <span className="text-dls-secondary">Authentication</span>
                    <span className="font-medium text-dls-text">OAuth required</span>
                  </div>
                ) : null}

                <div className="flex items-center justify-between text-[13px]">
                  <span className="text-dls-secondary">Status</span>
                  <span className={`font-medium ${connected ? "text-green-11" : "text-dls-secondary"}`}>
                    {kind === "skill"
                      ? (connected ? "Installed" : "Not installed")
                      : (connected ? "Connected" : connecting ? "Connecting..." : "Not connected")}
                  </span>
                </div>
              </div>
            </div>

            {/* Skill-specific: trigger + content preview */}
            {kind === "ui-control" ? <UiControlConnectionDetails launchCommand={launchCommand} environment={environment} /> : null}

            {kind === "skill" && trigger ? (
              <div className={`${surfaceCardClass} space-y-2 p-4`}>
                <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
                  Trigger
                </div>
                <div className="text-[13px] leading-relaxed text-dls-text">
                  {trigger}
                </div>
              </div>
            ) : null}

            {kind === "skill" && contentPreview ? (() => {
              const body = stripSkillFrontmatter(contentPreview);
              if (!body.trim()) return null;
              return (
                <div className="space-y-2">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
                    Skill content
                  </div>
                  <div className="max-h-[300px] overflow-y-auto rounded-xl border border-dls-border bg-dls-surface p-4 text-[13px] leading-relaxed text-dls-text">
                    <MarkdownBlock text={body} />
                  </div>
                </div>
              );
            })() : null}

            {/* What this enables (generic, for non-skills or skills without preview) */}
            {(kind !== "skill" && kind !== "ui-control") || (!trigger && !contentPreview && kind !== "ui-control") ? (
              <div className={`${surfaceCardClass} space-y-2 p-4`}>
                <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
                  What this enables
                </div>
                <div className="text-[13px] leading-relaxed text-dls-secondary">
                  {kindDesc[kind]}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div className={modalFooterClass}>
          <div className="flex justify-between">
            <div>
              {connected && onUninstall ? (
                <button
                  type="button"
                  className="inline-flex items-center justify-center gap-1.5 rounded-full border border-red-6 px-4 py-2 text-[13px] font-medium text-red-11 transition-colors hover:bg-red-3"
                  onClick={() => { onUninstall(); onClose(); }}
                >
                  {kind === "skill" ? "Uninstall" : "Disconnect"}
                </button>
              ) : null}
            </div>
            <div className="flex gap-3">
              <button type="button" className={pillGhostClass} onClick={onClose}>
                Close
              </button>
              {!connected && onConnect ? (
                <button
                  type="button"
                  className={pillPrimaryClass}
                  onClick={onConnect}
                  disabled={connecting}
                >
                  {connecting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    "Connect"
                  )}
                </button>
            ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function UiControlConnectionDetails(props: { launchCommand?: string[]; environment?: Record<string, string> }) {
  const opencodeConfig = props.launchCommand ? uiControlOpencodeConfig(props.launchCommand, props.environment) : fallbackUiControlOpencodeConfig;

  return (
    <div className="space-y-4">
      <div className={`${surfaceCardClass} space-y-3 p-4`}>
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          How to connect another client
        </div>
        <div className="space-y-2 text-[13px] leading-relaxed text-dls-secondary">
          <div>OpenWork desktop starts a private localhost bridge automatically.</div>
          <div>Your MCP client starts <span className="font-mono text-dls-text">openwork-ui-mcp</span> over stdio; the wrapper discovers the bridge and proxies UI tools to it.</div>
          <div>Do not point clients at the random localhost bridge URL directly.</div>
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          Claude Desktop, Codex, Cursor
        </div>
        <pre className="max-h-[180px] overflow-x-auto rounded-xl border border-dls-border bg-dls-surface p-3 text-[11px] leading-relaxed text-dls-text">
          <code>{uiControlClientConfig}</code>
        </pre>
      </div>

      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-dls-secondary">
          OpenCode
        </div>
        <pre className="max-h-[180px] overflow-x-auto rounded-xl border border-dls-border bg-dls-surface p-3 text-[11px] leading-relaxed text-dls-text">
          <code>{opencodeConfig}</code>
        </pre>
      </div>

      <div className={`${surfaceCardClass} space-y-2 p-4 text-[12px] leading-relaxed text-dls-secondary`}>
        <div>Production discovery file: <span className="font-mono text-dls-text">~/Library/Application Support/com.differentai.openwork/openwork-ui-control.json</span></div>
        <div>Dev discovery file: <span className="font-mono text-dls-text">~/Library/Application Support/com.differentai.openwork.dev/openwork-ui-control.json</span></div>
        <div>Override: <span className="font-mono text-dls-text">OPENWORK_UI_CONTROL_DISCOVERY=/path/to/openwork-ui-control.json</span></div>
        {props.environment?.OPENWORK_UI_CONTROL_DISCOVERY ? (
          <div>Current override: <span className="font-mono text-dls-text">{props.environment.OPENWORK_UI_CONTROL_DISCOVERY}</span></div>
        ) : null}
      </div>
    </div>
  );
}
