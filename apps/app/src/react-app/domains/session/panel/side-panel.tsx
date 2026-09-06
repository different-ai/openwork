/** @jsxImportSource react */
import * as React from "react";
import {
  Blocks,
  ArrowLeft,
  ArrowRight,
  Globe,
  Loader2,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import { useDragControls } from "motion/react";

import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { PanelTab, PanelTabClose, PanelTabItem, PanelTabList } from "@/components/panel-tabs";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import { ArtifactIcon } from "../artifacts/artifact-icon";
import { AppArtifact } from "../../apps/app-artifact";
import { ArtifactPanel } from "../artifacts/artifact-panel";
import {
  type BrowserPanelTab,
  usePanelTabStore,
  type PanelTab as PanelTabEntry,
  useActivePanelTab,
  useSessionPanelState,
} from "./panel-tab-store";
import { useControlAction, type OpenworkControlAction } from "../../../shell/control/control-provider";
import type { OpenTarget } from "../artifacts/open-target";
import { useSidePanelTabs } from "./use-side-panel-tabs";
import { handlePanelEscape, PanelEmpty } from "./panel-empty";
import {
  computeBounds,
  getElectronBrowser,
  getNativeMenuPoint,
  hasNativeBrowserOccluder,
  sameBounds,
} from "./utils";
import { LoginSyncCard } from "../../browser-logins/login-sync-card";

type SidePanelProps = {
  sessionId: string;
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  onClose: () => void;
  onOpenExtensions?: () => void;
  onOpenVoice?: () => void;
};

// HMR can remount this module without unmounting BrowserPanelContent, leaving
// the native Electron browser overlay visible — hide it before the module reloads.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    getElectronBrowser()?.hide?.();
  });
}

const MARKDOWN_PRIMITIVE_ARTIFACT_CONTENT = `# Artifact Markdown Proof

The artifact preview keeps **outside-chat Markdown** readable with inline \`surface renderer\`, a fenced code block, and [OpenWork](https://openworklabs.com).

\`\`\`ts
const surface = "shared markdown primitive";
console.log(surface);
\`\`\`

\`\`\`mermaid
flowchart LR
  ArtifactStart[Artifact Mermaid Start] --> ArtifactFinish[Artifact Mermaid Finish]
\`\`\``;

const STANDALONE_MERMAID_ARTIFACT_CONTENT = `flowchart TD
  StandaloneStart[Standalone Mermaid] --> StandaloneFinish[Rendered artifact]`;

type SidePanelTabProps = {
  tab: PanelTabEntry;
  active: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tab: PanelTabEntry) => void;
};

