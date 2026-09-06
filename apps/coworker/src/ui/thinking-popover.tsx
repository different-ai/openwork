import { PROGRESS_STATES, progressNoteText, type ProgressNote, type ProgressObservation } from "@/lib/progress-service";
import { EXECUTION_KINDS, executionDuration, executionMetadata, executionTimestamp } from "@/lib/work-receipt";
import { ExecutionDetails, useActivityClock, useActivityPopover, workPopoverPlacement } from "@/ui/work-popover";

/** Historical component name; its entire contract now contains only safe execution facts. */
export function ThinkingPopover({ coworkerName, observation, note, anchor, id, onClose }: {
  coworkerName: string;
  observation: ProgressObservation;
  note?: ProgressNote;
  anchor: HTMLElement | null;
  id: string;
  onClose: () => void;
}) {
  const ref = useActivityPopover(anchor, onClose);
  const terminal = ["completed", "failed", "cancelled", "unknown"].includes(observation.status);
  const now = useActivityClock(!terminal);
  const metadata = observation.tool ? executionMetadata(observation.tool) : null;
  const placement = anchor ? workPopoverPlacement(anchor.getBoundingClientRect(), window.innerHeight) : "below";
  const duration = executionDuration({
    status: terminal ? "unknown" : "running",
    startedAt: executionTimestamp(observation.startedAt),
    completedAt: executionTimestamp(observation.completedAt),
  }, now);
  return (
    <div
      ref={ref}
      id={id}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label={`${coworkerName}: observed activity`}
      className={`thinking-popover absolute left-0 z-40 w-[min(400px,calc(100vw-32px))] max-w-full rounded-[14px] border border-line bg-panel shadow-[0_12px_32px_rgba(0,0,0,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ready/50 ${placement === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}
      data-testid="coworker-thinking-popover"
      data-mode="execution"
    >
      <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5 text-[11px]">
        <span className="font-semibold text-snow">Observed activity</span>
        <button type="button" onClick={onClose} className="ml-auto rounded px-1 text-mist hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ready/50">Close</button>
      </div>
      <div className="max-h-[min(320px,50vh)] overflow-y-auto overscroll-contain px-3.5 pb-3 pt-1.5 text-[12px] leading-relaxed text-mist [overflow-wrap:anywhere]">
        <p className="text-snow/85">{PROGRESS_STATES[observation.status]}</p>
        <p className="text-[11px]" data-testid="coworker-thinking-small-print">Execution: {duration}</p>
        {metadata ? <div className="mt-2 rounded-lg bg-ink/70 p-2.5"><p>{EXECUTION_KINDS[metadata.kind]}</p><ExecutionDetails metadata={metadata} now={now} /></div> : null}
        <p className="mt-2">{progressNoteText(observation, note)}</p>
        <p className="mt-2 text-[10px] text-mist/80">Only execution metadata. Reasoning and tool contents are not shown. Elapsed time is not an estimate of time remaining.</p>
      </div>
    </div>
  );
}
