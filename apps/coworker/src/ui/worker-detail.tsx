import { useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { describeLifespan, describeWorkerEvent, describeWorkerStatus, isLiveWorker, type WorkerEvent, type WorkerSummary } from "@/lib/workers";
import { relativeTime } from "@/lib/activity-summary";
import { Button, inputClass } from "@/ui/kit";
import { useComposerDraft } from "@/ui/use-composer-draft";

/** One exact Worker, inspected without navigating away from its conversation. */
export function WorkerDetail({ coworker, initialWorker, onChanged, onOpenThread, onOpenComputer, onOpenBrowser }: {
  coworker: CoworkerSummary;
  initialWorker: WorkerSummary;
  onChanged: (worker: WorkerSummary) => void;
  onOpenThread?: (threadId: string) => void;
  onOpenComputer?: () => void;
  onOpenBrowser?: () => void;
}) {
  const [worker, setWorker] = useState(initialWorker);
  const [events, setEvents] = useState<WorkerEvent[] | null>(null);
  const [steer, setSteer] = useComposerDraft(`${coworker.slug}:${coworker.createdAt}:${initialWorker.id}:steer`);
  const [busy, setBusy] = useState("");
  const [readError, setReadError] = useState("");
  const [findingsError, setFindingsError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [verified, setVerified] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const request = useRef(0);
  const reading = useRef(false);
  const changing = useRef(false);
  const labelId = useId();
  const alive = isLiveWorker(worker);
  const control = worker.control;
  const surface = control?.surface === "browser" ? "Browser" : "This Mac";

  function accept(next: WorkerSummary) {
    if (next.id !== initialWorker.id || next.slug !== coworker.slug || next.spawnedFromThreadId !== initialWorker.spawnedFromThreadId) {
      throw new Error("This update does not belong to the selected task.");
    }
    setWorker(next);
    onChanged(next);
  }

  async function refresh() {
    if (reading.current || changing.current) return;
    reading.current = true;
    const version = ++request.current;
    setRefreshing(true);
    const [record, findings] = await Promise.allSettled([
      coworkerBridge.workers.get(coworker.slug, initialWorker.id),
      coworkerBridge.workers.findings(coworker.slug, initialWorker.id, 40),
    ]);
    reading.current = false;
    if (version !== request.current) return;
    setRefreshing(false);
    try {
      if (record.status === "rejected") throw record.reason;
      accept(record.value);
      setReadError("");
      setVerified(true);
    } catch (cause) {
      setVerified(false);
      setReadError(`Updates unavailable. Last known state is shown. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    if (findings.status === "fulfilled") { setEvents(findings.value); setFindingsError(""); }
    else setFindingsError("Findings could not refresh. Earlier updates are kept.");
  }
  const readLatest = useEffectEvent(refresh);
  useEffect(() => {
    void readLatest();
    const timer = window.setInterval(() => void readLatest(), 2_000);
    return () => { request.current += 1; window.clearInterval(timer); };
  }, []);

  async function act(label: string, action: () => Promise<WorkerSummary>, steering = "") {
    if (changing.current) return;
    changing.current = true;
    const version = ++request.current;
    setBusy(label);
    setRefreshing(false);
    setActionError("");
    setNotice("");
    try {
      const next = await action();
      if (version !== request.current) return;
      accept(next);
      setVerified(true);
      setReadError("");
      if (steering) {
        setSteer((current) => current.trim() === steering ? "" : current);
        setNotice("Steering queued for the next step, not applied mid-action. The timeline records when it is applied.");
      }
    } catch (cause) {
      if (version !== request.current) return;
      setVerified(false);
      setActionError(`${label} was not confirmed. ${cause instanceof Error ? cause.message : String(cause)} Check status before retrying; no action is repeated automatically.`);
    } finally {
      if (version === request.current) { changing.current = false; setBusy(""); }
    }
    if (version === request.current) void refresh();
  }

  return <div className="space-y-3 border-t border-line/70 px-1 py-3 text-xs leading-relaxed text-mist [overflow-wrap:anywhere]" data-testid="worker-detail">
    <div>
      <p id={labelId} className="font-medium text-snow">{worker.name}</p>
      <p className="mt-1 whitespace-pre-wrap text-snow/90" data-testid="worker-goal">{worker.goal}</p>
      <p className="mt-1" role="status">{!verified ? "Last known: " : ""}{describeWorkerStatus(worker)}{alive ? ` · ${describeLifespan(worker.lifespan)}` : ""}</p>
    </div>
    {control ? <section aria-label={`${surface} access for ${worker.name}`} data-testid="worker-control" data-state={control.state} className="space-y-2 rounded-xl border border-line bg-panel px-3 py-2.5">
      <p className="font-medium text-snow">{!verified ? "Last known: " : ""}{surface} · {control.state === "approved" ? "Task access approved" : control.state === "revoked" ? "Task access revoked" : "Your approval needed"}</p>
      {control.detail ? <p>{control.detail}</p> : null}
      {control.state !== "approved" && alive ? <>
        <p>Approve {surface === "Browser" ? "browser use" : "Mac app use"} for <strong className="font-medium text-snow">{worker.name}</strong> to work on the goal above. Approval lets this task proceed when its access requirements are met. It must be approved again after restarting the app.</p>
        <p>{control.surface === "browser" ? "Uses this discussion's tabs and Coworker's shared local login profile, not a new private account. Use Take over in Browser before signing in." : "First enable Computer in this discussion, then approve this Worker's named task. A single eligible app window opens automatically; choose one in the Computer view when several are available. This is your Mac, not a remote computer. Window content can be sent to your selected model provider; sensitive actions still need separate authorization."}</p>
        <p>This does not approve purchases, messages, deletions or other consequential actions.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" className="text-xs" aria-describedby={labelId} disabled={Boolean(busy) || !verified} aria-busy={busy === "Approval"} data-testid="worker-control-approve" onClick={() => void act("Approval", () => coworkerBridge.workers.approveControl({ slug: coworker.slug, id: worker.id, expectedRevision: control.revision }))}>Approve {control.surface === "browser" ? "browser" : "Mac app"} access</Button>
          {control.surface === "computer" && onOpenComputer ? <Button type="button" variant="ghost" className="text-xs" onClick={onOpenComputer}>Computer setup</Button> : null}
        </div>
      </> : control.state === "approved" ? <>
        <p>{control.surface === "browser" ? "Watch the discussion browser beside chat. Take over pauses browser tools; only you can return control." : "Approval is not proof of active control. The floating Computer view shows recent window frames and input feedback, but never forwards your clicks or typing. Human input pauses control. Use Take over, Continue, or Stop there; minimizing or leaving the discussion stops preview capture, not work. macOS permissions remain separate."}</p>
        <div className="flex flex-wrap gap-2">
          {control.surface === "browser" && onOpenBrowser ? <Button type="button" className="text-xs" onClick={onOpenBrowser}>Watch browser beside chat</Button> : null}
          <Button type="button" variant="ghost" className="text-xs text-rose" disabled={Boolean(busy)} aria-busy={busy === "Revocation"} data-testid="worker-control-revoke" onClick={() => void act("Revocation", () => coworkerBridge.workers.revokeControl({ slug: coworker.slug, id: worker.id, expectedRevision: control.revision }))}>Revoke control</Button>
        </div>
        <p className="text-[11px]">Revoke removes this task's control permission. Stop task ends the Worker.</p>
      </> : null}
    </section> : null}
    {alive ? <form className="space-y-1.5" onSubmit={(event) => {
      event.preventDefault();
      const text = steer.trim();
      if (text && !busy && verified) void act("Steering", () => coworkerBridge.workers.steer(coworker.slug, worker.id, text), text);
    }}>
      <label className="block text-[11px]" htmlFor={`${labelId}-steer`}>Change the next step</label>
      <div className="flex flex-wrap gap-2">
        <input id={`${labelId}-steer`} className={`${inputClass} min-w-0 flex-1 basis-40 py-1.5 text-xs`} placeholder={`Steer ${worker.name}...`} value={steer} disabled={busy === "Steering"} onChange={(event) => setSteer(event.target.value)} data-testid="worker-steer-input" />
        <Button type="submit" variant={control && control.state !== "approved" ? "default" : "primary"} className="shrink-0 text-xs" disabled={!steer.trim() || Boolean(busy) || !verified} aria-busy={busy === "Steering"} data-testid="worker-steer-send">Queue steering</Button>
      </div>
      <p className="text-[11px]">The current step finishes first. Paused work waits for Resume; approval-required work stays paused.</p>
    </form> : null}
    <div className="flex flex-wrap items-center gap-1">
      {alive && worker.status !== "paused" ? <Button type="button" variant="ghost" className="text-xs" disabled={Boolean(busy) || !verified} data-testid="worker-pause" onClick={() => void act("Pause", () => coworkerBridge.workers.pause(coworker.slug, worker.id))}>Pause after step</Button> : null}
      {worker.status === "paused" && (!control || control.state === "approved") ? <Button type="button" className="text-xs" disabled={Boolean(busy) || !verified} data-testid="worker-resume" onClick={() => void act("Resume", () => coworkerBridge.workers.resume(coworker.slug, worker.id))}>Resume</Button> : null}
      {alive || worker.cleanupPending ? <Button type="button" variant="ghost" className="text-xs text-rose" disabled={Boolean(busy)} aria-busy={busy === "Stop"} data-testid="worker-stop" onClick={() => void act("Stop", () => coworkerBridge.workers.cancel(coworker.slug, worker.id))}>{worker.cleanupPending ? "Retry Stop" : "Stop task"}</Button> : null}
      <Button type="button" variant="ghost" className="ml-auto text-xs" disabled={Boolean(busy) || refreshing} onClick={() => void refresh()} data-testid="worker-refresh">{refreshing ? "Checking..." : "Check status"}</Button>
    </div>
    {notice ? <p role="status" data-testid="worker-steer-notice">{notice}</p> : null}
    {readError ? <p role="alert" className="text-amber">{readError}</p> : null}
    {actionError ? <p role="alert" className="text-rose">{actionError}</p> : null}
    {worker.error && worker.status === "failed" ? <p className="text-amber" data-testid="worker-error">{worker.error} Review this with {coworker.name} in the conversation; this Worker has ended.</p> : null}
    <section aria-label={`Updates from ${worker.name}`}>
      <p className="mb-2 font-medium text-snow">Findings &amp; activity</p>
      {findingsError ? <p role="status" className="mb-2 text-amber">{findingsError}</p> : null}
      <ol className="max-h-48 space-y-2 overflow-y-auto overscroll-contain border-l border-line pl-3" data-testid="worker-timeline">
        {events === null ? <li>Loading updates...</li> : events.length === 0 ? <li>No findings yet. Chat stays available while this task works.</li> : [...events].reverse().map((event) => {
          const line = describeWorkerEvent(event, coworker.name);
          return <li key={event.id} data-testid="worker-event" data-kind={event.kind} className={line.quiet ? "text-mist" : "text-snow/90"}>
            <span className="mr-2 text-[10px] text-mist" title={new Date(event.at).toLocaleString()}>{relativeTime(event.at) || "now"}</span>
            {line.label ? <span className={`mr-1 font-medium ${event.report === "decision" ? "text-amber" : ""}`}>{line.label}</span> : null}
            <span className="whitespace-pre-wrap">{line.text}</span>
          </li>;
        })}
      </ol>
    </section>
    <details className="text-[11px]">
      <summary className="cursor-pointer">Task details</summary>
      <p className="mt-2">{worker.spawnedBy === "coworker" ? `Started by ${coworker.name}` : "Started by you"}. {worker.modelSnapshot ? `Model: ${worker.modelSnapshot.providerId}/${worker.modelSnapshot.modelId}. Effort: ${worker.modelSnapshot.variant || "model default"}. This choice is pinned for the task.` : "Uses the coworker's model (legacy task)."}</p>
      {worker.threadId && onOpenThread ? <Button type="button" variant="ghost" className="mt-2 text-xs" data-testid="worker-open-work" onClick={() => onOpenThread(worker.threadId)}>Open full transcript</Button> : null}
    </details>
  </div>;
}