function SidePanelTab({ tab, active, onSelect, onClose }: SidePanelTabProps) {
  const dragControls = useDragControls();
  const tabRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (active) {
      tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [active]);

  const showBrowserTabContextMenu = (point?: { clientX: number; clientY: number }) => {
    void getElectronBrowser()?.showTabContextMenu?.(
      tab.id,
      getNativeMenuPoint(tabRef.current, point),
    );
  };

  return (
    <PanelTabItem
      value={tab.id}
      id={tab.id}
      dragControls={tab.type === "browser" ? dragControls : undefined}
      onContextMenu={tab.type === "browser" ? (event: React.MouseEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        showBrowserTabContextMenu({ clientX: event.clientX, clientY: event.clientY });
      } : undefined}
    >
      <div ref={tabRef} className="relative">
        <PanelTab
          active={active}
          onClick={() => onSelect(tab.id)}
          onPointerDown={tab.type === "browser" ? (event) => {
            if (event.button !== 0) {
              return;
            }

            dragControls.start(event);
          } : undefined}
          onKeyDown={tab.type === "browser" ? (event: React.KeyboardEvent<HTMLButtonElement>) => {
            if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
              return;
            }

            event.preventDefault();
            showBrowserTabContextMenu();
          } : undefined}
          title={tab.label}
          aria-label={`Select tab: ${tab.label}`}
        >
          {tab.type === "browser" ? (
            tab.favicon ? (
              <img src={tab.favicon} alt="" className="size-3.5 shrink-0 rounded-[2px]" />
            ) : tab.status === "loading" ? (
              <Loader2 className="animate-spin" />
            ) : (
              <Globe />
            )
          ) : tab.type === "app" ? <Blocks /> : (
            <ArtifactIcon type={tab.preview} />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{tab.label}</span>
        </PanelTab>
        <PanelTabClose
          active={active}
          label={tab.label}
          onClose={() => onClose(tab)}
        />
      </div>
    </PanelTabItem>
  );
}

type BrowserPanelContentProps = {
  sessionId: string;
  tab: BrowserPanelTab;
  onClose: () => void;
};

function BrowserPanelContent({
  sessionId,
  tab,
  onClose,
}: BrowserPanelContentProps) {
  const isAvailable = Boolean(getElectronBrowser());
  const [urlInput, setUrlInput] = React.useState(tab.url);
  const urlFocusedRef = React.useRef(false);
  const contentRef = React.useRef<HTMLDivElement>(null);
  const urlInputRef = React.useRef<HTMLInputElement>(null);
  const shownRef = React.useRef(false);
  const boundsFrameRef = React.useRef<number | null>(null);
  const lastBoundsRef = React.useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  React.useEffect(() => {
    if (!urlFocusedRef.current) {
      setUrlInput(tab.url);
    }
  }, [tab.id, tab.url]);

  const navigate = React.useCallback(() => {
    void getElectronBrowser()?.navigate?.(urlInput);
  }, [urlInput]);

  const back = React.useCallback(() => {
    void getElectronBrowser()?.back?.();
  }, []);

  const forward = React.useCallback(() => {
    void getElectronBrowser()?.forward?.();
  }, []);

  const reload = React.useCallback(() => {
    void getElectronBrowser()?.reload?.();
  }, []);

  const handleUrlKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigate();
      urlInputRef.current?.blur();
    }
  }, [navigate]);

  React.useLayoutEffect(() => {
    const browser = getElectronBrowser();
    const content = contentRef.current;
    if (!browser || !content || !isAvailable) {
      return;
    }

    const bounds = computeBounds(content);
    if (bounds.width < 1 || bounds.height < 1) {
      return;
    }

    browser.setBounds?.(bounds);
    lastBoundsRef.current = bounds;
  });

  React.useLayoutEffect(() => {
    const browser = getElectronBrowser();
    const content = contentRef.current;

    if (!browser || !content || !isAvailable) {
      browser?.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;

      if (boundsFrameRef.current != null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }

      return;
    }

    let disposed = false;

    const resetNativeView = async () => {
      await browser.hide?.();

      if (disposed) {
        return;
      }

      shownRef.current = false;
      lastBoundsRef.current = null;
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    const syncBounds = () => {
      const bounds = computeBounds(content);

      if (bounds.width < 1 || bounds.height < 1 || hasNativeBrowserOccluder()) {
        if (shownRef.current) {
          browser.hide?.();
          shownRef.current = false;
          lastBoundsRef.current = null;
        }

        return;
      }

      if (!shownRef.current) {
        // Naming the conversation lets the native browser put that
        // conversation's tabs on screen and keep every other conversation's
        // tabs silently in the background.
        browser.show?.(bounds, sessionId);
        shownRef.current = true;
        lastBoundsRef.current = bounds;
        return;
      }

      if (!sameBounds(lastBoundsRef.current, bounds)) {
        browser.setBounds?.(bounds);
        lastBoundsRef.current = bounds;
      }
    };

    const watchBounds = () => {
      syncBounds();
      boundsFrameRef.current = window.requestAnimationFrame(watchBounds);
    };

    void resetNativeView();

    const observer = new ResizeObserver(syncBounds);

    observer.observe(content);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);

    return () => {
      disposed = true;
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);

      if (boundsFrameRef.current != null) {
        window.cancelAnimationFrame(boundsFrameRef.current);
        boundsFrameRef.current = null;
      }

      browser.hide?.();
      shownRef.current = false;
      lastBoundsRef.current = null;
    };
  }, [isAvailable, sessionId]);

  return (
    <>
      {isAvailable ? (
        <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs">
          <span className="shrink-0 font-medium">Built-in browser</span>
          <span role="status" className="min-w-0 flex-1 truncate text-muted-foreground">
            {tab.browserTask?.status === "paused" ? "You have control · resume when finished" : tab.browserTask?.status === "running" ? browserOperationLabels[tab.browserTask.operation ?? ""] ?? "Working on this page" : tab.browserTask?.status === "needs_attention" ? browserOperationLabels[tab.browserTask.operation ?? ""] ?? "Review this page" : "This conversation's tab"}
          </span>
          <Button variant="outline" size="sm" className="h-6 px-2 text-xs"
            onClick={() => { void window.__OPENWORK_ELECTRON__?.browser?.taskControl?.(tab.id, tab.browserTask?.status === "paused" ? "resume" : "pause"); }}>
            {tab.browserTask?.status === "paused" ? "Resume browser" : "Take over"}
          </Button>
        </div>
      ) : null}
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2 mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
        {isAvailable ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={back}
                    disabled={!tab.canGoBack}
                    aria-label="Go back"
                  >
                    <ArrowLeft />
                  </Button>
                )}
              />
              <TooltipContent>Back</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={forward}
                    disabled={!tab.canGoForward}
                    aria-label="Go forward"
                  >
                    <ArrowRight />
                  </Button>
                )}
              />
              <TooltipContent>Forward</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={reload}
                    aria-label="Reload page"
                  >
                    {tab.status === "loading" ? <Loader2 className="animate-spin" /> : <RotateCw />}
                  </Button>
                )}
              />
              <TooltipContent>Reload</TooltipContent>
            </Tooltip>
            <InputGroup className="mx-1 h-7 flex-1 rounded-md">
              <InputGroupInput
                ref={urlInputRef}
                type="text"
                className="h-7"
                value={urlInput}
                onChange={(event) => setUrlInput(event.target.value)}
                onKeyDown={handleUrlKeyDown}
                onFocus={() => {
                  urlFocusedRef.current = true;
                  urlInputRef.current?.select();
                }}
                onBlur={() => {
                  urlFocusedRef.current = false;
                }}
                placeholder="Enter URL..."
                spellCheck={false}
                autoComplete="off"
              />
              <InputGroupAddon align="inline-start" className="ps-2">
                <Globe />
              </InputGroupAddon>
            </InputGroup>
            {tab.siteToolCount > 0 ? (
              <Popover>
                <PopoverTrigger
                  render={(
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-6 shrink-0 rounded-md bg-muted/60 px-2 text-[11px] font-medium"
                      aria-label={`${tab.siteToolCount} site ${tab.siteToolCount === 1 ? "tool" : "tools"} available; inspect site tools and activity`}
                    >
                      {tab.siteToolCount} {tab.siteToolCount === 1 ? "tool" : "tools"}
                    </Button>
                  )}
                />
                <PopoverContent align="end" side="bottom" sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] gap-0 p-0">
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-sm font-semibold">Site tools</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Actions offered by this page. Review the website and the requested action before allowing it.
                    </p>
                  </div>
                  <div className="max-h-64 overflow-y-auto px-4 py-2">
                    {(tab.siteTools ?? []).map((tool) => (
                      <div key={`${tool.origin}:${tool.name}`} className="border-b border-border/60 py-2 last:border-b-0">
                        <div className="flex items-center justify-between gap-3">
                          <p className="min-w-0 truncate text-xs font-medium">{tool.title || tool.name}</p>
                          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {tool.readOnly ? "Site says read-only" : "May change data"}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{tool.name}</p>
                        <p className="truncate text-[10px] text-muted-foreground">{tool.origin}</p>
                      </div>
                    ))}
                  </div>
                  {(tab.siteToolActivity ?? []).length > 0 ? (
                    <div className="border-t border-border px-4 py-3">
                      <p className="mb-1.5 text-xs font-semibold">Recent activity</p>
                      {(tab.siteToolActivity ?? []).slice(0, 5).map((activity, index) => (
                        <div key={`${activity.at}:${activity.name}:${index}`} className="flex items-center justify-between gap-3 py-1 text-[10px]">
                          <span className="min-w-0 truncate font-mono">{activity.name}</span>
                          <span className={activity.status === "completed" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                            {activity.status === "completed" ? "Returned" : activity.code || "Failed"}
                          </span>
                        </div>
                      ))}
                      <p className="mt-1 text-[10px] text-muted-foreground">Arguments and results are not retained in this activity view.</p>
                    </div>
                  ) : null}
                </PopoverContent>
              </Popover>
            ) : null}
          </>
        ) : (
          <p className="px-2 text-sm text-muted-foreground">
            Browser panel is only available in the desktop app.
          </p>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
        >
          <X />
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {isAvailable ? <div ref={contentRef} className="h-full overflow-hidden" /> : null}
      {tab.browserApproval ? (
        <div className="absolute inset-0 z-10 flex flex-col justify-center gap-3 overflow-y-auto bg-background p-5 text-sm" role="region" aria-label="Browser permission request">
          <h3 className="font-semibold">{tab.browserApproval.title}</h3>
          <p className="font-medium">{tab.browserApproval.message}</p>
          <p className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">{tab.browserApproval.detail}</p>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { if (tab.browserApproval) void window.__OPENWORK_ELECTRON__?.browser?.approve?.(tab.id, tab.browserApproval.id, true); }}>{tab.browserApproval.approveLabel ?? "Allow once"}</Button>
            <Button size="sm" variant="outline" onClick={() => { if (tab.browserApproval) void window.__OPENWORK_ELECTRON__?.browser?.approve?.(tab.id, tab.browserApproval.id, false); }}>Deny</Button>
          </div>
        </div>
      ) : null}

      </div>
    </>
  );
}

