/** @jsxImportSource react */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight, Copy, Bug, GripHorizontal, RefreshCw, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useDebugRailSlot } from "../panel/debug-rail-slot";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appBuildInfo } from "@/app/lib/desktop";
import { createClient, unwrap } from "@/app/lib/opencode";
import { createClientV2, isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { toast } from "@/components/ui/sonner";
import type { OpenworkServerClient } from "@/app/lib/openwork-server";
import { useWorkspaceSyncStreamStore, workspaceSyncStreamKey } from "../sync/session-sync";
import type { SessionRenderModel } from "../sync/transition-controller";
import { DebugResources, useDebugResources, type DebugActivity } from "./debug-resources";
import { DebugProviders, DebugWorkspaceProviders } from "./debug-providers";
import type { ModelRef } from "@/app/types";
import type { ModelAvailabilityResolver } from "./model-availability";

type PanelBounds = { left: number; top: number };

function DiagnosticTable({ rows }: { rows: readonly (readonly [string, string | number])[] }) {
  return (
    <table className="w-full table-fixed text-[11px] leading-4">
      <tbody>
        {rows.map(([label, value]) => (
          <tr key={label} className="border-b border-dls-border/50 last:border-0">
            <th scope="row" className="w-28 whitespace-nowrap py-0.5 pr-2 text-left align-top font-normal text-dls-secondary">{label}</th>
            <td className="break-all py-0.5 text-right font-mono text-dls-text">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Details of the focused conversation. Absent when no thread is open. */
export type SessionDebugThread = {
  model: SessionRenderModel;
  status: string;
  messageCount: number;
  todoCount: number;
  modelLabel: string;
  waitingOn: string;
  activity: readonly DebugActivity[];
  threadTitle: string;
  selectedModel: ModelRef;
  variant: string | null;
  historyComplete: boolean;
  resolveAvailability?: ModelAvailabilityResolver;
  onCopyThread: () => Promise<void>;
};

/** App and workspace facts shown when no thread is open. */
export type SessionDebugWorkspace = {
  name: string;
  startupPhase: string;
  providersConnected: number;
  mcpConnected: number;
};

export function SessionDebugPanel(props: {
  client: OpenworkServerClient | null;
  workspaceId: string;
  workspaceRoot: string;
  opencodeBaseUrl: string;
  openworkToken: string;
  thread: SessionDebugThread | null;
  workspace?: SessionDebugWorkspace;
}) {
  const [dismissed, setDismissed] = useState(true);
  const [tab, setTab] = useState("overview");
  const thread = props.thread;
  const hasRuntime = Boolean(props.client && props.opencodeBaseUrl && props.openworkToken);
  const slot = useDebugRailSlot();
  const panelRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [bounds, setBounds] = useState<PanelBounds>({ left: 0, top: 0 });
  const interaction = useRef<{ x: number; y: number; bounds: PanelBounds; rect: DOMRect } | null>(null);
  const streamKey = workspaceSyncStreamKey({ workspaceId: props.workspaceId, baseUrl: props.opencodeBaseUrl });
  const streamPhase = useWorkspaceSyncStreamStore(state => state.phasesByKey[streamKey]);
  const reconcileHealth = useWorkspaceSyncStreamStore(state => state.reconcileHealthByKey[streamKey]);
  const resources = useDebugResources({ workspaceId: props.workspaceId, sessionId: thread?.model.intendedSessionId ?? "",
    baseUrl: props.opencodeBaseUrl, enabled: !dismissed });

  const diagnostics = useQuery({
    queryKey: ["react-session-debug-health", props.client?.baseUrl, props.workspaceId, props.opencodeBaseUrl],
    enabled: !dismissed && hasRuntime,
    retry: false,
    refetchInterval: dismissed ? false : 15_000,
    queryFn: async ({ signal }) => {
      if (!props.client) throw new Error("No workspace runtime");
      const engine = isOpencodeV2BaseUrl(props.opencodeBaseUrl)
        ? createClientV2(props.opencodeBaseUrl, undefined, { token: props.openworkToken })
        : createClient(props.opencodeBaseUrl, undefined, { mode: "openwork", token: props.openworkToken });
      const started = performance.now();
      const [server, opencode] = await Promise.allSettled([
        props.client.health(),
        engine.global.health({ signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]) }).then(unwrap),
      ]);
      return {
        server: server.status === "fulfilled" ? server.value : null,
        opencode: opencode.status === "fulfilled" ? opencode.value : null,
        // Includes authenticated workspace proxy and parsing; not inference latency.
        latencyMs: Math.round(performance.now() - started),
        checkedAt: new Date().toLocaleTimeString(),
      };
    },
  });
  const build = useQuery({
    queryKey: ["react-session-debug-build"],
    queryFn: () => appBuildInfo(),
    enabled: !dismissed && isDesktopRuntime(),
    staleTime: Infinity,
    retry: false,
  });

  useEffect(() => {
    const fit = () => setBounds({ left: 0, top: 0 });
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const data = diagnostics.data;
  const connected = data?.server?.ok === true && data?.opencode?.healthy === true;
  const connectionLabel = !hasRuntime ? "No runtime" : diagnostics.isFetching ? "Checking" : !data ? "Not checked" : connected ? "Connected" : "Health check failed";
  const latency = connected && !diagnostics.isFetching ? `${data.latencyMs} ms` : "—";
  const version = build.data?.version ?? import.meta.env.VITE_OPENWORK_APP_VERSION ?? "Unknown";
  const runtimeRows = [
    [isDesktopRuntime() ? "Desktop" : "Web app", version],
    ["OpenCode", data?.opencode?.version ?? "Unavailable"],
    ["Event stream", streamPhase ?? "Not started"],
  ] as const;
  const rows: readonly (readonly [string, string | number])[] = thread ? [
    ["Status", thread.status],
    ["Waiting on", thread.waitingOn],
    ["Messages / todos", `${thread.messageCount} / ${thread.todoCount}`],
    ["Model", thread.modelLabel || "Unknown"],
    ...runtimeRows,
  ] : [
    ["Thread", "None selected"],
    ["Workspace name", props.workspace?.name || "None"],
    ...runtimeRows,
    ["Providers connected", props.workspace?.providersConnected ?? 0],
    ["MCP connected", props.workspace?.mcpConnected ?? 0],
  ];
  const details: readonly (readonly [string, string | number])[] = [
    ...(thread ? [
      ["Intended session", thread.model.intendedSessionId || "—"],
      ["Rendered session", thread.model.renderedSessionId || "—"],
      ["Transition", thread.model.transitionState],
      ["Render source", thread.model.renderSource],
    ] as const : [["Startup phase", props.workspace?.startupPhase ?? "Unknown"]] as const),
    ["Workspace", props.workspaceId || "None"],
    ["OpenWork server", data?.server?.version ?? "Unavailable"],
    ["Build", build.data?.gitSha ?? import.meta.env.VITE_OPENWORK_BUILD_SHA ?? "Unknown"],
    ["Sync failures", reconcileHealth?.consecutiveFailures ?? 0],
    ["Last checked", data?.checkedAt ?? "—"],
  ];

  function startInteraction(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = panelRef.current?.getBoundingClientRect();
    if (rect) interaction.current = { x: event.clientX, y: event.clientY, bounds, rect };
  }
  function movePointer(event: PointerEvent<HTMLButtonElement>) {
    const start = interaction.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    setBounds(adjustBounds(start.bounds, start.rect, dx, dy));
  }
  function adjustBounds(previous: PanelBounds, rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">, dx: number, dy: number): PanelBounds {
    return {
      left: previous.left + Math.max(-rect.left, Math.min(dx, window.innerWidth - rect.right)),
      top: previous.top + Math.max(-rect.top, Math.min(dy, window.innerHeight - rect.bottom)),
    };
  }
  function adjustWithKeyboard(event: KeyboardEvent<HTMLButtonElement>) {
    const dx = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const dy = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    const rect = panelRef.current?.getBoundingClientRect();
    const amount = event.shiftKey ? 40 : 10;
    if (!rect) return;
    // Key presses can arrive before React commits the previous one. Accumulate
    // from pending state and account for its geometry relative to this render.
    setBounds(previous => adjustBounds(previous, {
      left: rect.left + previous.left - bounds.left,
      top: rect.top + previous.top - bounds.top,
      right: rect.right + previous.left - bounds.left,
      bottom: rect.bottom + previous.top - bounds.top,
    }, dx * amount, dy * amount));
  }
  async function copyDiagnostics() {
    try {
      // Omit URLs, credentials, workspace paths and conversation content.
      await navigator.clipboard.writeText([
        "React session debug", ...rows, ...details,
        ["Connection", connectionLabel], ["Health round trip", latency], ["Event stream", streamPhase ?? "Not started"],
        ...(thread?.activity ?? []).map(item => [item.label, item.state] as const),
        ...resources.map(item => [item.label, `${item.state}${item.elapsedMs === null ? "" : ` (${(item.elapsedMs / 1_000).toFixed(1)}s)`}`] as const),
      ].map(row => typeof row === "string" ? row : `${row[0]}: ${row[1]}`).join("\n"));
      setCopied(true);
    } catch {
      toast.error("Could not copy diagnostics. Try again.");
    }
  }

  if (!slot) return null;

  return createPortal(
    <Popover open={!dismissed} onOpenChange={open => {
      setDismissed(!open);
      if (open) setBounds({ left: 0, top: 0 });
    }}>
      <PopoverTrigger render={<Button variant="ghost" size="icon-sm" className="rounded-xl" aria-label="Show session debug" title="Show session debug" />}>
        <Bug className="size-4" />
      </PopoverTrigger>
      <PopoverContent ref={panelRef} aria-label="React session debug" data-testid="session-debug-panel"
        // Overlap the trigger so the footer bug occupies its exact position.
        side="top" align="end" alignOffset={-4} sideOffset={-36} collisionPadding={0}
        style={{ translate: `${bounds.left}px ${bounds.top}px` }}
        className="w-90 gap-0 overflow-hidden rounded-md bg-dls-surface p-0 font-mono text-[11px] text-dls-secondary shadow-sm ring-0 transition-none duration-0 data-open:animate-none data-closed:animate-none"
      >
      <header className="flex shrink-0 items-center gap-1 border-b border-dls-border px-2 py-1">
        <Button variant="ghost" size="sm" className="min-w-0 flex-1 touch-none select-none justify-start h-6 gap-1.5 rounded-sm px-0 text-[11px] font-medium text-dls-text cursor-grab active:cursor-grabbing"
          aria-label="Move session debug" title="Drag to move; arrow keys to nudge"
          onPointerDown={startInteraction} onPointerMove={movePointer}
          onPointerUp={() => { interaction.current = null; }} onPointerCancel={() => { interaction.current = null; }}
          onLostPointerCapture={() => { interaction.current = null; }} onKeyDown={adjustWithKeyboard}
        >
          <GripHorizontal className="size-3 shrink-0 text-dls-secondary" /><span className="truncate">React session debug</span>
        </Button>
        <Button variant="ghost" size="icon-xs" className="rounded-sm" aria-label={copied ? "Diagnostics copied" : "Copy diagnostics"} title="Copy diagnostics" onClick={() => void copyDiagnostics()}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </Button>
        <Button variant="ghost" size="icon-xs" className="rounded-sm" aria-label="Dismiss session debug" title="Dismiss" onClick={() => setDismissed(true)}><X className="size-4" /></Button>
      </header>
      <Tabs value={tab} onValueChange={value => setTab(value === "providers" ? "providers" : value === "resources" ? "resources" : "overview")} className="min-h-0 flex-1 gap-0 overflow-hidden">
        <TabsList aria-label="Session debug views" variant="line" className="h-7 w-full shrink-0 justify-start border-b border-dls-border px-2">
          <TabsTrigger value="overview" className="flex-none px-1.5 text-[11px]">Overview</TabsTrigger>
          <TabsTrigger value="resources" className="flex-none px-1.5 text-[11px]">Resources</TabsTrigger>
          <TabsTrigger value="providers" className="flex-none px-1.5 text-[11px]">Providers</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="max-h-96 min-h-0 overflow-y-auto px-2 py-1">
          <DiagnosticTable rows={rows} />
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="group h-6 w-full justify-start gap-1 rounded-sm px-0 text-[11px]" />}>
              <ChevronRight className="size-3 transition-transform group-data-panel-open:rotate-90" /> More details
            </CollapsibleTrigger>
            <CollapsibleContent><DiagnosticTable rows={details} /></CollapsibleContent>
          </Collapsible>
        </TabsContent>
        <TabsContent value="resources" className="max-h-96 min-h-0 overflow-y-auto px-2 py-1 [overflow-anchor:none]">
          <DebugResources resources={resources} activity={thread?.activity ?? []} waitingOn={thread?.waitingOn ?? "No thread selected"} />
        </TabsContent>
        <TabsContent value="providers" className="max-h-96 min-h-0 overflow-y-auto px-2 py-1 [overflow-anchor:none]">
          {tab !== "providers" ? null : !hasRuntime ? <div className="py-2">No workspace runtime is connected.</div>
            : thread ? <DebugProviders key={`${props.workspaceId}:${thread.model.intendedSessionId}`}
              workspaceId={props.workspaceId} workspaceRoot={props.workspaceRoot} sessionId={thread.model.intendedSessionId}
              threadTitle={thread.threadTitle} baseUrl={props.opencodeBaseUrl} token={props.openworkToken}
              selectedModel={thread.selectedModel} variant={thread.variant} status={thread.status} messageCount={thread.messageCount}
              historyComplete={thread.historyComplete} resolveAvailability={thread.resolveAvailability} onCopyThread={thread.onCopyThread} />
            : <DebugWorkspaceProviders workspaceRoot={props.workspaceRoot} baseUrl={props.opencodeBaseUrl} token={props.openworkToken} />}
        </TabsContent>
      </Tabs>
      <footer className="flex shrink-0 items-center gap-2 border-t border-dls-border px-1 py-1 text-[11px]">
        <span className={data && !connected ? "pl-1 text-destructive" : "pl-1 text-dls-text"}>{connectionLabel}</span>
        <span className="ml-auto font-mono tabular-nums" title="Combined server and engine health round trip, including proxy overhead">Health RTT {latency}</span>
        <Button variant="ghost" size="icon-xs" className="rounded-sm" aria-label="Refresh diagnostics" title="Refresh diagnostics" disabled={!hasRuntime || diagnostics.isFetching} onClick={() => void diagnostics.refetch()}><RefreshCw className="size-3" /></Button>
        <Button variant="ghost" size="icon-sm" className="rounded-sm" aria-label="Hide session debug" title="Hide session debug" onClick={() => setDismissed(true)}><Bug className="size-4" /></Button>
      </footer>
      </PopoverContent>
    </Popover>, slot,
  );
}
