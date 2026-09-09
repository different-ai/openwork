import { useEffect, useEffectEvent, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { relativeTime } from "@/lib/activity-summary";
import { workerTurnsFor } from "@/lib/effort";
import {
  describeLifespan,
  describeWorkerStatus,
  isLiveWorker,
  lifespanFromChoice,
  workerTone,
  type LifespanChoice,
  type WorkerSummary,
  type WorkerPurpose,
} from "@/lib/workers";
import { Button, ErrorNote, StatusDot, inputClass } from "@/ui/kit";
import { WorkerDetail } from "@/ui/worker-detail";

type WorkersPanelProps = {
  coworker: CoworkerSummary;
  threadId?: string;
  compact?: boolean;
  onOpenThread?: (threadId: string) => void;
  onOpenComputer?: () => void;
  onOpenBrowser?: () => void;
};

/** The shelf and Activity share controls, but never borrow another discussion's tasks. */
export function WorkersPanel({ coworker, threadId = coworker.conversationThreadId, ...props }: WorkersPanelProps) {
  return <WorkerList key={`${coworker.slug}:${threadId}`} coworker={coworker} threadId={threadId} {...props} />;
}

function WorkerList({ coworker, threadId, compact = false, onOpenThread, onOpenComputer, onOpenBrowser }: WorkersPanelProps & { threadId: string }) {
  const [workers, setWorkers] = useState<WorkerSummary[] | null>(null);
  const [expandedId, setExpandedId] = useState("");
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState("");
  const request = useRef(0);
  const reading = useRef(false);
  const live = (workers ?? []).some(isLiveWorker);

  async function refresh(): Promise<void> {
    if (reading.current) return;
    reading.current = true;
    const version = ++request.current;
    try {
      const items = await coworkerBridge.workers.list(coworker.slug);
      if (version !== request.current) return;
      setWorkers(items.filter((worker) => worker.slug === coworker.slug && worker.spawnedFromThreadId === threadId));
      setError("");
    } catch (cause) {
      if (version === request.current) setError(`Task updates unavailable. Last known tasks are kept. ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally { reading.current = false; }
  }
  const readLatest = useEffectEvent(refresh);
  useEffect(() => {
    void readLatest();
    const timer = window.setInterval(() => void readLatest(), live ? 2_000 : 6_000);
    return () => {
      request.current += 1;
      window.clearInterval(timer);
    };
  }, [live]);

  function changed(worker: WorkerSummary) {
    if (worker.slug !== coworker.slug || worker.spawnedFromThreadId !== threadId) return;
    // A list read begun before a confirmed action must not overwrite that action.
    request.current += 1;
    setWorkers((current) => current?.some((item) => item.id === worker.id) ? current.map((item) => item.id === worker.id ? worker : item) : [worker, ...(current ?? [])]);
  }

  const items = workers ?? [];
  const needsApproval = items.filter((worker) => isLiveWorker(worker) && worker.control?.state === "needs-approval").length;
  if (compact && items.length === 0 && !error && !creating) return null;

  return (
    <div className={compact ? "mx-5 mt-2 flex max-h-[32dvh] min-h-0 shrink flex-col rounded-xl border border-line bg-panel/60 px-3 py-1" : "flex min-h-full flex-col gap-5"} data-testid={compact ? "coworker-worker-shelf" : "coworker-workers"} data-origin-thread={threadId}>
      <section className={compact ? "flex min-h-0 flex-col" : ""} aria-label={compact ? "Work beside this conversation" : "Workers in this discussion"}>
        <div className="mb-1 flex shrink-0 items-center justify-between px-1">
          {compact ? <button type="button" className="min-w-0 py-2 text-left text-xs text-snow focus-visible:outline-spark" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            Work beside chat · {items.length}{needsApproval > 0 ? <span className="ml-2 text-amber">{needsApproval} needs approval</span> : null}<span aria-hidden="true" className="ml-2 text-mist">{open ? "−" : "+"}</span>
          </button> : <h3 className="text-[11px] font-semibold text-mist">Workers in this discussion</h3>}
          {!creating ? (
            <Button variant="ghost" className="shrink-0 px-2 text-xs" onClick={() => { setCreating(true); setOpen(true); }} data-testid="new-worker-button">New Worker</Button>
          ) : null}
        </div>
        {error ? <div className="mb-2"><p role="alert" className="text-xs text-amber">{error}</p><Button variant="ghost" className="text-xs" onClick={() => void refresh()}>Check tasks</Button></div> : null}
        <div hidden={!open} className={compact ? "min-h-0 overflow-y-auto overscroll-contain" : ""}>
        {creating ? (
          <NewWorker
            coworker={coworker}
            threadId={threadId}
            onCancel={() => setCreating(false)}
            onCreated={async (worker) => {
              changed(worker);
              setCreating(false);
              setExpandedId(worker.id);
            }}
          />
        ) : null}
        {workers !== null && items.length === 0 && !creating ? (
          <p className="px-1 py-2 text-xs leading-relaxed text-mist" data-testid="workers-empty">
            No Workers in this discussion. Ask {coworker.name} to delegate a task, or start one here.
          </p>
        ) : null}
        {items.length > 0 ? (
          <ul className="divide-y divide-line" data-testid="worker-list">
            {items.map((worker) => {
              const expanded = expandedId === worker.id;
              return (
                <li key={worker.id} data-testid="worker-row" data-status={worker.status} data-expanded={expanded ? "true" : "false"}>
                  <button
                    type="button"
                    className="flex w-full items-start gap-3 px-1 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
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
                      {worker.control ? <span className={`mt-0.5 block text-[11px] ${worker.control.state === "approved" ? "text-mist" : "text-amber"}`}>{worker.control.surface === "browser" ? "Discussion browser" : "This Mac"} · {worker.control.state === "approved" ? "Task access approved" : worker.control.state === "revoked" ? "Access revoked" : "Review access request"}</span> : null}
                      {!compact ? <span className="mt-0.5 block truncate text-[11px] text-mist" data-testid="worker-model">
                        {worker.purpose === "thinking" ? "Deep thinking" : "Delivery"} · {worker.modelSnapshot ? `${worker.modelSnapshot.providerId}/${worker.modelSnapshot.modelId} · ${worker.modelSnapshot.variant || "model default"} effort` : "Coworker model (legacy)"}
                      </span> : null}
                    </span>
                    <span className="shrink-0 text-mist" aria-hidden="true">{expanded ? "▾" : "›"}</span>
                  </button>
                  {expanded ? (
                    <WorkerDetail key={worker.id} coworker={coworker} initialWorker={worker} onChanged={changed} onOpenThread={onOpenThread} onOpenComputer={onOpenComputer} onOpenBrowser={onOpenBrowser} />
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
        </div>
      </section>
    </div>
  );
}

/** A person can explicitly choose until stopped; defaults always have a turn limit. */
function NewWorker({
  coworker,
  threadId,
  onCancel,
  onCreated,
}: {
  coworker: CoworkerSummary;
  threadId: string;
  onCancel: () => void;
  onCreated: (worker: WorkerSummary) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [purpose, setPurpose] = useState<WorkerPurpose>("delivery");
  const [control, setControl] = useState<"" | "browser" | "computer">("");
  const [kind, setKind] = useState<LifespanChoice["kind"]>("turns");
  const [turns, setTurns] = useState(String(workerTurnsFor(coworker.effortPreference)));
  const [until, setUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  const starting = useRef(false);
  useEffect(() => () => { request.current += 1; }, []);

  async function start(): Promise<void> {
    if (starting.current) return;
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
    starting.current = true;
    const version = ++request.current;
    setBusy(true);
    setError("");
    try {
      const worker = await coworkerBridge.workers.spawn(coworker.slug, {
        name: name.trim(),
        goal: goal.trim(),
        purpose,
        lifespan: resolved.lifespan,
        spawnedFromThreadId: threadId,
        ...(threadId && control ? { control } : {}),
      });
      if (version !== request.current) return;
      await onCreated(worker);
    } catch (cause) {
      if (version === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (version === request.current) { starting.current = false; setBusy(false); }
    }
  }

  const choiceClass = (active: boolean) => `rounded-md px-2 py-1.5 text-[11px] font-medium ${active ? "bg-white/8 text-snow" : "text-mist hover:text-snow"}`;

  return (
    <div className="mb-3 space-y-3 border-y border-line px-1 py-3" data-testid="new-worker">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold text-snow">New Worker</p>
        <Button variant="ghost" className="px-2 text-xs" onClick={onCancel}>Cancel</Button>
      </div>
      <div className="flex rounded-lg border border-line bg-panel/60 p-0.5" role="radiogroup" aria-label="Worker purpose">
        <button type="button" role="radio" aria-checked={purpose === "delivery"} className={`flex-1 ${choiceClass(purpose === "delivery")}`} onClick={() => { setPurpose("delivery"); setTurns(String(workerTurnsFor(coworker.effortPreference))); }}>Delivery</button>
        <button type="button" role="radio" aria-checked={purpose === "thinking"} className={`flex-1 ${choiceClass(purpose === "thinking")}`} onClick={() => { setPurpose("thinking"); setTurns("2"); }}>Deep thinking</button>
      </div>
      <p className="break-words text-[11px] text-mist" data-testid="new-worker-model">
        {purpose === "thinking" ? "Decision, constraints, acceptance criteria, and open risks." : "Deliver from a brief and file references; return evidence."} Model: {(purpose === "thinking" ? coworker.thinkingModel : coworker.deliveryModel) || coworker.model || "Native default (resolved when started)"}. Pinned when started; no automatic fallback.
      </p>
      <input className={inputClass} placeholder="Name, e.g. Market scan" aria-label="Worker name" value={name} onChange={(event) => setName(event.target.value)} data-testid="new-worker-name" />
      <textarea
        className={`${inputClass} min-h-[72px] resize-y`}
        placeholder={`Goal, acceptance criteria, and file references. ${coworker.name} receives the result.`}
        aria-label="Worker goal"
        value={goal}
        onChange={(event) => setGoal(event.target.value)}
        data-testid="new-worker-goal"
      />
      {threadId ? <label className="block space-y-1.5 text-xs text-mist">
        <span>Browser or Mac app access</span>
        <select className={`${inputClass} bg-panel text-xs`} aria-label="Worker control request" data-testid="new-worker-control" disabled={busy} value={control} onChange={(event) => {
          const value = event.target.value;
          if (value === "" || value === "browser" || value === "computer") setControl(value);
        }}>
          <option value="">None requested</option>
          <option value="browser">Request this discussion's browser</option>
          <option value="computer">Request Mac app control</option>
        </select>
        {control ? <span className="block text-[11px]">{control === "browser" ? "Uses existing discussion tabs and Coworker's shared local logins, not a separate account." : "Uses this Mac, not a remote computer. Requires discussion allowance and native app/window approval."} Creating the Worker only requests access. It stays paused until you review and approve the named task.</span> : <span className="block text-[11px]">Existing files and connected tools stay available. No browser or computer permission is granted here.</span>}
      </label> : null}
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
        {busy ? "Creating..." : control ? "Create Worker for review" : "Start Worker"}
      </Button>
    </div>
  );
}
