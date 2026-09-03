import { useEffect, useState } from "react";
import { coworkerBridge, type CoworkerSummary, type LocalResponsibility } from "@/lib/bridge";
import { relativeTime } from "@/lib/activity-summary";
import type { DenSession } from "@/lib/den";
import type { ThreadListItem } from "@/lib/threads";
import { ResponsibilitiesPanel } from "@/ui/responsibilities";
import {
  describeLifespan,
  describeWorkerEvent,
  describeWorkerStatus,
  isLiveWorker,
  lifespanFromChoice,
  workerTone,
  type LifespanChoice,
  type WorkerEvent,
  type WorkerSummary,
} from "@/lib/workers";
import { Button, ErrorNote, StatusDot, inputClass } from "@/ui/kit";

/** One-off assignments shown in the panel: the newest few; the conversation column's Assignments view has them all. */
const ASSIGNMENT_ROWS = 6;

/** Findings shown newest first; older ones stay in the file. */
const TIMELINE_LIMIT = 40;

/**
 * The Workers view: what a coworker's Workers are doing, one flat row each,
 * opening into the findings they posted and the few things a person does with
 * a Worker — steer it, pause or resume it, stop it, or open its own work.
 * Starting one here is the same as asking the coworker to; both land in the
 * same list. Below the Workers, the coworker's Assignments: the one-off ones
 * handed over from a discussion and the ones on a schedule, in one list.
 */
