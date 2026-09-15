import { useEffect, useEffectEvent, useRef, useState } from "react";
import { PROGRESS_LIMITS } from "@/lib/progress-config";
import { EXECUTION_KINDS, EXECUTION_STATES, executionDuration, executionMetadata, type ExecutionMetadata, type ExecutionMetadataInput } from "@/lib/work-receipt";
import { ToolIcon } from "@/ui/kit";

/** Existing transcripts may carry payloads; inspection deliberately never reads them. */
export type WorkPopoverCall = ExecutionMetadataInput & { partId: string };
export type WorkPopoverPlacement = "below" | "above";
export const WORK_POPOVER_ROOM_PX = 320;

export function workPopoverPlacement(anchor: DOMRect, viewportHeight: number): WorkPopoverPlacement {
  const below = viewportHeight - anchor.bottom;
  return below < WORK_POPOVER_ROOM_PX && anchor.top > below ? "above" : "below";
}

/** Nonmodal keyboard entry, Escape, focus-out dismissal, and restore without stealing outside clicks. */
export function useActivityPopover(anchor: HTMLElement | null, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useEffectEvent(onClose);
  useEffect(() => {
    const popover = ref.current;
    let restoreFocus = true;
    popover?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    const onOutside = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node) || popover?.contains(target) || anchor?.contains(target)) return;
      restoreFocus = false;
      close();
    };
    popover?.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onOutside, true);
    window.addEventListener("focusin", onOutside);
    return () => {
      popover?.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onOutside, true);
      window.removeEventListener("focusin", onOutside);
      if (restoreFocus && anchor?.isConnected && (popover?.contains(document.activeElement) || document.activeElement === document.body)) anchor.focus({ preventScroll: true });
    };
  }, [anchor]);
  return ref;
}

export function useActivityClock(running = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), PROGRESS_LIMITS.clockMs);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

export function ExecutionDetails({ metadata, now }: { metadata: ExecutionMetadata; now: number }) {
  return (
    <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px] leading-relaxed text-mist [overflow-wrap:anywhere]">
      <dt>Observed status</dt><dd className="text-snow/85">{EXECUTION_STATES[metadata.status]}</dd>
      <dt>Duration</dt><dd>{executionDuration(metadata, now)}</dd>
    </dl>
  );
}

export function WorkPopover({ calls, anchor, placement, onClose }: {
  calls: WorkPopoverCall[];
  anchor: HTMLElement | null;
  placement: WorkPopoverPlacement;
  onClose: () => void;
}) {
  const ref = useActivityPopover(anchor, onClose);
  const shown = calls.slice(-PROGRESS_LIMITS.maxVisibleSteps).map((call) => ({ id: call.partId, metadata: executionMetadata(call) }));
  const now = useActivityClock(shown.some(({ metadata }) => metadata.status === "running"));
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-label="Observed execution steps"
      className={`thinking-popover absolute left-1/2 z-40 w-[min(400px,calc(100vw-32px))] max-w-full -translate-x-1/2 rounded-[14px] border border-line bg-panel text-left shadow-[0_12px_32px_rgba(0,0,0,0.35)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ready/50 ${placement === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}
      data-testid="coworker-work-steps"
      data-placement={placement}
    >
      <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5 text-[11px]">
        <ToolIcon className="size-3.5 shrink-0 text-mist" />
        <span className="font-semibold text-snow">Execution steps</span>
        <span className="text-mist/80" data-testid="coworker-work-progress">{calls.length} observed</span>
        <button type="button" onClick={onClose} className="ml-auto rounded px-1 text-mist hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ready/50">Close</button>
      </div>
      <p className="px-3.5 pt-1.5 text-[10px] leading-relaxed text-mist">Only execution metadata. Reasoning and tool contents are not shown.</p>
      {calls.length > shown.length ? <p className="px-3.5 pt-1 text-[10px] text-mist">Showing the latest {shown.length} steps.</p> : null}
      <ol className="max-h-[min(320px,50vh)] overflow-y-auto overscroll-contain p-1.5">
        {shown.map(({ id, metadata }) => (
          <li key={id} className="rounded-lg px-2 py-2 text-[11px] [overflow-wrap:anywhere]" data-testid="coworker-work-step" data-state={metadata.status}>
            <p className="font-medium text-snow">{EXECUTION_KINDS[metadata.kind]}</p>
            <ExecutionDetails metadata={metadata} now={now} />
          </li>
        ))}
      </ol>
    </div>
  );
}
