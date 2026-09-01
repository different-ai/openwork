import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { createCoworkerThreads, type CoworkerActivity, type EngineModelOption } from "@/lib/threads";
import { AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
import { CapabilitiesPanel } from "@/ui/capabilities";
import { Button, ErrorNote, Field, StatusDot, inputClass } from "@/ui/kit";
import { MemoryPanel } from "@/ui/memory";
import { ResponsibilitiesPanel } from "@/ui/responsibilities";
import { ThreadsPanel } from "@/ui/threads";
import { ModelPicker, type ModelSelection } from "@/ui/model-picker";

type ContextView = "overview" | "capabilities" | "memory" | "settings" | "openwork";

const CONTEXT_PANEL_WIDTH_KEY = "open-coworker.context-panel-width";
const CONTEXT_PANEL_MIN_WIDTH = 320;
const CONTEXT_PANEL_MAX_WIDTH = 620;
const MAIN_WORKSPACE_MIN_WIDTH = 520;

function clampContextPanelWidth(width: number): number {
  const available = typeof window === "undefined"
    ? CONTEXT_PANEL_MAX_WIDTH
    : Math.max(CONTEXT_PANEL_MIN_WIDTH, window.innerWidth - MAIN_WORKSPACE_MIN_WIDTH);
  return Math.round(Math.min(CONTEXT_PANEL_MAX_WIDTH, available, Math.max(CONTEXT_PANEL_MIN_WIDTH, width)));
}

function readContextPanelWidth(): number | null {
  try {
    const stored = window.localStorage.getItem(CONTEXT_PANEL_WIDTH_KEY);
    if (!stored) return null;
    const width = Number(stored);
    return Number.isFinite(width) ? clampContextPanelWidth(width) : null;
  } catch {
    return null;
  }
}

function persistContextPanelWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(CONTEXT_PANEL_WIDTH_KEY);
    else window.localStorage.setItem(CONTEXT_PANEL_WIDTH_KEY, String(width));
  } catch {
    // The resize remains available for this session when storage is blocked.
  }
}

function activityTone(activity: CoworkerActivity | undefined): "spark" | "mint" | "amber" | "rose" | "mist" {
  if (activity?.state === "working") return "spark";
  if (activity?.state === "retrying" || activity?.state === "attention") return "amber";
  if (activity?.state === "offline") return "rose";
  if (activity?.state === "recent") return "mint";
  return "mist";
}

function activityTextTone(activity: CoworkerActivity | undefined): string {
  if (activity?.state === "working") return "text-spark";
  if (activity?.state === "retrying" || activity?.state === "attention") return "text-amber";
  if (activity?.state === "offline") return "text-rose";
  if (activity?.state === "recent") return "text-mint";
  return "text-mist";
}

function activityTime(timestamp: number): string {
  if (!timestamp) return "No recent run";
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "Updated now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  return `Updated ${Math.round(hours / 24)}d ago`;
}

function activityContext(activity: CoworkerActivity | undefined): string {
  if (!activity) return "Reading the latest OpenWork thread state.";
  if (activity.state === "working") return "An OpenWork thread is active right now.";
  if (activity.state === "retrying") return "The current thread is retrying after an interruption.";
  if (activity.state === "attention") return "A recurring responsibility needs your decision.";
  if (activity.state === "recent") return "No active run. This is the most recently updated thread.";
  if (activity.state === "offline") return "OpenWork cannot read this coworker’s activity right now.";
  return "Ready for a new assignment.";
}

