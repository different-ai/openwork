import { useEffect, useId, useRef, useState } from "react";
import type { CoworkerSummary } from "@/lib/bridge";
import type { LivePhase } from "@/lib/live-phase";
import type { LiveStream } from "@/lib/live-stream";
import { PROGRESS_STATES, isLongProgress, progressNoteText, type ProgressNote, type ProgressObservation } from "@/lib/progress-service";
import { EXECUTION_KINDS, EXECUTION_STATES, executionMetadata, type ExecutionMetadataInput, type WorkStep } from "@/lib/work-receipt";
import { CoworkerAvatar } from "@/ui/coworker-avatar";
import { ToolIcon } from "@/ui/kit";
import { ThinkingPopover } from "@/ui/thinking-popover";
import { useActivityClock } from "@/ui/work-popover";

/** Existing callers can pass their transcript call; no payload fields are read. */
export type LiveRowCall = ExecutionMetadataInput;

export function LiveRow({ coworker, phase = "thinking", step = null, stepCall = null, stepSince = null, stream = null, reply = null, wordsArrived = false, sentAt = null, stillWorking = "", progress, progressNote, onStop }: {
  coworker: CoworkerSummary;
  phase?: LivePhase;
  step?: WorkStep | null;
  stepCall?: LiveRowCall | null;
  stepSince?: number | null;
  stream?: LiveStream | null;
  /** Landed reply text is used only to suppress duplicate typing. Reasoning is never read. */
  reply?: { text: string } | null;
  wordsArrived?: boolean;
  sentAt?: number | null;
  /** Existing wait-budget signal; its free-form text is deliberately not rendered. */
  stillWorking?: string;
  /** Main can supply execution status, recorded counts, and pending dependency counts. */
  progress?: ProgressObservation;
  progressNote?: ProgressNote;
  onStop?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const streaming = phase === "writing" || (stream?.type === "text" && !stream.ended && Boolean(stream.text.trim()));
  const hasWords = streaming || wordsArrived || Boolean(reply?.text.trim());
  const observation: ProgressObservation = progress ?? {
    executionId: `${coworker.slug}:${sentAt ?? "unknown"}`,
    status: streaming ? "streaming" : phase === "thinking" ? "preparing" : phase,
    startedAt: sentAt,
    tool: phase === "tool" && (stepCall || step) ? {
      tool: stepCall?.tool ?? step?.tool ?? "",
      status: stepCall?.status,
      startedAt: stepSince,
      completedAt: stepCall?.completedAt,
    } : null,
  };
  const status = observation.status;
  const terminal = status === "completed" || status === "failed" || status === "cancelled" || status === "unknown";
  const quiet = terminal || status === "waiting" || status === "queued";
  const now = useActivityClock(!terminal);
  const long = isLongProgress(observation, now) || Boolean(stillWorking);
  const hidden = !quiet && (streaming || status === "streaming");
  // From the moment a message is sent until its first words, one thinking bubble:
  // sending and preparing are the same wait to the person, so they share a shape.
  const typing = !hasWords && !quiet && (status === "sending" || status === "preparing" || status === "resuming");
  const tool = observation.tool ? executionMetadata(observation.tool) : null;
  const label = status === "tool" && tool ? `${EXECUTION_KINDS[tool.kind]}: ${EXECUTION_STATES[tool.status]}` : PROGRESS_STATES[status];
  const note = progressNote ?? observation.note;
  const noteText = progressNoteText(observation, note);
  const duplicateUnavailable = status === "unknown" && noteText === `${label}.`;

  useEffect(() => { setOpen(false); }, [observation.executionId, hidden]);

  if (hidden) return <div className="h-0 overflow-hidden" aria-hidden="true" data-testid="coworker-working" data-phase="writing" data-outcome="working" data-popover="closed" />;

  const notes = (
    <>
      {(long || quiet) && !duplicateUnavailable ? <p className="mt-1 text-[11px] leading-relaxed text-mist [overflow-wrap:anywhere]" data-testid="coworker-still-working">{noteText}</p> : null}
      {long && !terminal && onStop ? <button type="button" className="mt-1 rounded text-[11px] text-snow/80 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ready/50" data-testid="coworker-turn-choice" data-choice="stop" onClick={onStop}>Stop</button> : null}
    </>
  );

  // The thinking bubble has the reply bubble's place, shape and one-line height,
  // so the first words fill it instead of replacing a different layout.
  if (typing) return (
    <div className="relative flex min-w-0 flex-col items-start" data-testid="coworker-working" data-phase={status} data-outcome={long ? "slow" : "working"} data-popover={open ? "open" : "closed"}>
      <button
        ref={anchorRef}
        type="button"
        className="bubble bubble-coworker flex items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ready/50"
        title={open ? "Hide activity" : "Inspect observed activity"}
        aria-label={`${coworker.name}: ${label}. Inspect observed activity`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        data-testid="coworker-typing"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex h-[1.45em] items-center gap-1" aria-hidden="true">{[0, 1, 2].map((index) => <span key={index} className="typing-dot size-[5px] rounded-full bg-mist/80" style={{ animationDelay: `${index * 160}ms` }} />)}</span>
      </button>
      {notes}
      {open ? <ThinkingPopover coworkerName={coworker.name} observation={observation} note={note} id={id} anchor={anchorRef.current} onClose={() => setOpen(false)} /> : null}
    </div>
  );

  return (
    <div className="relative min-w-0 px-1 py-1.5 text-xs text-mist" data-testid="coworker-working" data-phase={status} data-outcome={terminal ? status : long ? "slow" : "working"} data-popover={open ? "open" : "closed"}>
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="shrink-0">
          <CoworkerAvatar identity={coworker.slug} animated={false} motion="quiet" gaze={false} color={coworker.avatarColor} glasses={coworker.avatarGlasses} name={coworker.name} size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <button
            ref={anchorRef}
            type="button"
            className="flex min-h-6 max-w-full items-center gap-2 rounded-xl bg-panel-2 px-2.5 py-1 text-left text-[12px] leading-relaxed text-mist transition-colors hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ready/50 motion-reduce:transition-none"
            title={open ? "Hide activity" : "Inspect observed activity"}
            aria-label={`${coworker.name}: ${label}. Inspect observed activity`}
            aria-expanded={open}
            aria-controls={open ? id : undefined}
            aria-haspopup="dialog"
            data-testid={status === "tool" ? "coworker-tool-chip" : "coworker-activity-chip"}
            onClick={() => setOpen((value) => !value)}
          >
            {status === "tool" ? <ToolIcon className="size-3 shrink-0 motion-safe:animate-pulse" /> : null}
            <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
          </button>
          {notes}
        </div>
      </div>
      {open ? <ThinkingPopover coworkerName={coworker.name} observation={observation} note={note} id={id} anchor={anchorRef.current} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
