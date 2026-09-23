/** @jsxImportSource react */
import { CheckCircle2, ChevronLeft, ChevronRight, ExternalLink, Loader2, MessageCircle, Share2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollAreaViewport } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import {
  extensionTaxonomyLabel,
  type ExtensionTaxonomy,
} from "../domains/settings/extension-taxonomy";
import { MarkdownBlock } from "../domains/session/surface/markdown";
import { resolveExtensionIconUrl } from "./extension-icon-src";
import { ExtensionMeshAvatar } from "./extension-mesh-avatar";

export type ExtensionDetailModalProps = {
  open: boolean;
  onClose: () => void;
  name: string;
  description: string;
  iconSlug?: string;
  iconSrc?: string;
  taxonomy?: ExtensionTaxonomy;
  /** Show the local stdio wrapper setup used by the OpenWork UI MCP. */
  uiControl?: boolean;
  connected?: boolean;
  connectedLabel?: string;
  disconnectedLabel?: string;
  connecting?: boolean;
  /** Whether this item is hidden from the normal extensions catalog. */
  hidden?: boolean;
  /** Whether this extension is still in preview. */
  preview?: boolean;
  /** Whether this extension is beta / untested. */
  beta?: boolean;
  /** Reason this item is visible but unavailable. */
  disabledReason?: string | null;
  /** Actionable error from the most recent connection attempt. */
  errorInfo?: string | null;
  /** Remote URL if applicable. */
  url?: string;
  /** Declarative setup instructions from an extension manifest. */
  setupInstructions?: string;
  /** Declarative install resource labels from an extension manifest. */
  resourceLabels?: string[];
  /** Declarative UI/runtime contribution labels from an extension manifest. */
  contributionLabels?: string[];
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
  /** Trigger phrases shown as rows (commands, skills, agents). */
  triggers?: string[];
  triggerHint?: string;
  /** Caption under the title, e.g. a path or "Available in composer". */
  sourceLabel?: string;
  instructionsHint?: string;
  openFileLabel?: string;
  facts?: Array<{ label: string; value: string }>;
  /** Nested capabilities shown on plugin (and similar) detail pages. */
  contents?: Array<{ key: string; kindLabel: string; name: string; onOpen: () => void }>;
  contentsTitle?: string;
  contentsEmptyLabel?: string;
  /** Reveal the file in Finder/Explorer. */
  onReveal?: () => void;
  /** Skill content preview (first ~500 chars of the SKILL.md). */
  contentPreview?: string;
  /** Connect handler. */
  onConnect?: () => void;
  connectLabel?: string;
  onReconnect?: () => void;
  reconnectLabel?: string;
  connectingLabel?: string;
  /** Start a new chat with this item already in the composer. */
  onChat?: () => void;
  /** Open the share page. Only for things the member owns. */
  onShare?: () => void;
  /** Remove/disconnect handler. Shown when connected. */
  onUninstall?: () => void;
  uninstallLabel?: string;
  closeOnUninstall?: boolean;
  /** Hide from the normal catalog view. */
  onHide?: () => void;
  /** Show again in the normal catalog view. */
  onShow?: () => void;
  /** Extension-specific configuration UI rendered inside the modal body. */
  configSlot?: React.ReactNode;
  showEnablementCard?: boolean;
  size?: "default" | "wide";
  /** Dialog overlay (default) or dedicated settings page shell. */
  presentation?: "dialog" | "page";
  /** Back-link label when presentation is "page". */
  backLabel?: string;
};

const taxonomyDesc: Record<ExtensionTaxonomy, string> = {
  app: "Runs on this device and gives your agent tools it can use here.",
  connection: "An account your agent can act in, once it is signed in.",
  mcp: "Connects as a Model Context Protocol server, giving your agent access to external tools and data.",
  skill: "A reusable workflow that your agent can execute on demand.",
  command: "A slash command the composer can run in this workspace.",
  agent: "A named agent the composer can run a session as.",
  plugin: "Extends OpenWork with additional capabilities managed by your organization.",
  model: "A model provider and the models it gives you.",
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

  return text.trim();
}

