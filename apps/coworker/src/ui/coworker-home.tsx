import { useEffect, useMemo, useRef, useState } from "react";
import { coworkerBridge, type CoworkerMemoryFile, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import { describeMemory, describeModelPreference, describeNow, relativeTime } from "@/lib/activity-summary";
import type { DenSession } from "@/lib/den";
import type { CoworkerActivity } from "@/lib/threads";
import { AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
import { CapabilitiesPanel } from "@/ui/capabilities";
import { Button, ErrorNote, Field, StatusDot, inputClass } from "@/ui/kit";
import { MemoryPanel } from "@/ui/memory";
import { ResponsibilitiesPanel } from "@/ui/responsibilities";
import { ThreadsPanel } from "@/ui/threads";
import { ModelPicker, type ModelSelection } from "@/ui/model-picker";

type ContextView = "overview" | "capabilities" | "memory" | "settings";

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

export function CoworkerHome({
  runtime,
  session,
  coworkers,
  coworker,
  activity,
  onActivityChange,
  onCoworkerChanged,
  onCoworkerRemoved,
  onRefreshRuntime,
  onOpenOpenWork,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  activity?: CoworkerActivity;
  onActivityChange: (activity: CoworkerActivity | null) => void;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onCoworkerRemoved: (slug: string) => void;
  onRefreshRuntime: () => Promise<void>;
  onOpenOpenWork: () => void;
}) {
  const [contextView, setContextView] = useState<ContextView>("overview");
  const [assignmentDraft, setAssignmentDraft] = useState<{ id: number; text: string } | null>(null);
  const [openThreadRequest, setOpenThreadRequest] = useState<{ id: number; threadId: string } | null>(null);
  const [contextPanelWidth, setContextPanelWidth] = useState<number | null>(readContextPanelWidth);
  const [resizingContextPanel, setResizingContextPanel] = useState(false);
  const contextPanelDrag = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null);

  const contextualPanelWidth = contextView === "capabilities" ? 430 : 360;
  const renderedContextPanelWidth = clampContextPanelWidth(contextPanelWidth ?? contextualPanelWidth);

  useEffect(() => () => onActivityChange(null), [onActivityChange]);

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
          <span data-testid="coworker-top-status" className={`flex shrink-0 items-center gap-2 text-xs ${runtime.engineManaged ? activityTextTone(activity) : "text-rose"}`} title={activity?.detail}>
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
            openThreadRequest={openThreadRequest}
            onOpenSettings={() => setContextView("settings")}
            onActivityChange={onActivityChange}
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
                  : "Activity"}
            </h2>
            <p className="truncate text-xs text-mist">
              {contextView === "overview"
                ? `${coworker.name}'s current and recent work`
                : contextView === "capabilities"
                  ? `Available to ${coworker.name}`
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
              engineManaged={runtime.engineManaged}
              onCoworkerChanged={onCoworkerChanged}
              onOpenThread={(threadId) => setOpenThreadRequest({ id: Date.now(), threadId })}
              onOpenMemory={() => setContextView("memory")}
              onOpenCapabilities={() => setContextView("capabilities")}
              onOpenSettings={() => setContextView("settings")}
              onOpenOpenWork={onOpenOpenWork}
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
  engineManaged,
  onCoworkerChanged,
  onOpenThread,
  onOpenMemory,
  onOpenCapabilities,
  onOpenSettings,
  onOpenOpenWork,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  activity?: CoworkerActivity;
  engineManaged: boolean;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onOpenThread: (threadId: string) => void;
  onOpenMemory: () => void;
  onOpenCapabilities: () => void;
  onOpenSettings: () => void;
  onOpenOpenWork: () => void;
}) {
  const now = describeNow(activity);
  const model = describeModelPreference(coworker);
  const [memoryFiles, setMemoryFiles] = useState<CoworkerMemoryFile[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      coworkerBridge.files
        .list(coworker.slug)
        .then((files) => {
          if (!cancelled) setMemoryFiles(files);
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coworker.slug]);

  const memory = describeMemory(memoryFiles);
  const nowTime = relativeTime(activity?.updatedAt ?? 0);
  const canOpenSubject = Boolean(activity?.threadId);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-ink p-4" data-testid="coworker-activity-summary">
        <div className="flex items-center justify-between gap-3">
          <span className={`flex min-w-0 items-center gap-2 text-sm font-semibold ${engineManaged ? activityTextTone(activity) : "text-rose"}`}>
            <StatusDot tone={engineManaged ? activityTone(activity) : "rose"} />
            <span className="truncate">{engineManaged ? (activity?.label ?? "Checking status") : "Engine offline"}</span>
          </span>
          {nowTime ? (
            <span className="shrink-0 text-[11px] text-mist" title={activity?.updatedAt ? new Date(activity.updatedAt).toLocaleString() : undefined}>
              {nowTime}
            </span>
          ) : null}
        </div>

        {now.subject ? (
          <button
            type="button"
            className={`mt-2.5 block w-full text-left ${canOpenSubject ? "group" : "cursor-default"}`}
            disabled={!canOpenSubject}
            onClick={() => {
              if (activity?.threadId) onOpenThread(activity.threadId);
            }}
            title={canOpenSubject ? "Open this thread" : undefined}
          >
            <span className={`line-clamp-2 block text-sm leading-snug text-snow ${canOpenSubject ? "group-hover:underline" : ""}`}>
              {now.subject}
            </span>
            <span className="mt-1 block text-[11px] text-mist">
              {now.note}
              {canOpenSubject ? <span aria-hidden="true"> ›</span> : null}
            </span>
          </button>
        ) : (
          <p className="mt-2.5 text-xs leading-relaxed text-mist">{engineManaged ? now.note : "Start the local agent engine to see activity."}</p>
        )}

        {now.previous ? (
          <div className="mt-3 flex items-baseline gap-2 border-t border-line pt-3 text-[11px] text-mist">
            <span className="shrink-0">Before that</span>
            {now.previous.threadId ? (
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-snow/80 hover:underline"
                onClick={() => onOpenThread(now.previous?.threadId ?? "")}
                title={now.previous.title}
              >
                {now.previous.title}
              </button>
            ) : (
              <span className="min-w-0 flex-1 truncate text-snow/80" title={now.previous.title}>{now.previous.title}</span>
            )}
            <span className="shrink-0">{relativeTime(now.previous.updatedAt)}</span>
          </div>
        ) : null}
      </section>

      <section className="divide-y divide-line rounded-2xl border border-line bg-ink" aria-label="Setup at a glance">
        <FactRow label="Model" value={model.value} hint={model.hint} onClick={onOpenSettings} />
        <FactRow label="Memory" value={memory.value} hint={memory.hint} onClick={onOpenMemory} />
        <FactRow label="Apps & tools" value="MCP apps and tools" hint="Available in this workspace" onClick={onOpenCapabilities} />
        <FactRow
          label="Mission"
          value={coworker.mission || "Not set"}
          hint={coworker.mission ? "" : "Give this coworker something to own"}
          multiline
          onClick={onOpenSettings}
        />
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
    </div>
  );
}

/** One compact, clickable fact: label on the left, value (and optional hint) on the right. */
function FactRow({
  label,
  value,
  hint = "",
  multiline = false,
  onClick,
}: {
  label: string;
  value: string;
  hint?: string;
  multiline?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="group flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-white/[0.04]"
      onClick={onClick}
    >
      <span className="w-[76px] shrink-0 pt-px text-[11px] font-medium text-mist">{label}</span>
      <span className="min-w-0 flex-1">
        <span className={`block text-xs text-snow ${multiline ? "line-clamp-2 leading-relaxed" : "truncate"}`} title={value}>
          {value}
        </span>
        {hint ? <span className="mt-0.5 block truncate text-[11px] text-mist">{hint}</span> : null}
      </span>
      <span className="shrink-0 text-mist transition-colors group-hover:text-snow" aria-hidden="true">›</span>
    </button>
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
