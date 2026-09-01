import { useCallback, useEffect, useMemo, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { createCoworkerThreads, type CoworkerActivity, type EngineModelOption } from "@/lib/threads";
import { AvatarControls, CoworkerAvatar } from "@/ui/coworker-avatar";
import { Button, ErrorNote, Field, StatusDot, inputClass } from "@/ui/kit";
import { MemoryPanel } from "@/ui/memory";
import { ResponsibilitiesPanel } from "@/ui/responsibilities";
import { ThreadsPanel } from "@/ui/threads";

type ContextView = "overview" | "memory" | "settings" | "openwork";

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
}) {
  const [contextView, setContextView] = useState<ContextView>("overview");

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
          />
        </main>
      </div>

      <aside className="glass-context flex h-full w-[360px] shrink-0 flex-col border-l border-line">
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
                : contextView === "settings"
                  ? "Coworker settings"
                  : contextView === "openwork"
                    ? "OpenWork configuration"
                    : "Coworker details"}
            </h2>
            <p className="truncate text-xs text-mist">
              {contextView === "overview"
                ? "Context stays beside the work"
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
              onOpenSettings={() => setContextView("settings")}
              onOpenOpenWork={() => setContextView("openwork")}
            />
          ) : null}
          {contextView === "memory" ? <MemoryPanel coworker={coworker} /> : null}
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
        <footer className="window-no-drag border-t border-line bg-white/[0.018] p-3">
          <button
            className={`flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors ${
              contextView === "openwork" ? "bg-white/7" : "hover:bg-white/5"
            }`}
            onClick={() => setContextView("openwork")}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-ink">
              <StatusDot tone={runtime.engineManaged ? "mint" : "rose"} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold text-snow">OpenWork</span>
              <span className="block truncate text-[11px] text-mist">
                {session?.orgName || session?.userEmail || (runtime.engineManaged ? "Local engine connected" : "Engine unavailable")}
              </span>
            </span>
            <span className="text-[11px] font-medium text-mist">Configure ›</span>
          </button>
        </footer>
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
  onOpenSettings,
  onOpenOpenWork,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  activity?: CoworkerActivity;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onOpenMemory: () => void;
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
        {session ? (
          <ResponsibilitiesPanel
            session={session}
            coworkers={coworkers}
            coworker={coworker}
            onCoworkerChanged={onCoworkerChanged}
          />
        ) : (
          <div className="rounded-2xl border border-line bg-ink p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-snow">Responsibilities</h3>
                <p className="mt-1 text-xs leading-relaxed text-mist">
                  Connect OpenWork to schedule recurring work that continues while the app is closed.
                </p>
              </div>
            </div>
            <Button variant="ghost" className="mt-2 px-0 text-xs text-spark" onClick={onOpenOpenWork}>
              Open OpenWork configuration →
            </Button>
          </div>
        )}
      </section>

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
          })
        : null,
    [runtime.serverUrl, runtime.ownerToken, coworker.workspaceId, coworker.model],
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
  const threads = useMemo(
    () =>
      coworker.workspaceId
        ? createCoworkerThreads({
            serverUrl: runtime.serverUrl,
            workspaceId: coworker.workspaceId,
            token: runtime.ownerToken,
            model: coworker.model,
          })
        : null,
    [runtime.serverUrl, runtime.ownerToken, coworker.workspaceId, coworker.model],
  );
  const [models, setModels] = useState<EngineModelOption[]>([]);
  const [role, setRole] = useState(coworker.role);
  const [mission, setMission] = useState(coworker.mission);
  const [avatarColor, setAvatarColor] = useState(coworker.avatarColor);
  const [avatarGlasses, setAvatarGlasses] = useState(coworker.avatarGlasses);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmingRetire, setConfirmingRetire] = useState(false);
  const [confirmArmed, setConfirmArmed] = useState(false);

  useEffect(() => {
    if (!threads || !runtime.engineManaged) return;
    let cancelled = false;
    void threads
      .listModels()
      .then((options) => {
        if (!cancelled) setModels(options);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [threads, runtime.engineManaged]);

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

  async function updateModel(model: string) {
    setError("");
    try {
      onCoworkerChanged(await coworkerBridge.coworkers.update(coworker.slug, { model }));
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
        <Field label="Model">
          <select className={`${inputClass} bg-panel`} value={coworker.model} onChange={(event) => void updateModel(event.target.value)}>
            <option value="">Engine default</option>
            {coworker.model && !models.some((option) => option.id === coworker.model) ? (
              <option value={coworker.model}>{coworker.model} (unavailable)</option>
            ) : null}
            {models.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
        </Field>
        <p className="mt-2 text-xs leading-relaxed text-mist">This preference stays with {coworker.name}.</p>
      </section>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <section className="rounded-2xl border border-rose/25 bg-rose/5 p-4">
        <h3 className="text-sm font-semibold text-rose">Retire coworker</h3>
        <p className="mt-1 text-xs leading-relaxed text-mist">Deletes this coworker and its local files. OpenWork thread records remain platform-native.</p>
        {confirmingRetire ? (
          <div className="mt-3 space-y-2">
            <p className="text-xs font-medium text-rose">Delete forever?</p>
            <div className="flex gap-2">
              <Button variant="ghost" className="flex-1" disabled={busy} onClick={() => setConfirmingRetire(false)}>Keep coworker</Button>
              <Button variant="danger" className="flex-1" disabled={busy || !confirmArmed} onClick={() => void retire()}>
                {busy ? "Deleting…" : "Delete forever"}
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