const browserOperationLabels: Record<string, string> = {
  observe: "Reading this page", site_tools: "Finding website tools", site_tool: "Using a website tool",
  navigate: "Opening a page", click: "Clicking a control", fill: "Entering text", key: "Using the keyboard", scroll: "Scrolling",
  "Website access": "Review website access", website_blocked: "This website is blocked", browser_disabled: "Browser control is disabled",
  stale_observation: "A fresh page view is needed", stale_tool: "Website tools have changed", user_denied: "The action was declined",
  needs_attention: "Review this page", sign_in_required: "Sign in directly in this browser", timeout: "Check the page before continuing",
  result_withheld: "Website result was kept private",
};

export function SidePanel({
  sessionId,
  client,
  workspaceId,
  workspaceRoot,
  isRemoteWorkspace = false,
  onClose,
  onOpenExtensions,
  onOpenVoice,
}: SidePanelProps) {
  const { tabs } = useSessionPanelState(sessionId);
  const activeTab = useActivePanelTab(sessionId);
  const isBrowserAvailable = Boolean(getElectronBrowser());

  const { createTab, closeTab, selectTab, reorderTabs } = useSidePanelTabs(sessionId);

  const seedArtifactOverflowControlAction = React.useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.artifact_tabs.seed_overflow",
      label: "Seed artifact tab overflow eval data",
      description: "Create many markdown artifacts and open them in the right-side artifact tab strip.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      args: [
        { name: "count", type: "number", description: "Number of artifact tabs to create." },
        { name: "longNameLast", type: "boolean", description: "Give the last (active) artifact a very long filename to exercise header truncation." },
      ],
      previewArgs: { count: 18 },
      execute: async (args) => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        let count = 18;
        if (args && typeof args === "object" && "count" in args && typeof args.count === "number") {
          count = Math.max(12, Math.min(30, Math.floor(args.count)));
        }
        const longNameLast = Boolean(args && typeof args === "object" && "longNameLast" in args && args.longNameLast);

        const targets: OpenTarget[] = [];
        const store = usePanelTabStore.getState();

        for (let index = 1; index <= count; index += 1) {
          const padded = String(index).padStart(2, "0");
          const baseName = longNameLast && index === count
            ? `openwork-self-managed-subscription-and-licensing-overview-very-long-${padded}`
            : `overflow-tab-${padded}`;
          const value = `artifacts/${baseName}.md`;
          const label = `${baseName}.md`;
          const content = `# Overflow tab ${padded}\n\nGenerated by the artifact tab overflow eval.\n`;

          await client.writeWorkspaceFile(workspaceId, { path: value, content, baseUpdatedAt: null });

          const target: OpenTarget = {
            id: `file:${value}`,
            kind: "file",
            value,
            name: label,
            preview: "markdown",
            confidence: 100,
            reason: "eval",
            exists: true,
            size: content.length,
          };

          targets.push(target);
          store.openTab(sessionId, {
            id: target.id,
            type: "artifact",
            label: target.name,
            preview: target.preview,
          });
        }

        store.syncTranscriptArtifacts(sessionId, targets);
        store.selectTab(sessionId, targets[targets.length - 1]?.id ?? "");

        return { ok: true, count: targets.length, activeTabId: targets[targets.length - 1]?.id ?? null };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedArtifactOverflowControlAction);

  const seedMarkdownPrimitiveArtifactControlAction = React.useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.markdown_primitive.seed_artifact",
      label: "Seed markdown primitive artifact proof",
      description: "Create a deterministic markdown artifact and open it in the preview panel.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      execute: async (args) => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        const standalone = Boolean(args && typeof args === "object" && "standalone" in args && args.standalone);
        const value = standalone ? "artifacts/standalone-mermaid-proof.mmd" : "artifacts/markdown-primitive-proof.md";
        const name = standalone ? "standalone-mermaid-proof.mmd" : "markdown-primitive-proof.md";
        const content = standalone ? STANDALONE_MERMAID_ARTIFACT_CONTENT : MARKDOWN_PRIMITIVE_ARTIFACT_CONTENT;
        await client.writeWorkspaceFile(workspaceId, {
          path: value,
          content,
          baseUpdatedAt: null,
        });

        const target: OpenTarget = {
          id: `file:${value}`,
          kind: "file",
          value,
          name,
          preview: "markdown",
          confidence: 100,
          reason: "eval",
          exists: true,
          size: content.length,
        };

        const store = usePanelTabStore.getState();
        store.syncTranscriptArtifacts(sessionId, [target]);
        store.openTab(sessionId, { id: target.id, type: "artifact", label: target.name, preview: target.preview });
        store.selectTab(sessionId, target.id);

        return { ok: true, activeTabId: target.id, path: value };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedMarkdownPrimitiveArtifactControlAction);

  const seedPdfArtifactControlAction = React.useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;

    return {
      id: "eval.artifact_tabs.seed_pdf",
      label: "Seed a PDF artifact",
      description: "Write a small valid PDF and open it as an artifact tab to verify inline PDF rendering.",
      sideEffect: "mutation",
      disabled: !client || !workspaceId,
      execute: async () => {
        if (!client || !workspaceId) return { ok: false, error: "Workspace client is not ready." };

        // Minimal single-page PDF that draws "OpenWork PDF" — base64 encoded.
        const pdfBase64 =
          "JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCAzMDAgMTQ0XS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNCAwIFI+Pj4+L0NvbnRlbnRzIDUgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvVHlwZS9Gb250L1N1YnR5cGUvVHlwZTEvQmFzZUZvbnQvSGVsdmV0aWNhPj4KZW5kb2JqCjUgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUCi9GMSAyNCBUZgo3MiA3MCBUZAooT3BlbldvcmsgUERGKSBUagpFVAplbmRzdHJlYW0KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzEyIDAwMDAwIG4gCnRyYWlsZXIKPDwvU2l6ZSA2L1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKNDA2CiUlRU9G";
        const binary = atob(pdfBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);

        const value = "artifacts/sample-document.pdf";
        await client.writeWorkspaceBinaryFile(workspaceId, { path: value, data: bytes.buffer, baseUpdatedAt: null });

        const target: OpenTarget = {
          id: `file:${value}`,
          kind: "file",
          value,
          name: "sample-document.pdf",
          preview: "pdf",
          confidence: 100,
          reason: "eval",
          exists: true,
          size: bytes.length,
        };

        const store = usePanelTabStore.getState();
        store.syncTranscriptArtifacts(sessionId, [target]);
        store.openTab(sessionId, { id: target.id, type: "artifact", label: target.name, preview: target.preview });
        store.selectTab(sessionId, target.id);

        return { ok: true, activeTabId: target.id };
      },
    };
  }, [client, sessionId, workspaceId]);
  useControlAction(seedPdfArtifactControlAction);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.key !== "Tab" || tabs.length < 2) {
        return;
      }

      const activeIndex = activeTab ? tabs.findIndex((tab) => tab.id === activeTab.id) : -1;
      if (activeIndex === -1) {
        return;
      }

      event.preventDefault();
      const offset = event.shiftKey ? -1 : 1;
      selectTab(tabs[(activeIndex + offset + tabs.length) % tabs.length].id);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeTab, selectTab, tabs]);

  return (
    <TooltipProvider delay={1000}>
      <div
        className="flex h-full flex-col"
        onKeyDownCapture={(event) => {
          if (!handlePanelEscape(event.key, onClose)) return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <div className="shrink-0 border-b border-border bg-background mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
          <div className="flex h-10 items-center gap-1 border-b border-border/60 px-2">
            <div className="no-scrollbar min-w-0 flex-1 overflow-x-auto">
              <PanelTabList
                values={tabs.map((tab) => tab.id)}
                onReorder={reorderTabs}
              >
                {tabs.map((tab) => (
                  <SidePanelTab
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTab?.id}
                    onSelect={selectTab}
                    onClose={closeTab}
                  />
                ))}
              </PanelTabList>
            </div>
            {!activeTab ? <span className="sr-only">Panel destinations</span> : null}
            {activeTab && isBrowserAvailable ? (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => createTab()}
                      aria-label="New tab"
                    >
                      <Plus />
                    </Button>
                  )}
                />
                <TooltipContent>New tab</TooltipContent>
              </Tooltip>
            ) : !activeTab ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onClose}
                aria-label="Close panel"
              >
                <X />
              </Button>
            ) : null}
          </div>
        </div>
        {!activeTab ? (
          <PanelEmpty
            onOpenBrowser={isBrowserAvailable ? createTab : undefined}
            onOpenExtensions={onOpenExtensions}
            onOpenVoice={onOpenVoice}
          />
        ) : null}
        {activeTab?.type === "browser" ? (
          <>
            <LoginSyncCard />
            <BrowserPanelContent sessionId={sessionId} tab={activeTab} onClose={onClose} />
          </>
        ) : activeTab?.type === "app" ? (
          <div className="min-h-0 flex-1 overflow-hidden"><AppArtifact key={activeTab.id} appId={activeTab.appId} revisionId={activeTab.revisionId} receiptId={activeTab.receiptId} onClose={onClose} /></div>
        ) : activeTab?.type === "artifact" ? (
          <div className="min-h-0 flex-1 overflow-hidden">
            <ArtifactPanel
              sessionId={sessionId}
              tab={activeTab}
              client={client}
              workspaceId={workspaceId}
              workspaceRoot={workspaceRoot}
              isRemoteWorkspace={isRemoteWorkspace}
              onClose={onClose}
            />
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