export function CoworkerHome({
  runtime,
  session,
  coworkers,
  coworker,
  activity,
  onCoworkerChanged,
  onCoworkerRemoved,
  onRefreshRuntime,
  onConnect,
  onSignOut,
  openConfigurationSignal,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  activity?: CoworkerActivity;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onCoworkerRemoved: (slug: string) => void;
  onRefreshRuntime: () => Promise<void>;
  onConnect: () => void;
  onSignOut: () => void;
  openConfigurationSignal: number;
}) {
  const [contextView, setContextView] = useState<ContextView>("overview");
  const [assignmentDraft, setAssignmentDraft] = useState<{ id: number; text: string } | null>(null);
  const [contextPanelWidth, setContextPanelWidth] = useState<number | null>(readContextPanelWidth);
  const [resizingContextPanel, setResizingContextPanel] = useState(false);
  const contextPanelDrag = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null);

  const contextualPanelWidth = contextView === "capabilities" ? 430 : 360;
  const renderedContextPanelWidth = clampContextPanelWidth(contextPanelWidth ?? contextualPanelWidth);

  useEffect(() => {
    if (openConfigurationSignal > 0) setContextView("openwork");
  }, [openConfigurationSignal]);

  useEffect(() => {
    if (!resizingContextPanel) return;
    const move = (event: PointerEvent) => {
      const drag = contextPanelDrag.current;
      if (!drag) return;
      const next = clampContextPanelWidth(drag.startWidth + drag.startX - event.clientX);
      drag.currentWidth = next;
      setContextPanelWidth(next);
    };
    const finish = () => {
      const width = contextPanelDrag.current?.currentWidth ?? null;
      contextPanelDrag.current = null;
      setResizingContextPanel(false);
      if (width !== null) persistContextPanelWidth(width);
    };
    document.body.classList.add("is-resizing-context-panel");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
    return () => {
      document.body.classList.remove("is-resizing-context-panel");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [resizingContextPanel]);

  useEffect(() => {
    const keepWithinWindow = () => {
      setContextPanelWidth((current) => {
        if (current === null) return null;
        const next = clampContextPanelWidth(current);
        if (next !== current) persistContextPanelWidth(next);
        return next;
      });
    };
    window.addEventListener("resize", keepWithinWindow);
    return () => window.removeEventListener("resize", keepWithinWindow);
  }, []);

  function setManualContextPanelWidth(width: number): void {
    const next = clampContextPanelWidth(width);
    setContextPanelWidth(next);
    persistContextPanelWidth(next);
  }

  function resetContextPanelWidth(): void {
    setContextPanelWidth(null);
    persistContextPanelWidth(null);
  }

  return (
    <div className="glass-main flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass-header window-drag flex h-[78px] items-center justify-between gap-4 border-b border-line px-6 pt-2">
          <CoworkerAvatar
            animated
            color={coworker.avatarColor}
            glasses={coworker.avatarGlasses}
            name={coworker.name}
            size={42}
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-snow">{coworker.name}</h1>
            <p className="truncate text-xs text-mist">{coworker.role || coworker.mission || "Persistent coworker"}</p>
          </div>
          <span className={`flex shrink-0 items-center gap-2 text-xs ${runtime.engineManaged ? activityTextTone(activity) : "text-rose"}`} title={activity?.detail}>
            <StatusDot tone={runtime.engineManaged ? activityTone(activity) : "rose"} />
            {runtime.engineManaged ? (activity?.label ?? "Checking status") : "Engine offline"}
          </span>
        </header>
        {!runtime.engineManaged && runtime.engineError ? (
          <div className="border-b border-line px-5 py-3">
            <ErrorNote>
              The agent engine is offline: {runtime.engineError}. Install the OpenCode engine or set
              OPENWORK_OPENCODE_BIN, then reopen Open Coworker.
            </ErrorNote>
          </div>
        ) : null}
        <main className="min-h-0 flex-1 overflow-hidden">
          <ThreadsPanel
            runtime={runtime}
            coworker={coworker}
            onCoworkerChanged={onCoworkerChanged}
            onRefreshRuntime={onRefreshRuntime}
            assignmentDraft={assignmentDraft}
          />
        </main>
      </div>

      <aside
        className={`glass-context relative flex h-full shrink-0 flex-col border-l border-line ${resizingContextPanel ? "" : "transition-[width] duration-200"}`}
        style={{ width: renderedContextPanelWidth }}
      >
        <div
          role="separator"
          aria-label="Resize context panel"
          aria-orientation="vertical"
          aria-valuemin={CONTEXT_PANEL_MIN_WIDTH}
          aria-valuemax={CONTEXT_PANEL_MAX_WIDTH}
          aria-valuenow={renderedContextPanelWidth}
          aria-valuetext={`${renderedContextPanelWidth} pixels wide`}
          tabIndex={0}
          className="window-no-drag group absolute inset-y-0 -left-[5px] z-30 w-[10px] cursor-col-resize outline-none"
          title="Drag to resize · Double-click to reset"
          data-testid="context-panel-resizer"
          onPointerDown={(event) => {
            event.preventDefault();
            contextPanelDrag.current = {
              startX: event.clientX,
              startWidth: renderedContextPanelWidth,
              currentWidth: renderedContextPanelWidth,
            };
            setResizingContextPanel(true);
          }}
          onDoubleClick={resetContextPanelWidth}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              setManualContextPanelWidth(renderedContextPanelWidth + (event.shiftKey ? 40 : 12));
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              setManualContextPanelWidth(renderedContextPanelWidth - (event.shiftKey ? 40 : 12));
            } else if (event.key === "Home") {
              event.preventDefault();
              setManualContextPanelWidth(CONTEXT_PANEL_MIN_WIDTH);
            } else if (event.key === "End") {
              event.preventDefault();
              setManualContextPanelWidth(CONTEXT_PANEL_MAX_WIDTH);
            } else if (event.key === "Enter") {
              event.preventDefault();
              resetContextPanelWidth();
            }
          }}
        >
          <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover:bg-spark/45 group-focus-visible:bg-spark/70" />
        </div>
        <header className="glass-header window-drag flex h-[78px] items-center gap-3 border-b border-line px-4 pt-2">
          {contextView !== "overview" ? (
            <Button variant="ghost" className="window-no-drag px-2" onClick={() => setContextView("overview")} title="Back to coworker details">
              ←
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-snow">
              {contextView === "memory"
                ? "Memory"
                : contextView === "capabilities"
                  ? "Apps & tools"
                : contextView === "settings"
                  ? "Coworker settings"
                  : contextView === "openwork"
                    ? "OpenWork configuration"
                    : "Coworker details"}
            </h2>
            <p className="truncate text-xs text-mist">
              {contextView === "overview"
                ? "Context stays beside the work"
                : contextView === "capabilities"
                  ? `Available to ${coworker.name}`
                : contextView === "openwork"
                  ? "Shared account, engine, and providers"
                  : coworker.name}
            </p>
          </div>
          {contextView === "overview" ? (
            <Button variant="ghost" className="window-no-drag" onClick={() => setContextView("settings")}>
              Settings
            </Button>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {contextView === "overview" ? (
            <CoworkerOverview
              session={session}
              coworkers={coworkers}
              coworker={coworker}
              activity={activity}
              onCoworkerChanged={onCoworkerChanged}
              onOpenMemory={() => setContextView("memory")}
              onOpenCapabilities={() => setContextView("capabilities")}
              onOpenSettings={() => setContextView("settings")}
              onOpenOpenWork={() => setContextView("openwork")}
            />
          ) : null}
          {contextView === "memory" ? <MemoryPanel coworker={coworker} /> : null}
          {contextView === "capabilities" ? (
            <CapabilitiesPanel
              runtime={runtime}
              coworker={coworker}
              onAssign={(text) => {
                setAssignmentDraft({ id: Date.now(), text });
                setContextView("overview");
              }}
            />
          ) : null}
          {contextView === "settings" ? (
            <CoworkerSettings
              runtime={runtime}
              coworker={coworker}
              onCoworkerChanged={onCoworkerChanged}
              onCoworkerRemoved={onCoworkerRemoved}
            />
          ) : null}
          {contextView === "openwork" ? (
            <OpenWorkConfiguration
              runtime={runtime}
              session={session}
              coworker={coworker}
              onConnect={onConnect}
              onSignOut={onSignOut}
              onRefreshRuntime={onRefreshRuntime}
            />
          ) : null}
        </div>
      </aside>
    </div>
  );
}

function CoworkerOverview({
  session,
  coworkers,
  coworker,
  activity,
  onCoworkerChanged,
  onOpenMemory,
  onOpenCapabilities,
  onOpenSettings,
  onOpenOpenWork,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  activity?: CoworkerActivity;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onOpenMemory: () => void;
  onOpenCapabilities: () => void;
  onOpenSettings: () => void;
  onOpenOpenWork: () => void;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-line bg-ink p-4">
        <div className="flex items-start gap-3">
          <CoworkerAvatar
            animated
            color={coworker.avatarColor}
            glasses={coworker.avatarGlasses}
            name={coworker.name}
            size={68}
          />
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-snow">{coworker.name}</h3>
            <p className="mt-0.5 text-xs text-mist">{coworker.role || "Persistent coworker"}</p>
          </div>
        </div>
        {coworker.mission ? <p className="mt-3 text-sm leading-relaxed text-snow">{coworker.mission}</p> : null}
        <button className="mt-3 text-xs font-medium text-spark hover:underline" onClick={onOpenSettings}>
          Edit appearance, role, mission, and model
        </button>
      </section>

      <section className="rounded-2xl border border-line bg-ink p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Activity summary</p>
            <div className={`mt-2 flex items-center gap-2 text-sm font-semibold ${activityTextTone(activity)}`}>
              <StatusDot tone={activityTone(activity)} />
              {activity?.label ?? "Checking status"}
            </div>
          </div>
          <span className="shrink-0 text-[10px] text-mist">{activityTime(activity?.updatedAt ?? 0)}</span>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-snow">{activity?.detail ?? "Reading current activity…"}</p>
        <p className="mt-1.5 text-xs leading-relaxed text-mist">{activityContext(activity)}</p>
      </section>

      <section>
        <ResponsibilitiesPanel
          session={session}
          coworkers={coworkers}
          coworker={coworker}
          onCoworkerChanged={onCoworkerChanged}
          onConnect={onOpenOpenWork}
        />
      </section>

      <button
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-line bg-ink p-4 text-left transition-colors hover:bg-panel"
        onClick={onOpenCapabilities}
      >
        <span>
          <span className="block text-sm font-semibold text-snow">Apps & tools</span>
          <span className="mt-1 block text-xs leading-relaxed text-mist">
            Browse live MCP connections and interactive Apps.
          </span>
        </span>
        <span className="text-mist" aria-hidden="true">›</span>
      </button>

      <button
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-line bg-ink p-4 text-left transition-colors hover:bg-panel"
        onClick={onOpenMemory}
      >
        <span>
          <span className="block text-sm font-semibold text-snow">Memory</span>
          <span className="mt-1 block text-xs leading-relaxed text-mist">
            Inspect working context and durable Markdown memories.
          </span>
        </span>
        <span className="text-mist" aria-hidden="true">›</span>
      </button>
    </div>
  );
}

function OpenWorkConfiguration({
  runtime,
  session,
  coworker,
  onConnect,
  onSignOut,
  onRefreshRuntime,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  onConnect: () => void;
  onSignOut: () => void;
  onRefreshRuntime: () => Promise<void>;
}) {
  const threads = useMemo(
    () =>
      coworker.workspaceId
        ? createCoworkerThreads({
            serverUrl: runtime.serverUrl,
            workspaceId: coworker.workspaceId,
            token: runtime.ownerToken,
            model: coworker.model,
            modelVariant: coworker.modelVariant,
          })
        : null,
    [runtime.serverUrl, runtime.ownerToken, coworker.workspaceId, coworker.model, coworker.modelVariant],
  );
  const [models, setModels] = useState<EngineModelOption[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const refreshConfiguration = useCallback(async () => {
    setRefreshing(true);
    setError("");
    try {
      await onRefreshRuntime();
      setModels(threads && runtime.engineManaged ? await threads.listModels() : []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRefreshing(false);
    }
  }, [onRefreshRuntime, runtime.engineManaged, threads]);

  useEffect(() => {
    void refreshConfiguration();
  }, [refreshConfiguration]);

  const providers = new Set(models.map((model) => model.id.split("/")[0]).filter(Boolean));
  const selectedModel = coworker.model
    ? (models.find((model) => model.id === coworker.model)?.label ?? coworker.model)
    : "OpenWork engine default";

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-ink p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Account</p>
            <div className="mt-2 flex items-center gap-2 text-sm font-semibold text-snow">
              <StatusDot tone={session ? "mint" : "mist"} />
              {session ? "OpenWork connected" : "Local mode"}
            </div>
          </div>
          {session ? (
            <Button variant="ghost" className="text-xs" onClick={onSignOut}>Sign out</Button>
          ) : (
            <Button variant="primary" className="text-xs" onClick={onConnect}>Connect</Button>
          )}
        </div>
        <p className="mt-2 truncate text-xs text-mist" title={session?.userEmail || undefined}>
          {session?.orgName || session?.userEmail || "Connect for cloud responsibilities and schedules."}
        </p>
        {session ? (
          <button
            className="mt-2 text-xs font-medium text-spark hover:underline"
            onClick={() => void coworkerBridge.openExternal(session.baseUrl)}
          >
            Open OpenWork
          </button>
        ) : null}
      </section>

      <section className="rounded-2xl border border-line bg-ink p-4">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Agent engine</p>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-snow">
            <StatusDot tone={runtime.engineManaged ? "mint" : "rose"} />
            {runtime.engineManaged ? "Running" : "Unavailable"}
          </span>
          <span className="text-[10px] text-mist">{runtime.engineManaged ? "Managed locally" : "Offline"}</span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-mist">
          Coworker threads run through the same OpenWork engine and workspace-scoped tools.
        </p>
      </section>

      <section className="rounded-2xl border border-line bg-ink p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Models & providers</p>
            <p className="mt-2 text-sm font-semibold text-snow">
              {models.length > 0
                ? `${models.length} model${models.length === 1 ? "" : "s"} · ${providers.size} provider${providers.size === 1 ? "" : "s"}`
                : runtime.engineManaged
                  ? "Reading OpenWork configuration"
                  : "Configuration unavailable"}
            </p>
          </div>
          <Button variant="ghost" className="text-xs" disabled={refreshing} onClick={() => void refreshConfiguration()}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-mist">
          Provider connections are read live from OpenWork. Change them there, then refresh to use the updated catalog here.
        </p>
        <div className="mt-3 rounded-xl border border-line bg-panel/50 px-3 py-2.5">
          <p className="text-[10px] uppercase tracking-[0.12em] text-mist">{coworker.name} uses</p>
          <p className="mt-1 truncate text-xs font-medium text-snow" title={selectedModel}>{selectedModel}</p>
          {coworker.modelVariant ? <p className="mt-0.5 text-[10px] text-mist">Reasoning · {coworker.modelVariant}</p> : null}
        </div>
      </section>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

function CoworkerSettings({
  runtime,
  coworker,
  onCoworkerChanged,
  onCoworkerRemoved,
}: {
  runtime: RuntimeInfo;
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onCoworkerRemoved: (slug: string) => void;
}) {
  const [role, setRole] = useState(coworker.role);
  const [mission, setMission] = useState(coworker.mission);
  const [avatarColor, setAvatarColor] = useState(coworker.avatarColor);
  const [avatarGlasses, setAvatarGlasses] = useState(coworker.avatarGlasses);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [confirmArmed, setConfirmArmed] = useState(false);

  useEffect(() => {
    if (!confirmingRetire) {
      setConfirmArmed(false);
      return;
    }
    const timer = window.setTimeout(() => setConfirmArmed(true), 500);
    return () => window.clearTimeout(timer);
  }, [confirmingRetire]);

  async function saveProfile() {
    setBusy(true);
    setError("");
    try {
      onCoworkerChanged(
        await coworkerBridge.coworkers.update(coworker.slug, {
          role: role.trim(),
          mission: mission.trim(),
          avatarColor,
          avatarGlasses,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function updateModel(selection: ModelSelection) {
    setError("");
    try {
      onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, selection));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function retire() {
    setBusy(true);
    setError("");
    try {
      await coworkerBridge.coworkers.remove(coworker.slug);
      onCoworkerRemoved(coworker.slug);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3 rounded-2xl border border-line bg-ink p-4">
        <div className="avatar-stage flex min-h-40 items-center justify-center rounded-2xl border border-line">
          <CoworkerAvatar
            animated
            color={avatarColor}
            glasses={avatarGlasses}
            name={coworker.name}
            size={108}
          />
        </div>
        <AvatarControls
          color={avatarColor}
          glasses={avatarGlasses}
          onColorChange={setAvatarColor}
          onGlassesChange={setAvatarGlasses}
        />
        <div className="border-t border-line pt-3" />
        <Field label="Name">
          <input className={`${inputClass} bg-panel`} value={coworker.name} disabled />
        </Field>
        <Field label="Role">
          <input className={`${inputClass} bg-panel`} value={role} onChange={(event) => setRole(event.target.value)} />
        </Field>
        <Field label="Mission">
          <textarea className={`${inputClass} min-h-28 resize-y bg-panel`} value={mission} onChange={(event) => setMission(event.target.value)} />
        </Field>
        <Button variant="primary" className="w-full" disabled={busy} onClick={() => void saveProfile()}>
          {busy ? "Saving…" : "Save profile"}
        </Button>
      </section>

      <section className="rounded-2xl border border-line bg-ink p-4">
        <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Model</p>
        <ModelPicker
          runtime={runtime}
          coworker={coworker}
          value={coworker.model}
          modelVariant={coworker.modelVariant}
          onChange={(selection) => void updateModel(selection)}
          compact
        />
        <p className="mt-2 text-xs leading-relaxed text-mist">This model and reasoning preference stays with {coworker.name}.</p>
      </section>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <section className="rounded-2xl border border-rose/25 bg-rose/5 p-4">
        <h3 className="text-sm font-semibold text-rose">Retire coworker</h3>
        <p className="mt-1 text-xs leading-relaxed text-mist">
          Moves {coworker.name}'s identity, memory, workspace files, and local responsibilities to a Retired folder
          inside your coworkers home and removes the workspace from the roster. Nothing is deleted; you can restore
          or permanently remove it later from the Add coworker screen.
        </p>
        {confirmingRetire ? (
          <div className="mt-3 space-y-2">
            <p className="text-xs font-medium text-rose">Retire {coworker.name}?</p>
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => setConfirmingRetire(false)}>Keep coworker</Button>
              <Button variant="danger" className="flex-1" disabled={busy || !confirmArmed} onClick={() => void retire()}>
                {busy ? "Retiring…" : "Retire"}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" className="mt-3 w-full" onClick={() => setConfirmingRetire(true)}>Retire…</Button>
        )}
      </section>
    </div>
  );
}
