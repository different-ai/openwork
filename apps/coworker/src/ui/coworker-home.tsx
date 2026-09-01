import { useEffect, useMemo, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type RuntimeInfo } from "@/lib/bridge";
import type { DenSession } from "@/lib/den";
import { createCoworkerThreads, type EngineModelOption } from "@/lib/threads";
import { Button, ErrorNote, Field, StatusDot, inputClass } from "@/ui/kit";
import { MemoryPanel } from "@/ui/memory";
import { ResponsibilitiesPanel } from "@/ui/responsibilities";
import { ThreadsPanel } from "@/ui/threads";

type ContextView = "overview" | "memory" | "settings";

export function CoworkerHome({
  runtime,
  session,
  coworkers,
  coworker,
  onCoworkerChanged,
  onCoworkerRemoved,
  onRefreshRuntime,
  onConnect,
}: {
  runtime: RuntimeInfo;
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onCoworkerRemoved: (slug: string) => void;
  onRefreshRuntime: () => Promise<void>;
  onConnect: () => void;
}) {
  const [contextView, setContextView] = useState<ContextView>("overview");

  return (
    <div className="flex h-full min-w-0 flex-1 bg-ink">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-[68px] items-center justify-between gap-4 border-b border-line bg-ink px-6">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-snow">{coworker.name}</h1>
            <p className="truncate text-xs text-mist">{coworker.role || coworker.mission || "Persistent coworker"}</p>
          </div>
          <span className="flex shrink-0 items-center gap-2 text-xs text-mist">
            <StatusDot tone={runtime.engineManaged ? "mint" : "rose"} />
            {runtime.engineManaged ? "Ready" : "Engine offline"}
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

      <aside className="flex h-full w-[360px] shrink-0 flex-col border-l border-line bg-panel/70">
        <header className="flex h-[68px] items-center gap-3 border-b border-line px-4">
          {contextView !== "overview" ? (
            <Button variant="ghost" className="px-2" onClick={() => setContextView("overview")} title="Back to coworker details">
              ←
            </Button>
          ) : null}
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-snow">
              {contextView === "memory" ? "Memory" : contextView === "settings" ? "Coworker settings" : "Coworker details"}
            </h2>
            <p className="truncate text-xs text-mist">
              {contextView === "overview" ? "Context stays beside the work" : coworker.name}
            </p>
          </div>
          {contextView === "overview" ? (
            <Button variant="ghost" onClick={() => setContextView("settings")}>
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
              onCoworkerChanged={onCoworkerChanged}
              onConnect={onConnect}
              onOpenMemory={() => setContextView("memory")}
              onOpenSettings={() => setContextView("settings")}
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
        </div>
      </aside>
    </div>
  );
}

function CoworkerOverview({
  session,
  coworkers,
  coworker,
  onCoworkerChanged,
  onConnect,
  onOpenMemory,
  onOpenSettings,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  onConnect: () => void;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-line bg-ink p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-panel text-lg font-semibold text-snow ring-1 ring-line">
            {coworker.name.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-snow">{coworker.name}</h3>
            <p className="mt-0.5 text-xs text-mist">{coworker.role || "Persistent coworker"}</p>
          </div>
        </div>
        {coworker.mission ? <p className="mt-3 text-sm leading-relaxed text-snow">{coworker.mission}</p> : null}
        <button className="mt-3 text-xs font-medium text-spark hover:underline" onClick={onOpenSettings}>
          Edit role, mission, and model
        </button>
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
            <Button variant="primary" className="mt-3 w-full" onClick={onConnect}>
              Connect OpenWork
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
