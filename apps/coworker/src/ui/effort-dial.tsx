import { useEffect, useId, useRef, useState } from "react";
import { DEFAULT_EFFORT_STOP, EFFORT_STOPS, describeEffortStop, effortStopLabel, type EffortStop } from "@/lib/effort";

/**
 * The effort dial: how hard the coworker should work, as a preference. A small
 * pill at the foot of the conversation names the current stop; tapping it opens
 * a light popover above — the stop's name, one line saying what it means for
 * the turns, a reset to Balanced, and a five-stop slider. The dial never sets an
 * exact effort: each turn's effort is derived from the stop and the kind of
 * work (see `lib/effort.ts`), and the person's exact effort in Coworker
 * settings, when fixed, still wins.
 */
export function EffortDial({
  stop,
  onChange,
  coworkerName,
  compact = true,
}: {
  stop: EffortStop;
  onChange: (stop: EffortStop) => void;
  coworkerName: string;
  /** The pill and popover (default); false renders the dial inline for a settings row. */
  compact?: boolean;
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
  const dial = (
    <div className="w-[300px] space-y-3" data-testid="effort-dial-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p id={labelId} className="text-sm font-semibold text-snow" data-testid="effort-dial-stop">{effortStopLabel(stop)}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-mist" data-testid="effort-dial-meaning">{describeEffortStop(stop)}</p>
        </div>
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
      <div className="px-1">
        <input
          type="range"
          min={0}
          max={EFFORT_STOPS.length - 1}
          step={1}
          value={index}
          aria-labelledby={labelId}
          aria-valuetext={effortStopLabel(stop)}
          className="effort-dial-range w-full"
          data-testid="effort-dial-range"
          onChange={(event) => {
            const next = EFFORT_STOPS[Number(event.target.value)];
            if (next) onChange(next);
          }}
        />
        <div className="mt-1 flex justify-between text-[9px] text-mist/65" aria-hidden="true">
          {EFFORT_STOPS.map((candidate) => (
            <span key={candidate} className={candidate === stop ? "text-snow" : ""}>{effortStopLabel(candidate)}</span>
          ))}
        </div>
      </div>
      <p className="text-[10px] leading-relaxed text-mist/70">
        {coworkerName} takes this into account for every reply, Worker, and assignment; the exact effort is chosen per turn and shown under a reply's details.
      </p>
    </div>
  );

  if (!compact) return <div data-testid="effort-dial" data-stop={stop}>{dial}</div>;

  return (
    <div ref={rootRef} className="relative" data-testid="effort-dial" data-stop={stop}>
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[9px] text-mist hover:border-white/20 hover:text-snow"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={`How hard ${coworkerName} should work`}
        data-testid="effort-dial-pill"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="text-mist/70">Effort</span>
        <span className="font-medium text-snow/85">{effortStopLabel(stop)}</span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div role="dialog" aria-label={`How hard ${coworkerName} should work`} className="absolute bottom-full right-0 z-30 mb-2 rounded-2xl border border-line bg-panel p-4 shadow-xl">
          {dial}
        </div>
      ) : null}
    </div>
  );
}
