"use client";

import { useEffect, useState } from "react";

import { STEP_LABELS, TYPICAL, formatElapsed, readinessRows, visibleSteps, type BuildTracker } from "../lib/build-readiness";
export { advance, startTracking, type BuildStepView, type BuildTracker } from "../lib/build-readiness";

const SPINNER = ["◐", "◓", "◑", "◒"];

/** A CLI-like view of a first build: finished steps with times, the running one, what is left. */
export function BuildReadiness({ tracker, world, worldName }: { tracker: BuildTracker; world: string; worldName: string }) {
  const [now, setNow] = useState(() => Date.now());
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (tracker.failed) return;
    const timer = setInterval(() => { setNow(Date.now()); setFrame((value) => (value + 1) % SPINNER.length); }, 250);
    return () => clearInterval(timer);
  }, [tracker.failed]);
  const rows = readinessRows(tracker, now);
  return <section className="readiness" aria-label="Sandbox build progress">
    <p className="readiness-title">Building {worldName} for this commit{TYPICAL[world] ? ` · usually ${TYPICAL[world]}` : ""}</p>
    <ol>
      {rows.map((row) => <li key={row.label} data-state={row.state}>
        <span className="readiness-glyph" aria-hidden="true">{row.state === "done" ? "✔" : row.state === "failed" ? "✖" : row.state === "running" ? SPINNER[frame] : "·"}</span>
        <span className="readiness-label">{row.label}</span>
        {row.detail && <span className="readiness-detail">{row.detail}</span>}
        {row.label === "Start services" && tracker.steps.length > 0 && <ul>
          {visibleSteps(tracker.steps).map((step) => <li key={step.id} data-state="done">
            <span className="readiness-glyph" aria-hidden="true">✔</span>
            <span className="readiness-label">{STEP_LABELS[step.id] ?? step.id}</span>
            <span className="readiness-detail">{formatElapsed(step.ms)}</span>
          </li>)}
        </ul>}
      </li>)}
    </ol>
    <p className="readiness-footer">{formatElapsed(now - tracker.started)} so far{tracker.failed ? "" : " · opens automatically when ready"}</p>
  </section>;
}
