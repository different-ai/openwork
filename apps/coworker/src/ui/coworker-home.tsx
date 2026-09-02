import { useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type LocalResponsibility, type ProviderSyncRun, type RuntimeInfo } from "@/lib/bridge";
import { describeNow, describeOutcome, mergeRecentWork, relativeTime } from "@/lib/activity-summary";
import type { DenSession } from "@/lib/den";
import { clearAutoPicked, markAutoPicked } from "@/lib/model-choice";
import { createCoworkerThreads, recommendModel, type CoworkerActivity } from "@/lib/threads";
import { AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
import { PersonalityPicker } from "@/ui/personality-picker";
import { useWorkingSaying } from "@/ui/use-working-saying";
import { CapabilitiesPanel } from "@/ui/capabilities";
import { Button, ErrorNote, Field, IconButton, SlidersIcon, StatusDot, inputClass } from "@/ui/kit";
import { MemoryPanel } from "@/ui/memory";
import { ResponsibilitiesPanel } from "@/ui/responsibilities";
import { ThreadsPanel } from "@/ui/threads";
import { ModelPicker, type ModelSelection } from "@/ui/model-picker";
import type { SettingsSection } from "@/ui/openwork-settings";

type ContextView = "overview" | "capabilities" | "memory" | "settings";

const CONTEXT_TITLES: Record<ContextView, string> = {
  overview: "Activity",
  capabilities: "Apps & tools",
  memory: "Memory",
  settings: "Coworker settings",
};

const CONTEXT_PANEL_WIDTH_KEY = "open-coworker.context-panel-width";
const CONTEXT_PANEL_MIN_WIDTH = 320;
const CONTEXT_PANEL_MAX_WIDTH = 620;
const MAIN_WORKSPACE_MIN_WIDTH = 520;
/** The team rail beside the workspace; the thread column keeps its minimum before the panel grows. */
const RAIL_WIDTH = 272;

function clampContextPanelWidth(width: number): number {
  const available = typeof window === "undefined"
    ? CONTEXT_PANEL_MAX_WIDTH
    : Math.max(CONTEXT_PANEL_MIN_WIDTH, window.innerWidth - RAIL_WIDTH - MAIN_WORKSPACE_MIN_WIDTH);
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
  onRestartRuntime,
  onSyncProviders,
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
  /** Stop and start the local AI service; the one honest recovery when it is unavailable. */
  onRestartRuntime: () => Promise<void>;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  /** Open the global OpenWork settings, optionally on one section (account, models…). */
  onOpenOpenWork: (section?: SettingsSection) => void;
}) {
  const [contextView, setContextView] = useState<ContextView>("overview");
  const [settingsFocus, setSettingsFocus] = useState<{ id: number; section: "model" } | null>(null);
  const [assignmentDraft, setAssignmentDraft] = useState<{ id: number; text: string } | null>(null);
  const [discussionDraft, setDiscussionDraft] = useState<{ id: number; text: string } | null>(null);
  const [openThreadRequest, setOpenThreadRequest] = useState<{ id: number; threadId: string } | null>(null);
  const [contextPanelWidth, setContextPanelWidth] = useState<number | null>(readContextPanelWidth);
  const [resizingContextPanel, setResizingContextPanel] = useState(false);
  const contextPanelDrag = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null);

  const contextualPanelWidth = contextView === "capabilities" ? 430 : 360;
  const renderedContextPanelWidth = clampContextPanelWidth(contextPanelWidth ?? contextualPanelWidth);

  useEffect(() => () => onActivityChange(null), [onActivityChange]);

  // A coworker created without a model starts on a connected model that can use
  // tools, chosen as soon as the AI service answers; the choice is kept so it
  // shows in Coworker settings and can be changed there.
  useEffect(() => {
    if (coworker.model || !coworker.workspaceId || !runtime.engineManaged) return;
    let cancelled = false;
    let attempts = 0;
    let timer = 0;
    const threads = createCoworkerThreads({ serverUrl: runtime.serverUrl, workspaceId: coworker.workspaceId, token: runtime.ownerToken });
    const attempt = async () => {
      attempts += 1;
      try {
        const pick = recommendModel(await threads.listModelCatalog());
        if (cancelled) return;
        if (pick) {
          markAutoPicked(coworker.slug, pick.id);
          onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, { model: pick.id, modelVariant: "" }));
          return;
        }
      } catch {
        // The AI service may still be warming up; try again shortly.
      }
      if (!cancelled && attempts < 30) timer = window.setTimeout(() => void attempt(), 3_000);
    };
    timer = window.setTimeout(() => void attempt(), 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [coworker.model, coworker.slug, coworker.workspaceId, onCoworkerChanged, runtime.engineManaged, runtime.ownerToken, runtime.serverUrl]);

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
            {runtime.engineManaged ? (activity?.label ?? "Checking status") : "AI unavailable"}
          </span>
        </header>
        {!runtime.engineManaged ? (
          <AiUnavailableNote coworkerName={coworker.name} technical={runtime.engineError} onRestart={onRestartRuntime} />
        ) : null}
        <main className="min-h-0 flex-1 overflow-hidden">
          <ThreadsPanel
            runtime={runtime}
            session={session}
            coworker={coworker}
            onCoworkerChanged={onCoworkerChanged}
            onRefreshRuntime={onRefreshRuntime}
            onSyncProviders={onSyncProviders}
            assignmentDraft={assignmentDraft}
            discussionDraft={discussionDraft}
            openThreadRequest={openThreadRequest}
            onOpenModelSettings={() => {
              setContextView("settings");
              setSettingsFocus({ id: Date.now(), section: "model" });
            }}
            onOpenAccount={() => onOpenOpenWork("account")}
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
            <IconButton label="Back to activity" className="window-no-drag" onClick={() => setContextView("overview")}>
              <span aria-hidden="true">←</span>
            </IconButton>
          ) : null}
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-snow">{CONTEXT_TITLES[contextView]}</h2>
          {contextView === "overview" ? (
            <IconButton
              label="Coworker settings"
              className="window-no-drag"
              data-testid="coworker-settings-button"
              onClick={() => setContextView("settings")}
            >
              <SlidersIcon />
            </IconButton>
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
              onExplain={(text) => setDiscussionDraft({ id: Date.now(), text })}
              onOpenMemory={() => setContextView("memory")}
              onOpenCapabilities={() => setContextView("capabilities")}
              onOpenSettings={() => setContextView("settings")}
              onOpenOpenWork={() => onOpenOpenWork()}
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
              session={session}
              coworker={coworker}
              onCoworkerChanged={onCoworkerChanged}
              onCoworkerRemoved={onCoworkerRemoved}
              onSyncProviders={onSyncProviders}
              onOpenAccount={() => onOpenOpenWork("account")}
              onOpenMemory={() => setContextView("memory")}
              focus={settingsFocus}
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
  onExplain,
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
  /** Prefill the discussion composer with a message about a run; the person still sends it. */
  onExplain: (message: string) => void;
  onOpenMemory: () => void;
  onOpenCapabilities: () => void;
  onOpenSettings: () => void;
  onOpenOpenWork: () => void;
}) {
  const now = describeNow(activity);
  const saying = useWorkingSaying(
    coworker.personality,
    `${coworker.slug}:${activity?.threadId ?? "work"}`,
    activity?.state === "working",
  );
  const nowNote = saying ? `${saying}…` : now.note;
  const [localResponsibilities, setLocalResponsibilities] = useState<LocalResponsibility[]>([]);
  // While a run is going or waiting in line, the list follows it closely; otherwise it idles.
  const localRunsBusy = localResponsibilities.some(
    (item) => item.latestRun?.status === "running" || item.latestRun?.status === "queued",
  );

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      coworkerBridge.localResponsibilities
        .list(coworker.slug)
        .then((items) => {
          if (!cancelled) setLocalResponsibilities(items);
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => void load(), localRunsBusy ? 1_500 : 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coworker.slug, localRunsBusy]);

  const recent = mergeRecentWork(activity, localResponsibilities);
  const nowTime = relativeTime(activity?.updatedAt ?? 0);
  const canOpenSubject = Boolean(activity?.threadId);
  const statusLabel = engineManaged ? (activity?.label ?? "Checking status") : "AI unavailable";

  return (
    <div className="flex min-h-full flex-col gap-5">
      <section aria-label="Current activity" className="rounded-2xl border border-line bg-ink p-4" data-testid="coworker-activity-summary">
        <div className="flex items-center justify-between gap-3">
          <span
            data-testid="coworker-current-status"
            className={`flex min-w-0 items-center gap-2 text-sm font-semibold ${engineManaged ? activityTextTone(activity) : "text-rose"}`}
          >
            <StatusDot tone={engineManaged ? activityTone(activity) : "rose"} />
            <span className="truncate">{statusLabel}</span>
          </span>
          {nowTime && now.subject ? (
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
            data-testid="coworker-current-subject"
          >
            <span className={`line-clamp-2 block text-sm leading-snug text-snow ${canOpenSubject ? "group-hover:underline" : ""}`}>
              {now.subject}
            </span>
            {nowNote || canOpenSubject ? (
              <span className={`mt-1 block text-[11px] ${now.needsYou ? "font-medium text-amber" : "text-mist"}`}>
                {now.needsYou ? (canOpenSubject ? "Needs your reply — open to respond" : "Needs your reply") : nowNote || "Open thread"}
                {canOpenSubject ? <span aria-hidden="true"> ›</span> : null}
              </span>
            ) : null}
          </button>
        ) : engineManaged && nowNote ? (
          <p className="mt-1.5 text-xs leading-relaxed text-mist" data-testid="coworker-current-note">{nowNote}</p>
        ) : null}
      </section>

      {recent.length > 0 ? (
        <section aria-label="Recent activity" data-testid="coworker-recent-activity">
          <h3 className="mb-2 px-1 text-[11px] font-semibold text-mist">Recent</h3>
          <ul className="divide-y divide-line rounded-2xl border border-line bg-ink">
            {recent.map((entry) => {
              const outcome = describeOutcome(entry);
              const failed = entry.outcome === "failed";
              const body = (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-snow" title={entry.title}>{entry.title}</span>
                    <span className={`mt-0.5 block truncate text-[11px] ${failed ? "text-rose" : "text-mist"}`} title={entry.error || undefined}>
                      {outcome}
                      {entry.kind === "responsibility" ? " · Responsibility" : ""}
                      {failed && entry.error ? ` · ${entry.error}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-mist" title={new Date(entry.finishedAt).toLocaleString()}>
                    {relativeTime(entry.finishedAt)}
                  </span>
                  {entry.threadId ? <span className="shrink-0 text-mist transition-colors group-hover:text-snow" aria-hidden="true">›</span> : null}
                </>
              );
              return (
                <li key={entry.id}>
                  {entry.threadId ? (
                    <button
                      type="button"
                      className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-white/[0.04]"
                      onClick={() => onOpenThread(entry.threadId ?? "")}
                      title="Open this thread"
                    >
                      {body}
                    </button>
                  ) : (
                    <div className="flex w-full items-center gap-3 px-3.5 py-2.5 text-left">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section aria-label="Responsibilities" data-testid="coworker-responsibilities">
        <ResponsibilitiesPanel
          session={session}
          coworkers={coworkers}
          coworker={coworker}
          localItems={localResponsibilities}
          onLocalItemsChanged={setLocalResponsibilities}
          onCoworkerChanged={onCoworkerChanged}
          onConnect={onOpenOpenWork}
          onOpenThread={onOpenThread}
          onExplain={onExplain}
        />
      </section>

      <nav aria-label="More for this coworker" className="mt-auto flex items-center justify-between gap-1 border-t border-line pt-3 text-[11px]">
        <QuietLink onClick={onOpenCapabilities}>Apps & tools</QuietLink>
        <QuietLink onClick={onOpenMemory}>Memory</QuietLink>
        <QuietLink onClick={onOpenSettings}>Coworker settings</QuietLink>
      </nav>
    </div>
  );
}

function QuietLink({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded-lg px-2 py-1.5 font-medium text-mist transition-colors hover:bg-white/5 hover:text-snow focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-spark/60"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** The one place the unavailable AI service is explained; raw detail stays behind a disclosure. */
function AiUnavailableNote({
  coworkerName,
  technical,
  onRestart,
}: {
  coworkerName: string;
  technical: string;
  onRestart: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="border-b border-line px-5 py-3" data-testid="coworker-ai-unavailable">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-rose/25 bg-rose/5 px-3 py-2.5">
        <p className="min-w-0 flex-1 text-xs leading-relaxed text-snow">
          <span className="font-semibold">AI is unavailable</span>
          <span className="text-mist">, so {coworkerName} cannot work right now.</span>
        </p>
        <Button
          variant="ghost"
          className="text-xs"
          aria-busy={busy}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onRestart().finally(() => setBusy(false));
          }}
        >
          {busy ? "Restarting…" : "Restart AI"}
        </Button>
        {technical ? (
          <details className="w-full text-[11px] text-mist">
            <summary className="cursor-pointer select-none">Technical details</summary>
            <p className="mt-1 break-words font-mono">{technical}</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function CoworkerSettings({
  runtime,
  session,
  coworker,
  onCoworkerChanged,
  onCoworkerRemoved,
  onSyncProviders,
  onOpenAccount,
  onOpenMemory,
  focus,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onCoworkerRemoved: (slug: string) => void;
  onSyncProviders: () => Promise<ProviderSyncRun>;
  onOpenAccount: () => void;
  onOpenMemory: () => void;
  /** Section to bring into view on open; the id makes repeat requests distinct. */
  focus: { id: number; section: "model" } | null;
}) {
  const modelSectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus?.section === "model") modelSectionRef.current?.scrollIntoView({ block: "start" });
  }, [focus]);
  const [role, setRole] = useState(coworker.role);
  const [mission, setMission] = useState(coworker.mission);
  const [avatarColor, setAvatarColor] = useState(coworker.avatarColor);
  const [avatarGlasses, setAvatarGlasses] = useState(coworker.avatarGlasses);
  const [personality, setPersonality] = useState(coworker.personality);
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
          personality,
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
      clearAutoPicked(coworker.slug);
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
      <section ref={modelSectionRef} className="rounded-2xl border border-line bg-ink p-4" data-testid="coworker-model-settings">
        <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">AI model</h3>
        <ModelPicker
          runtime={runtime}
          session={session}
          coworker={coworker}
          value={coworker.model}
          modelVariant={coworker.modelVariant}
          onChange={(selection) => void updateModel(selection)}
          onSyncProviders={onSyncProviders}
          onConnect={onOpenAccount}
          compact
        />
        <p className="mt-2 text-xs leading-relaxed text-mist">{coworker.name} uses this AI model and thinking effort for every discussion, assignment, and responsibility.</p>
      </section>

      <section className="space-y-3 rounded-2xl border border-line bg-ink p-4">
        <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Profile</h3>
        <div className="flex items-center gap-4">
          <div className="avatar-stage flex size-24 shrink-0 items-center justify-center rounded-2xl border border-line">
            <CoworkerAvatar
              animated
              color={avatarColor}
              glasses={avatarGlasses}
              name={coworker.name}
              size={72}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Field label="Name">
              <input className={`${inputClass} bg-panel`} value={coworker.name} disabled />
            </Field>
          </div>
        </div>
        <AvatarControls
          color={avatarColor}
          glasses={avatarGlasses}
          onColorChange={setAvatarColor}
          onGlassesChange={setAvatarGlasses}
        />
        <Field label="Role">
          <input className={`${inputClass} bg-panel`} value={role} onChange={(event) => setRole(event.target.value)} />
        </Field>
        <Field label="Mission">
          <textarea className={`${inputClass} min-h-20 resize-y bg-panel`} value={mission} onChange={(event) => setMission(event.target.value)} />
        </Field>
        <PersonalityPicker value={personality} seed={coworker.slug} onChange={setPersonality} />
        <Button variant="primary" className="w-full" disabled={busy} onClick={() => void saveProfile()}>
          {busy ? "Saving…" : "Save profile"}
        </Button>
      </section>

      <section className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-ink px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.14em] text-mist">Memory</h3>
          <p className="mt-1 text-xs leading-relaxed text-mist">Plain Markdown files {coworker.name} maintains; read or edit them any time.</p>
        </div>
        <Button variant="ghost" className="shrink-0 text-xs" onClick={onOpenMemory}>Open memory</Button>
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