export function WorkersPanel({
  session,
  coworkers,
  coworker,
  assignments,
  onCoworkerChanged,
  onConnect,
  onOpenThread,
  onExplain,
}: {
  session: DenSession | null;
  coworkers: CoworkerSummary[];
  coworker: CoworkerSummary;
  /** The coworker's one-off assignment threads, newest first. */
  assignments: ThreadListItem[];
  onCoworkerChanged: (coworker: CoworkerSummary) => void;
  /** Start the OpenWork sign-in flow (for assignments that run in OpenWork Cloud). */
  onConnect: () => void;
  /** Show a Worker's own work or an assignment in the main column. */
  onOpenThread: (threadId: string) => void;
  /** Prefill the discussion composer with a message about a run; the person still sends it. */
  onExplain: (message: string) => void;
}) {
  const [workers, setWorkers] = useState<WorkerSummary[] | null>(null);
  const [expandedId, setExpandedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [scheduled, setScheduled] = useState<LocalResponsibility[]>([]);
  const live = (workers ?? []).some(isLiveWorker);
  const scheduledBusy = scheduled.some((item) => item.latestRun?.status === "running" || item.latestRun?.status === "queued");

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      coworkerBridge.localResponsibilities
        .list(coworker.slug)
        .then((items) => {
          if (!cancelled) setScheduled(items);
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => void load(), scheduledBusy ? 1_500 : 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coworker.slug, scheduledBusy]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      coworkerBridge.workers
        .list(coworker.slug)
        .then((items) => {
          if (!cancelled) setWorkers(items);
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
        });
    void load();
    // While a Worker is going, the list follows it closely; otherwise it idles.
    const timer = window.setInterval(() => void load(), live ? 2_000 : 6_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [coworker.slug, live]);

  useEffect(() => {
    setExpandedId("");
    setCreating(false);
    setError("");
  }, [coworker.slug]);

  async function refresh(): Promise<void> {
    try {
      setWorkers(await coworkerBridge.workers.list(coworker.slug));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const items = workers ?? [];
  // A scheduled assignment's runs are native threads too; they are listed once, under their schedule.
  const runThreads = new Set(scheduled.flatMap((item) => item.runs.map((run) => run.threadId).filter(Boolean)));
  const onceOnly = assignments.filter((item) => !runThreads.has(item.id));

  return (
    <div className="flex min-h-full flex-col gap-5" data-testid="coworker-workers">
      <section aria-label="Workers">
        <div className="mb-2 flex items-center justify-between px-1">
          <h3 className="text-[11px] font-semibold text-mist">Workers</h3>
          {items.length > 0 && !creating ? (
            <Button variant="ghost" className="px-2 text-xs" onClick={() => setCreating(true)} data-testid="new-worker-button">New Worker</Button>
          ) : null}
        </div>
        {error ? <div className="mb-2"><ErrorNote>{error}</ErrorNote></div> : null}
        {creating ? (
          <NewWorker
            coworker={coworker}
            onCancel={() => setCreating(false)}
            onCreated={async (worker) => {
              setCreating(false);
              setExpandedId(worker.id);
              await refresh();
            }}
          />
        ) : null}
        {workers !== null && items.length === 0 && !creating ? (
          <div className="rounded-2xl border border-dashed border-line px-3.5 py-4 text-center" data-testid="workers-empty">
            <p className="text-xs text-mist">No Workers running. Ask {coworker.name} to start one, or start one here.</p>
            <Button variant="ghost" className="mt-2 text-xs" onClick={() => setCreating(true)} data-testid="new-worker-button">New Worker</Button>
          </div>
        ) : null}
        {items.length > 0 ? (
          <ul className="divide-y divide-line rounded-2xl border border-line bg-ink" data-testid="worker-list">
            {items.map((worker) => {
              const expanded = expandedId === worker.id;
              return (
                <li key={worker.id} data-testid="worker-row" data-status={worker.status} data-expanded={expanded ? "true" : "false"}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
                    onClick={() => setExpandedId(expanded ? "" : worker.id)}
                    aria-expanded={expanded}
                    data-testid="worker-toggle"
                  >
                    <span className="mt-1.5 shrink-0"><StatusDot tone={workerTone(worker)} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-snow" data-testid="worker-name">{worker.name}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-mist" title={worker.goal}>{worker.goal}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-mist" data-testid="worker-line">
                        {describeWorkerStatus(worker)}
                        {isLiveWorker(worker) ? ` · ${describeLifespan(worker.lifespan)}` : ""}
                        {worker.lastFindingAt ? ` · Last update ${relativeTime(worker.lastFindingAt) || "now"} ago` : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-mist" aria-hidden="true">{expanded ? "▾" : "›"}</span>
                  </button>
                  {expanded ? (
                    <WorkerDetail coworker={coworker} worker={worker} onChanged={refresh} onOpenThread={onOpenThread} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>

      <section aria-label="Assignments" data-testid="coworker-assignments">
        <h3 className="mb-2 px-1 text-[11px] font-semibold text-mist">Assignments</h3>
        {onceOnly.length > 0 ? (
          <ul className="mb-3 divide-y divide-line rounded-2xl border border-line bg-ink" data-testid="assignment-list">
            {onceOnly.slice(0, ASSIGNMENT_ROWS).map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-white/[0.04]"
                  onClick={() => onOpenThread(item.id)}
                  title="Open this assignment"
                  data-testid="assignment-row"
                >
                  <StatusDot tone={item.status === "busy" ? "spark" : item.status === "retry" ? "amber" : "mint"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs text-snow" title={item.title}>{item.title}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-mist">
                      Once · {item.status === "busy" ? "Working on it" : item.status === "retry" ? "Retrying" : `Done ${relativeTime(item.updatedAt) || "now"} ago`}
                    </span>
                  </span>
                  <span className="shrink-0 text-mist transition-colors group-hover:text-snow" aria-hidden="true">›</span>
                </button>
              </li>
            ))}
            {onceOnly.length > ASSIGNMENT_ROWS ? (
              <li className="px-3.5 py-2 text-[11px] text-mist">{onceOnly.length - ASSIGNMENT_ROWS} more in the conversation's Assignments list.</li>
            ) : null}
          </ul>
        ) : null}
        <ResponsibilitiesPanel
          session={session}
          coworkers={coworkers}
          coworker={coworker}
          localItems={scheduled}
          onLocalItemsChanged={setScheduled}
          onCoworkerChanged={onCoworkerChanged}
          onConnect={onConnect}
          onOpenThread={onOpenThread}
          onExplain={onExplain}
        />
      </section>
    </div>
  );
}

/** What one Worker has said and done, newest first, with the few actions a person takes. */
function WorkerDetail({
  coworker,
  worker,
  onChanged,
  onOpenThread,
}: {
  coworker: CoworkerSummary;
  worker: WorkerSummary;
  onChanged: () => Promise<void>;
  onOpenThread: (threadId: string) => void;
}) {
  const [events, setEvents] = useState<WorkerEvent[]>([]);
  const [steer, setSteer] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const alive = isLiveWorker(worker);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      coworkerBridge.workers
        .findings(coworker.slug, worker.id, TIMELINE_LIMIT)
        .then((items) => {
          if (!cancelled) setEvents(items);
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(() => void load(), alive ? 2_000 : 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [alive, coworker.slug, worker.id, worker.updatedAt]);

  async function act(label: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(label);
    setError("");
    try {
      await action();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy("");
    }
  }

  const newestFirst = [...events].reverse();

  return (
    <div className="border-t border-line/70 bg-panel/40 px-3.5 py-3 text-[11px] leading-relaxed" data-testid="worker-detail">
      {alive ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const text = steer.trim();
            if (!text) return;
            void act("steer", async () => {
              await coworkerBridge.workers.steer(coworker.slug, worker.id, text);
              setSteer("");
            });
          }}
        >
          <input
            className={`${inputClass} py-1.5 text-xs`}
            placeholder={worker.status === "waiting" && worker.waitingFor === "decision" ? "Your decision…" : `Steer ${worker.name}…`}
            aria-label={`Steer ${worker.name}`}
            value={steer}
            onChange={(event) => setSteer(event.target.value)}
            data-testid="worker-steer-input"
          />
          <Button variant="primary" className="shrink-0 text-xs" type="submit" disabled={!steer.trim() || busy === "steer"} aria-busy={busy === "steer"} data-testid="worker-steer-send">
            Steer
          </Button>
        </form>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-1">
        {alive && worker.status !== "paused" ? (
          <Button variant="ghost" className="px-2 text-xs" disabled={busy !== ""} onClick={() => void act("pause", () => coworkerBridge.workers.pause(coworker.slug, worker.id))} data-testid="worker-pause">Pause</Button>
        ) : null}
        {worker.status === "paused" ? (
          <Button variant="ghost" className="px-2 text-xs" disabled={busy !== ""} onClick={() => void act("resume", () => coworkerBridge.workers.resume(coworker.slug, worker.id))} data-testid="worker-resume">Resume</Button>
        ) : null}
        {alive ? (
          <Button variant="ghost" className="px-2 text-xs text-rose" disabled={busy !== ""} onClick={() => void act("stop", () => coworkerBridge.workers.cancel(coworker.slug, worker.id))} data-testid="worker-stop">Stop</Button>
        ) : null}
        {worker.threadId ? (
          <Button variant="ghost" className="px-2 text-xs" onClick={() => onOpenThread(worker.threadId)} data-testid="worker-open-work">Open its work</Button>
        ) : null}
        <span className="ml-auto text-mist/80">
          {worker.spawnedBy === "coworker" ? `Started by ${coworker.name}` : "Started by you"} · {relativeTime(worker.createdAt) || "now"} ago
        </span>
      </div>
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      {worker.error && worker.status === "failed" ? <p className="mt-2 text-rose" data-testid="worker-error">{worker.error}</p> : null}
      <ol className="mt-3 space-y-2 border-l border-line pl-3" data-testid="worker-timeline">
        {newestFirst.length === 0 ? <li className="text-mist">Nothing reported yet.</li> : null}
        {newestFirst.map((event) => {
          const line = describeWorkerEvent(event, coworker.name);
          return (
            <li key={event.id} data-testid="worker-event" data-kind={event.kind} className={line.quiet ? "text-mist" : "text-snow/90"}>
              <span className="mr-2 text-mist/70" title={new Date(event.at).toLocaleString()}>{relativeTime(event.at) || "now"}</span>
              {line.label ? <span className={`mr-1 font-semibold ${line.label === "Needs a decision" ? "text-amber" : line.quiet ? "text-mist" : "text-snow"}`}>{line.label}</span> : null}
              <span className="whitespace-pre-wrap">{line.text}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const TURNS_DEFAULT = "10";

/** Name, goal, and how long it lives; the main process refuses anything unbounded or over the cap. */
function NewWorker({
  coworker,
  onCancel,
  onCreated,
}: {
  coworker: CoworkerSummary;
  onCancel: () => void;
  onCreated: (worker: WorkerSummary) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [kind, setKind] = useState<LifespanChoice["kind"]>("turns");
  const [turns, setTurns] = useState(TURNS_DEFAULT);
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start(): Promise<void> {
    const choice: LifespanChoice = kind === "turns" ? { kind, turns } : kind === "until" ? { kind, at: until } : { kind };
    const resolved = lifespanFromChoice(choice);
    if ("error" in resolved) {
      setError(resolved.error);
      return;
    }
    if (!name.trim()) {
      setError("Give the Worker a name.");
      return;
    }
    if (!goal.trim()) {
      setError("Say what the Worker should work toward.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const worker = await coworkerBridge.workers.spawn(coworker.slug, {
        name: name.trim(),
        goal: goal.trim(),
        lifespan: resolved.lifespan,
        spawnedFromThreadId: coworker.conversationThreadId,
      });
      await onCreated(worker);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const choiceClass = (active: boolean) => `rounded-md px-2 py-1.5 text-[11px] font-medium ${active ? "bg-white/8 text-snow" : "text-mist hover:text-snow"}`;

  return (
    <div className="mb-3 space-y-3 rounded-2xl border border-line bg-ink p-3" data-testid="new-worker">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-snow">New Worker</p>
        <Button variant="ghost" className="px-2 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
      <input className={inputClass} placeholder="Name, e.g. Market scan" aria-label="Worker name" value={name} onChange={(event) => setName(event.target.value)} data-testid="new-worker-name" />
      <textarea
        className={`${inputClass} min-h-[72px] resize-y`}
        placeholder={`What should it work toward? ${coworker.name} will hear about every update.`}
        aria-label="Worker goal"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        data-testid="new-worker-goal"
      />
      <div className="grid grid-cols-3 rounded-lg border border-line bg-panel/60 p-0.5" role="radiogroup" aria-label="How long it works">
        <button type="button" role="radio" aria-checked={kind === "turns"} className={choiceClass(kind === "turns")} onClick={() => setKind("turns")}>Number of turns</button>
        <button type="button" role="radio" aria-checked={kind === "until"} className={choiceClass(kind === "until")} onClick={() => setKind("until")}>Until a time</button>
        <button type="button" role="radio" aria-checked={kind === "open"} className={choiceClass(kind === "open")} onClick={() => setKind("open")}>Until stopped</button>
      </div>
      {kind === "turns" ? (
        <label className="flex items-center gap-2 text-[11px] text-mist">
          <span>Turns</span>
          <input type="number" min={1} max={100} className={`${inputClass} w-24 py-1.5 text-xs`} value={turns} onChange={(event) => setTurns(event.target.value)} data-testid="new-worker-turns" />
          <span>Each turn is one bounded step; it reports after each.</span>
        </label>
      ) : null}
      {kind === "until" ? (
        <label className="flex items-center gap-2 text-[11px] text-mist">
          <span>Stop at</span>
          <input type="datetime-local" className={`${inputClass} w-auto py-1.5 text-xs`} value={until} onChange={(event) => setUntil(event.target.value)} data-testid="new-worker-until" />
        </label>
      ) : null}
      {kind === "open" ? <p className="text-[11px] text-mist">It keeps working until you or {coworker.name} stop it.</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button variant="primary" className="w-full text-xs" disabled={busy} aria-busy={busy} onClick={() => void start()} data-testid="new-worker-start">
        {busy ? "Starting…" : "Start Worker"}
      </Button>
    </div>
  );
}
