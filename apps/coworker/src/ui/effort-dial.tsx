import { CoworkerEffortSlider } from "@openwork/ui/coworker-effort";
import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_EFFORT_STOP, EFFORT_STOPS, describeEffortStop, effortLevelFor, effortStopLabel, laneWithPreference, replyKindForLane, type EffortKind, type EffortStop } from "@/lib/effort";

/**
 * Dynamic effort sets the coworker's pace. The composer control opens a
 * five-stop slider and an optional preview of how different tasks adapt.
 * Each turn derives its effort from this preference and the kind of work;
 * a supported fixed effort in Coworker settings still takes priority.
 */
export function EffortDial({
  stop,
  onChange,
  coworkerName,
  compact = true,
  fixedVariant = "",
}: {
  stop: EffortStop;
  onChange: (stop: EffortStop) => void;
  coworkerName: string;
  /** The pill and popover (default); false renders the dial inline for a settings row. */
  compact?: boolean;
  fixedVariant?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  const index = EFFORT_STOPS.indexOf(stop);
  const examples: { label: string; kind: EffortKind }[] = [
    { label: "Quick questions", kind: replyKindForLane(laneWithPreference("quick", stop)) },
    { label: "Planning & research", kind: replyKindForLane(laneWithPreference("deep", stop)) },
    { label: "Background work", kind: "worker-turn" },
  ];
  const dial = (
    <div className="w-[320px] max-w-[calc(100vw-56px)] space-y-4" data-testid="effort-dial-panel" data-stop={stop}>
      <div>
        <p className="flex items-center gap-2 text-sm font-semibold text-snow"><DynamicEffortIcon />Dynamic effort</p>
        <p className="mt-1.5 text-xs leading-relaxed text-mist">{coworkerName} adapts to the task. You set the pace.</p>
      </div>
      <div>
        <div className="flex items-center justify-between gap-3">
          <p id={labelId} className="effort-dial-name text-[22px] font-semibold tracking-tight text-snow" data-testid="effort-dial-stop">{effortStopLabel(stop)}</p>
          {stop !== DEFAULT_EFFORT_STOP ? (
            <button
              type="button"
              className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] text-mist hover:border-white/20 hover:text-snow"
              title="Back to Balanced"
              data-testid="effort-dial-reset"
              onClick={() => onChange(DEFAULT_EFFORT_STOP)}
            >
              Reset
            </button>
          ) : null}
        </div>
        <p className="mt-0.5 min-h-9 text-[11px] leading-relaxed text-mist" data-testid="effort-dial-meaning">{describeEffortStop(stop)}</p>
      </div>
      <div>
        <CoworkerEffortSlider index={index} stop={stop} label={effortStopLabel(stop)} labelId={labelId} onChange={(nextIndex) => {
          const next = EFFORT_STOPS[nextIndex];
          if (next) onChange(next);
        }} />
        <div className="mt-1 flex justify-between gap-1 text-[10px] text-mist/65">
          {EFFORT_STOPS.map((candidate) => (
            <button key={candidate} type="button" aria-pressed={candidate === stop} className={`rounded-lg px-1.5 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/60 ${candidate === stop ? "bg-spark/15 text-snow" : "hover:bg-white/5 hover:text-snow"}`} onClick={() => onChange(candidate)}>{effortStopLabel(candidate)}</button>
          ))}
        </div>
      </div>
      {fixedVariant ? (
        <p className="rounded-xl border border-line bg-white/3 px-3 py-2.5 text-[11px] leading-relaxed text-mist" data-testid="effort-fixed-note">
          Your fixed thinking effort ({fixedVariant}) takes priority when the model supports it. This preference still guides automatic model selection and the default number of Worker steps.
        </p>
      ) : (
        <details className="group rounded-xl border border-line bg-ink/30">
          <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[11px] font-medium text-mist hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50" data-testid="effort-explainer">How it adapts<span aria-hidden="true" className="transition-transform group-open:rotate-90">›</span></summary>
          <div className="space-y-2.5 px-3 pb-3" data-testid="effort-adapts-preview">
            <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-mint">Adapts with your work</p>
            {examples.map(({ label, kind }) => (
              <div key={kind} className="flex items-center justify-between gap-3 text-[11px] text-mist">
                <span>{label}</span>
                <span className="flex gap-1" aria-label={`${label}: ${effortLevelFor(kind, stop) + 1} of 6 thinking levels`}>
                  {Array.from({ length: 6 }, (_, level) => <span key={level} aria-hidden="true" className={`h-1.5 w-3.5 rounded-full ${level <= effortLevelFor(kind, stop) ? "bg-spark/75" : "bg-white/8"}`} />)}
                </span>
              </div>
            ))}
            <p className="text-[10px] leading-relaxed text-mist/70">Starting points, adapted to the thinking levels your model supports.</p>
            <p className="text-[10px] leading-relaxed text-mist/70">Models without adjustable thinking use their default.</p>
          </div>
        </details>
      )}
      <p className="text-[10px] leading-relaxed text-mist/65">More depth can use more time and allowance.</p>
    </div>
  );

  if (!compact) return <div data-testid="effort-dial" data-stop={stop}>{dial}</div>;

  return (
    <div ref={rootRef} className="relative" data-testid="effort-dial" data-stop={stop}>
      <button
        type="button"
        className="inline-flex min-h-8 items-center gap-2 rounded-xl px-2.5 py-1.5 text-[11px] text-mist transition-colors hover:bg-spark/10 hover:text-snow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`Dynamic effort for ${coworkerName}`}
        data-testid="effort-dial-pill"
        onClick={() => setOpen((current) => !current)}
      >
        <DynamicEffortIcon /><span className="font-medium text-snow/90">Dynamic effort</span>{" "}
        <span className="text-mist">{effortStopLabel(stop)}</span>{" "}
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div role="dialog" aria-label={`Dynamic effort for ${coworkerName}`} className="absolute bottom-full right-0 z-30 mb-3 max-h-[min(540px,75vh)] overflow-y-auto rounded-[22px] border border-line bg-panel p-5 shadow-[0_16px_48px_rgba(0,0,0,0.4)]">
          {dial}
        </div>
      ) : null}
    </div>
  );
}

function DynamicEffortIcon() {
  return <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4 shrink-0 fill-none stroke-spark" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 13V9m5 6V5m5 8V7m4 4V9" /></svg>;
}
