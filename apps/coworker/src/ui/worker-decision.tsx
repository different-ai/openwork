import { useEffect, useRef, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { parseWorkerDecision, type WorkerEvent, type WorkerSummary } from "@/lib/workers";
import { InteractionCard, LETTERS, OptionRow, typingInField } from "@/ui/interactions";
import { Button, ErrorNote, inputClass } from "@/ui/kit";
import { useComposerDraft } from "@/ui/use-composer-draft";

/** Workers waiting on a decision, each as one card the person answers; answering steers the Worker. */
export function WorkerDecisionCards({ coworker, threadId, workers, onAnswered }: { coworker: CoworkerSummary; threadId: string; workers: WorkerSummary[]; onAnswered: () => void }) {
  const waiting = workers.filter((worker) => worker.slug === coworker.slug && worker.spawnedFromThreadId === threadId && worker.status === "waiting" && worker.waitingFor === "decision");
  if (waiting.length === 0) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      {waiting.map((worker) => (
        <WorkerDecisionCard key={`${coworker.slug}:${threadId}:${worker.id}`} coworker={coworker} worker={worker} onAnswered={onAnswered} />
      ))}
    </div>
  );
}

function WorkerDecisionCard({ coworker, worker, onAnswered }: { coworker: CoworkerSummary; worker: WorkerSummary; onAnswered: () => void }) {
  const [finding, setFinding] = useState<WorkerEvent | null>(null);
  const [custom, setCustom] = useComposerDraft(`${coworker.slug}:${coworker.createdAt}:${worker.id}:decision`);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const request = useRef(0);
  const sending = useRef(false);
  useEffect(() => () => { request.current += 1; }, []);

  useEffect(() => {
    let cancelled = false;
    coworkerBridge.workers
      .findings(coworker.slug, worker.id, 20)
      .then((events) => {
        if (cancelled) return;
        const latest = [...events].reverse().find((event) => event.kind === "finding" && event.report === "decision");
        setFinding(latest ?? null);
        setReadError(false);
      })
      .catch(() => { if (!cancelled) setReadError(true); });
    return () => {
      cancelled = true;
    };
  }, [coworker.slug, worker.id, worker.updatedAt, attempt]);

  useEffect(() => {
    // A new decision may arrive between polls without an intervening unmount.
    request.current += 1;
    sending.current = false;
    setBusy(false);
    setSent(false);
    setError("");
  }, [finding?.id]);

  const decision = parseWorkerDecision(finding?.text ?? "");

  async function answer(text: string): Promise<void> {
    if (sending.current || readError || !text.trim()) return;
    sending.current = true;
    const version = ++request.current;
    setBusy(true);
    setError("");
    try {
      await coworkerBridge.workers.steer(coworker.slug, worker.id, text.trim());
      if (version !== request.current) return;
      setSent(true);
      setCustom("");
      onAnswered();
    } catch (cause) {
      if (version !== request.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
      sending.current = false;
    }
  }

  if (!finding && !readError) return null;
  return (
    <div onKeyDown={(event) => {
      if (busy || typingInField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const option = decision.options[LETTERS.indexOf(event.key.toUpperCase())];
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      void answer(option);
    }}>
    <InteractionCard label={`${worker.name} asks`} testId="worker-decision-card" title={`${worker.name} asks`} detail={decision.question}>
      {readError ? <p role="alert" className="mt-2 text-xs text-amber">The latest decision could not be checked. <button type="button" className="underline" onClick={() => setAttempt((value) => value + 1)}>Check again</button></p> : null}
      {decision.options.length > 0 ? (
        <div className="mt-3 divide-y divide-line/70 rounded-xl border border-line/70" role="listbox" aria-label={`${worker.name}'s choices`}>
          {decision.options.map((option, index) => (
            <OptionRow key={option} letter={LETTERS[index] ?? String(index + 1)} label={option} disabled={busy || readError} onChoose={() => void answer(option)} />
          ))}
        </div>
      ) : null}
      <input
        className={`${inputClass} mt-2 bg-ink/60`}
        aria-label={`Your answer for ${worker.name}`}
        placeholder={decision.options.length > 0 ? "Or type your own answer" : "Type your answer"}
        value={custom}
        disabled={busy}
        onChange={(event) => setCustom(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void answer(custom); }
        }}
        data-testid="worker-decision-input"
      />
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[11px] text-mist">{sent ? "Answer queued for the next step." : busy ? "Sending..." : decision.options.length > 0 ? "Choose an option, or focus a choice and press its letter. Your answer is queued as steering." : "Your answer is queued as steering for the next step."}</p>
        <Button variant="primary" className="text-xs" disabled={busy || readError || !custom.trim()} onClick={() => void answer(custom)} data-testid="worker-decision-send">
          {sent ? "Queued" : busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </InteractionCard>
    </div>
  );
}
