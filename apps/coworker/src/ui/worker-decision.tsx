import { useEffect, useState } from "react";
import { coworkerBridge, type CoworkerSummary } from "@/lib/bridge";
import { parseWorkerDecision, type WorkerEvent, type WorkerSummary } from "@/lib/workers";
import { InteractionCard, LETTERS, OptionRow, typingInField } from "@/ui/interactions";
import { Button, ErrorNote, inputClass } from "@/ui/kit";

/** Workers waiting on a decision, each as one card the person answers; answering steers the Worker. */
export function WorkerDecisionCards({ coworker, workers, onAnswered }: { coworker: CoworkerSummary; workers: WorkerSummary[]; onAnswered: () => void }) {
  const waiting = workers.filter((worker) => worker.status === "waiting" && worker.waitingFor === "decision");
  if (waiting.length === 0) return null;
  return (
    <div className="space-y-2" aria-live="polite">
      {waiting.map((worker) => (
        <WorkerDecisionCard key={`${worker.id}:${worker.updatedAt}`} coworker={coworker} worker={worker} onAnswered={onAnswered} />
      ))}
    </div>
  );
}

function WorkerDecisionCard({ coworker, worker, onAnswered }: { coworker: CoworkerSummary; worker: WorkerSummary; onAnswered: () => void }) {
  const [finding, setFinding] = useState<WorkerEvent | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    coworkerBridge.workers
      .findings(coworker.slug, worker.id, 20)
      .then((events) => {
        if (cancelled) return;
        const latest = [...events].reverse().find((event) => event.kind === "finding" && event.report === "decision");
        setFinding(latest ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [coworker.slug, worker.id, worker.updatedAt]);

  const decision = parseWorkerDecision(finding?.text ?? "");

  async function answer(text: string): Promise<void> {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError("");
    try {
      await coworkerBridge.workers.steer(coworker.slug, worker.id, text.trim());
      onAnswered();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (busy || typingInField(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const option = decision.options[LETTERS.indexOf(event.key.toUpperCase())];
      if (!option) return;
      event.preventDefault();
      void answer(option);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  if (!finding) return null;
  return (
    <InteractionCard label={`${worker.name} asks`} testId="worker-decision-card" title={`${worker.name} asks`} detail={decision.question}>
      {decision.options.length > 0 ? (
        <div className="mt-3 divide-y divide-line/70 rounded-xl border border-line/70" role="listbox" aria-label={`${worker.name}'s choices`}>
          {decision.options.map((option, index) => (
            <OptionRow key={option} letter={LETTERS[index] ?? String(index + 1)} label={option} disabled={busy} onChoose={() => void answer(option)} />
          ))}
        </div>
      ) : null}
      <input
        className={`${inputClass} mt-2 bg-ink/60`}
        aria-label={`Your answer for ${worker.name}`}
        placeholder={decision.options.length > 0 ? "Or type your own answer" : "Type your answer"}
        value={custom}
        onChange={(event) => setCustom(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") void answer(custom);
        }}
        data-testid="worker-decision-input"
      />
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
      <div className="mt-3 flex items-center justify-between gap-2">
        <p className="text-[11px] text-mist">{busy ? "Sending…" : decision.options.length > 0 ? "Click or press a letter; your answer steers the Worker." : "Your answer steers the Worker."}</p>
        <Button variant="primary" className="text-xs" disabled={busy || !custom.trim()} onClick={() => void answer(custom)} data-testid="worker-decision-send">
          {busy ? "Sending…" : "Send"}
        </Button>
      </div>
    </InteractionCard>
  );
}