export function ExtensionDetailModal({
  open,
  onClose,
  name,
  description,
  iconSlug,
  iconSrc,
  taxonomy = "mcp",
  uiControl = false,
  connected = false,
  connectedLabel,
  disconnectedLabel,
  connecting = false,
  hidden = false,
  preview = false,
  beta = false,
  disabledReason = null,
  errorInfo = null,
  url,
  setupInstructions,
  resourceLabels = [],
  contributionLabels = [],
  oauth,
  launchCommand,
  environment,
  path,
  trigger,
  triggers,
  triggerHint,
  sourceLabel,
  instructionsHint,
  openFileLabel,
  facts = [],
  contents,
  contentsTitle,
  contentsEmptyLabel,
  contentPreview,
  onReveal,
  onConnect,
  connectLabel = "Connect",
  onReconnect,
  reconnectLabel = "Reconnect",
  connectingLabel = "Connecting...",
  onChat,
  onShare,
  onUninstall,
  uninstallLabel,
  closeOnUninstall = true,
  onHide,
  onShow,
  configSlot,
  showEnablementCard = true,
  size = "default",
  presentation = "dialog",
  backLabel = "Library",
}: ExtensionDetailModalProps) {
  "use memo";
  const resolvedIconSrc = resolveExtensionIconUrl({ iconSrc, iconSlug, serviceUrl: url });

  if (!open) return null;

  const composerCapability = taxonomy === "skill" || taxonomy === "command" || taxonomy === "agent";
  const triggerRows = (triggers && triggers.length > 0)
    ? triggers
    : trigger
      ? [trigger]
      : [];
  const instructionBody = contentPreview ? stripSkillFrontmatter(contentPreview) : "";

  const taxonomyPills = (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        {extensionTaxonomyLabel(taxonomy)}
      </span>
      {connected ? (
        <span className="flex items-center gap-1 rounded-md bg-green-3 px-2 py-0.5 text-[10px] font-medium text-green-11">
          <CheckCircle2 size={10} strokeWidth={3} />
          {t("extensions.detail_ready")}
        </span>
      ) : null}
      {preview ? (
        <span className="rounded-md bg-blue-3 px-1.5 py-0.5 text-[10px] font-medium text-blue-11">
          Preview
        </span>
      ) : null}
      {beta ? (
        <span className="rounded-md bg-amber-3 px-1.5 py-0.5 text-[10px] font-medium text-amber-11">
          Beta
        </span>
      ) : null}
    </div>
  );

  const header = (
    <div className="flex min-w-0 items-start gap-4">
      <div className="relative shrink-0">
        <div
          className={cn(
            "flex size-12 items-center justify-center rounded-xl border",
            connected ? "border-green-6 bg-green-2" : "border-dls-border bg-dls-hover",
          )}
        >
          {resolvedIconSrc ? (
            <div className="flex size-8 items-center justify-center rounded-md bg-white">
              <img src={resolvedIconSrc} alt="" width={20} height={20} loading="lazy" style={{ display: "block" }} />
            </div>
          ) : (
            <ExtensionMeshAvatar
              name={name}
              category={taxonomy}
              className="size-9 rounded-lg shadow-inner"
            />
          )}
        </div>
        {connected ? (
          <div className="absolute -bottom-0.5 -right-0.5 flex size-5 items-center justify-center rounded-full border-2 border-dls-surface bg-green-9">
            <CheckCircle2 size={11} className="text-white" strokeWidth={3} />
          </div>
        ) : null}
      </div>

      <div className="min-w-0 flex flex-1 flex-col gap-1 justify-center self-stretch">
        {presentation === "page" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold leading-none tracking-tight text-foreground">{name}</h2>
              {taxonomyPills}
            </div>
            <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
            {sourceLabel ? (
              <p className="text-xs text-muted-foreground">{sourceLabel}</p>
            ) : null}
          </>
        ) : (
          <>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-2">
              {taxonomyPills}
            </DialogDescription>
          </>
        )}
      </div>
      {onShare || onChat ? (
        <div className="flex shrink-0 items-center gap-2">
          {onShare ? (
            <Button variant="outline" size="sm" onClick={onShare}>
              <Share2 data-icon="inline-start" />
              {t("extensions.detail_share")}
            </Button>
          ) : null}
          {onChat ? (
            <Button size="sm" onClick={onChat}>
              <MessageCircle data-icon="inline-start" />
              {t("extensions.detail_chat")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const body = (
    <div className="space-y-5 px-px">
      {presentation !== "page" ? (
        <div className="text-sm leading-relaxed text-card-foreground">
          {description}
        </div>
      ) : null}
      {composerCapability && presentation !== "page" && sourceLabel ? (
        <p className="text-xs text-muted-foreground">{sourceLabel}</p>
      ) : null}

      {errorInfo ? (
        <div role="alert" className="rounded-lg border border-red-6 bg-red-2 px-3 py-2 text-sm text-red-11">
          {errorInfo}
        </div>
      ) : null}

      {setupInstructions ? (
        <Card variant="outline" size="sm">
          <CardHeader>
            <CardTitle>Setup</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm leading-relaxed text-muted-foreground">
              {setupInstructions}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {resourceLabels.length > 0 || contributionLabels.length > 0 ? (
        <Card variant="outline" size="sm">
          <CardHeader>
            <CardTitle>Extension manifest</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              {resourceLabels.length > 0 ? (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Resources</div>
                  <div className="flex flex-wrap gap-1.5">
                    {resourceLabels.map((label) => (
                      <span key={label} className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">{label}</span>
                    ))}
                  </div>
                </div>
              ) : null}
              {contributionLabels.length > 0 ? (
                <div>
                  <div className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Contributions</div>
                  <div className="flex flex-wrap gap-1.5">
                    {contributionLabels.map((label) => (
                      <span key={label} className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">{label}</span>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {composerCapability && triggerRows.length > 0 ? (
        <Card variant="outline" size="sm" className="overflow-hidden py-0">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="text-sm font-semibold text-card-foreground">{t("extensions.detail_triggers")}</div>
            {triggerHint ? (
              <div className="text-xs text-muted-foreground">{triggerHint}</div>
            ) : null}
          </div>
          <div>
            {triggerRows.map((row, index) => (
              <div
                key={`${row}:${index}`}
                className={cn(
                  "px-4 py-2.5 text-[13px] leading-5 text-muted-foreground",
                  index < triggerRows.length - 1 ? "border-b border-border" : "",
                )}
              >
                {row}
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {composerCapability && facts.length > 0 ? (
        <Card variant="outline" size="sm">
          <CardHeader>
            <CardTitle>{t("extensions.detail_how_it_runs")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {facts.map((fact) => (
                <div key={fact.label} className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">{fact.label}</span>
                  <span className="truncate font-medium text-card-foreground">{fact.value}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {composerCapability && instructionBody ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-[0.1em] text-muted-foreground">
              {t("extensions.detail_instructions")}
            </div>
            {instructionsHint ? (
              <div className="text-xs text-muted-foreground">{instructionsHint}</div>
            ) : null}
          </div>
          <div className="max-h-[320px] overflow-y-auto rounded-xl border border-border bg-card p-4 text-sm leading-relaxed text-card-foreground">
            <MarkdownBlock text={instructionBody} />
          </div>
          {onReveal ? (
            <Button variant="link" size="xs" className="h-auto w-fit px-0" onClick={onReveal}>
              {openFileLabel ?? t("extensions.detail_open_file")}
              <ExternalLink data-icon="inline-end" />
            </Button>
          ) : null}
        </div>
      ) : null}

      {!composerCapability ? (
        <Card variant="outline" size="sm">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Type</span>
                <span className="font-medium text-card-foreground">{extensionTaxonomyLabel(taxonomy)}</span>
              </div>

              {url ? (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Endpoint</span>
                  <span className="flex items-center gap-1.5 truncate font-mono text-xs text-card-foreground">
                    {url.replace(/^https?:\/\//, "").slice(0, 40)}
                    <ExternalLink size={10} className="shrink-0 text-muted-foreground" />
                  </span>
                </div>
              ) : null}

              {uiControl ? (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Launch</span>
                  <span className="max-w-[300px] truncate font-mono text-xs text-card-foreground">{(launchCommand ?? fallbackUiControlCommand).join(" ")}</span>
                </div>
              ) : null}

              {path && onReveal ? (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Location</span>
                  <Button
                    variant="link"
                    size="xs"
                    onClick={onReveal}
                  >
                    Reveal in Finder
                    <ExternalLink data-icon="inline-end" />
                  </Button>
                </div>
              ) : null}

              {oauth ? (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Authentication</span>
                  <span className="font-medium text-card-foreground">OAuth required</span>
                </div>
              ) : null}

              {facts.map((fact) => (
                <div key={fact.label} className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">{fact.label}</span>
                  <span className="truncate font-medium text-card-foreground">{fact.value}</span>
                </div>
              ))}

              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <span className={cn("font-medium", connected ? "text-green-11" : "text-muted-foreground")}>
                  {connected
                    ? connectedLabel ?? (taxonomy === "plugin" ? "Installed" : "Connected")
                    : connecting
                      ? connectingLabel
                      : disconnectedLabel ?? (taxonomy === "plugin" ? "Not installed" : "Not connected")}
                </span>
              </div>

              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Visibility</span>
                <span className="font-medium text-card-foreground">{hidden ? "Hidden" : "Shown"}</span>
              </div>

              {preview ? (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Release stage</span>
                  <span className="font-medium text-blue-11">Preview</span>
                </div>
              ) : null}

              {beta ? (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Release stage</span>
                  <span className="font-medium text-amber-11">Beta</span>
                </div>
              ) : null}

              {disabledReason ? (
                <div className="flex items-center justify-between gap-4 text-sm">
                  <span className="text-muted-foreground">Availability</span>
                  <span className="text-right font-medium text-amber-11">{disabledReason}</span>
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {contents ? (
        <Card variant="outline" size="sm" className="overflow-hidden py-0">
          <div className="border-b border-border px-4 py-3">
            <div className="text-sm font-semibold text-card-foreground">
              {contentsTitle ?? t("extensions.detail_contents")}
            </div>
          </div>
          {contents.length === 0 ? (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              {contentsEmptyLabel ?? t("extensions.detail_contents_empty")}
            </p>
          ) : (
            <div>
              {contents.map((item, index) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={item.onOpen}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/60",
                    index < contents.length - 1 ? "border-b border-border" : "",
                  )}
                >
                  <span className="w-20 shrink-0 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                    {item.kindLabel}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-card-foreground">{item.name}</span>
                  <ChevronRight size={14} className="shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </Card>
      ) : null}

      {uiControl ? <UiControlConnectionDetails launchCommand={launchCommand} environment={environment} /> : null}

      {showEnablementCard && !composerCapability && !uiControl ? (
        <Card variant="outline" size="sm">
          <CardHeader>
            <CardTitle>What this enables</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm leading-relaxed text-muted-foreground">
              {taxonomyDesc[taxonomy]}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {configSlot}
    </div>
  );

  const footerActions = (
    <>
      <div className="flex flex-wrap gap-2">
        {hidden && onShow ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onShow();
              onClose();
            }}
          >
            Show
          </Button>
        ) : !hidden && onHide ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onHide();
              onClose();
            }}
          >
            Hide
          </Button>
        ) : null}
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {presentation === "dialog" ? (
          <DialogClose render={<Button variant="outline" />}>
            Close
          </DialogClose>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )}
        {connected && onReconnect ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onReconnect}
            disabled={connecting}
          >
            {connecting ? (
              <>
                <Loader2 data-icon="inline-start" className="animate-spin" />
                {connectingLabel}
              </>
            ) : (
              reconnectLabel
            )}
          </Button>
        ) : null}
        {connected && onUninstall ? (
          <Button
            variant="destructive"
            size="sm"
            disabled={connecting}
            onClick={() => {
              onUninstall();
              if (closeOnUninstall) onClose();
            }}
          >
            {uninstallLabel ?? (taxonomy === "connection" || taxonomy === "mcp" ? t("extensions.detail_disconnect") : t("extensions.detail_remove"))}
          </Button>
        ) : null}
        {!connected && onConnect ? (
          <Button
            onClick={onConnect}
            disabled={connecting}
          >
            {connecting ? (
              <>
                <Loader2 data-icon="inline-start" className="animate-spin" />
                {connectingLabel}
              </>
            ) : (
              connectLabel
            )}
          </Button>
        ) : null}
      </div>
    </>
  );

  if (presentation === "page") {
    return (
      <div data-extension-detail-page className="mx-auto flex w-full max-w-3xl flex-col gap-6 animate-in fade-in duration-300">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 w-fit gap-1 px-2 text-muted-foreground"
          onClick={onClose}
        >
          <ChevronLeft size={16} />
          {backLabel}
        </Button>
        {composerCapability ? (
          <div className="rounded-xl border border-border bg-card p-5">
            {header}
          </div>
        ) : (
          header
        )}
        <div className="min-h-0 flex-1">
          {body}
        </div>
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {footerActions}
        </div>
      </div>
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className={cn(
          "flex max-h-[90vh] min-h-0 w-full flex-col overflow-hidden",
          size === "wide" ? "max-w-3xl sm:max-w-3xl" : "max-w-xl sm:max-w-xl",
        )}
      >
        <DialogHeader>
          {header}
        </DialogHeader>

        <ScrollArea className="flex min-h-0 flex-1 flex-col">
          <ScrollAreaViewport className="min-h-0 flex-1 h-auto!">
            {body}
          </ScrollAreaViewport>
        </ScrollArea>

        <DialogFooter className="shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {footerActions}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface UiControlConnectionDetailsProps {
  launchCommand?: string[];
  environment?: Record<string, string>;
}

function UiControlConnectionDetails(props: UiControlConnectionDetailsProps) {
  "use memo";

  const opencodeConfig = props.launchCommand ? uiControlOpencodeConfig(props.launchCommand, props.environment) : fallbackUiControlOpencodeConfig;

  return (
    <div className="space-y-4">
      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>How to connect another client</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
            <div>OpenWork desktop starts a private localhost bridge automatically.</div>
            <div>Your MCP client starts <span className="font-mono text-card-foreground">openwork-ui-mcp</span> over stdio; the wrapper discovers the bridge and proxies UI tools to it.</div>
            <div>Do not point clients at the random localhost bridge URL directly.</div>
          </div>
        </CardContent>
      </Card>

      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>Claude Desktop, Codex, Cursor</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[180px] overflow-x-auto rounded-xl border border-border p-3 text-xs leading-relaxed text-card-foreground">
            <code>{uiControlClientConfig}</code>
          </pre>
        </CardContent>
      </Card>

      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>OpenCode</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[180px] overflow-x-auto rounded-xl border border-border p-3 text-xs leading-relaxed text-card-foreground">
            <code>{opencodeConfig}</code>
          </pre>
        </CardContent>
      </Card>

      <Card variant="outline" size="sm">
        <CardHeader>
          <CardTitle>Discovery</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="relative overflow-hidden rounded-xl bg-clip-padding before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-xl)-1px)] before:border before:border-border">
            <Table className="text-xs">
              <TableBody>
                <TableRow className="*:border-border hover:bg-transparent [&>:not(:last-child)]:border-r">
                  <TableCell className="bg-muted/50 w-40 py-2 text-xs font-medium">
                    Production discovery file
                  </TableCell>
                  <TableCell className="py-2 whitespace-normal">
                    <span className="font-mono text-xs break-all">~/Library/Application Support/com.differentai.openwork/openwork-ui-control.json</span>
                  </TableCell>
                </TableRow>
                <TableRow className="*:border-border hover:bg-transparent [&>:not(:last-child)]:border-r">
                  <TableCell className="bg-muted/50 py-2 text-xs font-medium">
                    Dev discovery file
                  </TableCell>
                  <TableCell className="py-2 whitespace-normal">
                    <span className="font-mono text-xs break-all">~/Library/Application Support/com.differentai.openwork.dev/openwork-ui-control.json</span>
                  </TableCell>
                </TableRow>
                <TableRow className="*:border-border hover:bg-transparent [&>:not(:last-child)]:border-r">
                  <TableCell className="bg-muted/50 py-2 text-xs font-medium">
                    Override
                  </TableCell>
                  <TableCell className="py-2 whitespace-normal">
                    <span className="font-mono text-xs break-all">OPENWORK_UI_CONTROL_DISCOVERY=/path/to/openwork-ui-control.json</span>
                  </TableCell>
                </TableRow>
                {props.environment?.OPENWORK_UI_CONTROL_DISCOVERY ? (
                  <TableRow className="*:border-border hover:bg-transparent [&>:not(:last-child)]:border-r">
                    <TableCell className="bg-muted/50 py-2 text-xs font-medium">
                      Current override
                    </TableCell>
                    <TableCell className="py-2 whitespace-normal">
                      <span className="font-mono text-xs break-all">{props.environment.OPENWORK_UI_CONTROL_DISCOVERY}</span>
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
