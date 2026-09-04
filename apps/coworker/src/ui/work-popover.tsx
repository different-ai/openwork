import { useEffect, useRef } from "react";
import { isServerTool, toolRefPath } from "@/lib/apps-tools";
import { openPanelRoute } from "@/lib/panel-route";
import { appsToolsRoute } from "@/lib/panel-views";
import { describeWorkProgress, describeWorkStep, technicalSections, type WorkStep } from "@/lib/work-receipt";
import { StatusDot, ToolIcon } from "@/ui/kit";

/** A tool call as the transcript keeps it; the popover reads, never writes. */
export type WorkPopoverCall = {
  partId: string;
  tool: string;
  status: string;
  input: Record<string, unknown>;
  output: unknown;
  error: string | null;
  metadata: Record<string, unknown>;
};

export type WorkPopoverPlacement = "below" | "above";

/** Room a popover wants under its line before it flips above instead. */
export const WORK_POPOVER_ROOM_PX = 320;

/**
 * Where the steps popover opens for a line at `anchor`: under it when the
 * viewport leaves room, above it when the line sits near the bottom and there
 * is more room above.
 */
export function workPopoverPlacement(anchor: DOMRect, viewportHeight: number): WorkPopoverPlacement {
  const below = viewportHeight - anchor.bottom;
  return below < WORK_POPOVER_ROOM_PX && anchor.top > below ? "above" : "below";
}

const STATE_WORDS = { running: "Working on it", done: "Done", failed: "Didn't finish" } as const;

/** The one detail worth seeing without opening the technical view: a shell step's command, on one line. */
function stepGist(call: WorkPopoverCall): string {
  const command = technicalSections(call).find((section) => section.label === "Command");
  return command ? command.text.split("\n")[0] ?? "" : "";
}

/**
 * The steps behind one receipt line, for a person who tapped it: each step in
 * plain words with its state, a shell step's command as a quiet line, and the
 * tool's name, input, and result behind Technical details. A light popover
 * floating under (or over) the line — never a card in the transcript, never
 * modal. Escape, a click outside, or the line itself closes it; it stays open
 * while steps are still landing so the person can watch them settle.
 */
export function WorkPopover({
  calls,
  steps,
  anchor,
  placement,
  onClose,
}: {
  calls: WorkPopoverCall[];
  steps: WorkStep[];
  /** The line the popover hangs from; a pointer on it is left to the line's own toggle. */
  anchor: HTMLElement | null;
  placement: WorkPopoverPlacement;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [anchor, onClose]);

  const working = steps.some((step) => step.state === "running");

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-modal="false"
      aria-label="The steps behind this reply"
      className={`thinking-popover absolute left-1/2 z-40 w-[min(400px,calc(100vw-48px))] -translate-x-1/2 rounded-[14px] border border-line bg-panel text-left shadow-[0_12px_32px_rgba(0,0,0,0.35)] ${placement === "above" ? "bottom-full mb-1.5" : "top-full mt-1.5"}`}
      data-testid="coworker-work-steps"
      data-placement={placement}
    >
      <div className="flex items-center gap-2 px-3.5 pt-2.5 text-[11px]">
        <ToolIcon className={`size-3.5 shrink-0 text-mist ${working ? "motion-safe:animate-pulse" : ""}`} />
        <span className="font-semibold text-snow">Steps</span>
        <span className="ml-auto text-mist/80" data-testid="coworker-work-progress">{describeWorkProgress(steps)}</span>
      </div>
      <ol className="max-h-[min(320px,60vh)] overflow-y-auto px-1.5 pb-1.5 pt-1.5">
        {calls.map((call, index) => {
          const step = steps[index] ?? describeWorkStep(call);
          const gist = stepGist(call);
          return (
            <li key={call.partId} className="rounded-lg px-2 py-1.5 text-[11px] hover:bg-white/[0.03]" data-testid="coworker-work-step" data-state={step.state}>
              <div className="flex items-center gap-2">
                <StatusDot tone={step.state === "failed" ? "rose" : step.state === "done" ? "mint" : "spark"} />
                {isServerTool(call.tool) ? (
                  // A step that used one of the coworker's tools or Apps opens that item in Apps & tools.
                  <button
                    type="button"
                    className={`min-w-0 flex-1 truncate text-left hover:underline ${step.state === "failed" ? "text-rose" : "text-snow"}`}
                    title="Open in Apps & tools"
                    data-testid="coworker-work-step-open"
                    onClick={() => openPanelRoute(appsToolsRoute(toolRefPath(call.tool, step.label)))}
                  >
                    {step.label}
                  </button>
                ) : (
                  <span className={`min-w-0 flex-1 truncate ${step.state === "failed" ? "text-rose" : "text-snow"}`}>{step.label}</span>
                )}
                <span className="shrink-0 text-mist">{STATE_WORDS[step.state]}</span>
              </div>
              {gist ? <p className="mt-0.5 truncate pl-4 font-mono text-[10.5px] text-mist/80" title={gist} data-testid="coworker-work-step-gist">{gist}</p> : null}
              <TechnicalDetails call={call} />
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The technical view of one step: the tool's name, then labelled blocks (Command, Input,
 * Result, Error) in a steady, readable layout. Closed by default; the error line stays visible.
 */
function TechnicalDetails({ call }: { call: WorkPopoverCall }) {
  const sections = technicalSections(call);
  return (
    <div className="pl-4">
      {call.error ? <p className="mt-1 break-words text-rose">{call.error}</p> : null}
      <details className="group/tech mt-0.5 text-[10px] text-mist/75" data-testid="coworker-work-technical">
        <summary className="flex cursor-pointer select-none items-center gap-1 hover:text-mist">
          <span className="text-mist/60 transition-transform group-open/tech:rotate-90" aria-hidden="true">›</span>
          Technical details
        </summary>
        <dl className="mt-1.5 space-y-1.5 rounded-lg bg-ink/70 p-2.5">
          <div className="flex items-baseline gap-2">
            <dt className="w-14 shrink-0 text-mist/60">Tool</dt>
            <dd className="min-w-0 break-all font-mono text-mist">{call.tool}</dd>
          </div>
          {sections.map((section) => (
            <div key={section.label} className="flex items-baseline gap-2">
              <dt className={`w-14 shrink-0 ${section.label === "Error" ? "text-rose/80" : "text-mist/60"}`}>{section.label}</dt>
              <dd className="min-w-0 flex-1">
                <pre className={`max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono leading-relaxed ${section.label === "Error" ? "text-rose" : "text-snow/85"}`}>{section.text}</pre>
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
