// Pure first-build readiness model; rendered by components/build-readiness.tsx.

/** Snapshot layers in build order, as reported by GET /r/<id>/launch. */
export const BUILD_LAYERS = ["tools", "dependencies", "compiled", "running-template", "world"];

export interface BuildStepView { id: string; ms: number }

/** What the page has seen of one first build, kept monotonic across polls. */
export interface BuildTracker {
  started: number;
  /** Furthest layer index seen; -1 while the commit is still being read. */
  furthest: number;
  layerStarted: number[];
  layerEnded: number[];
  steps: BuildStepView[];
  failed: boolean;
}

export function startTracking(now: number): BuildTracker {
  return { started: now, furthest: -1, layerStarted: [], layerEnded: [], steps: [], failed: false };
}

/**
 * Folds one poll into the tracker. No builder is alive between layers, so a poll
 * without a layer keeps what was seen; progress never moves backwards.
 */
export function advance(tracker: BuildTracker, poll: { layer?: string; steps: BuildStepView[] }, now: number): BuildTracker {
  const index = poll.layer === undefined ? -1 : BUILD_LAYERS.indexOf(poll.layer);
  const next: BuildTracker = { ...tracker, layerStarted: [...tracker.layerStarted], layerEnded: [...tracker.layerEnded] };
  if (index > tracker.furthest) {
    if (tracker.furthest >= 0 && next.layerEnded[tracker.furthest] === undefined) next.layerEnded[tracker.furthest] = now;
    next.layerStarted[index] = now;
    next.furthest = index;
  }
  if (index === 3 && poll.steps.length >= tracker.steps.length) next.steps = poll.steps;
  return next;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export type RowState = "done" | "running" | "pending" | "failed";
export interface Row { label: string; state: RowState; detail?: string }

export const TYPICAL: Record<string, string> = { "app-web": "about 2 min", "acme-web": "about 6 min", desktop: "about 3 min" };
export const STEP_LABELS: Record<string, string> = {
  checkout: "Check out", compile: "Unpack build", "boot-and-verify": "Boot and verify", "world-services": "Den, database and engine",
  "den-pages": "Den pages", "app-modules": "App modules", "gateway-probe": "AI Gateway", desktop: "Desktop app",
};
const SECTIONS: { label: string; layers: number[] }[] = [
  { label: "Dependencies", layers: [0, 1] },
  { label: "Build OpenWork", layers: [2] },
  { label: "Start services", layers: [3] },
  { label: "Apply this commit", layers: [4] },
];

// ACME reports its services one by one; its boot step is then only their total.
const SERVICE_STEPS = new Set(["world-services", "den-pages", "app-modules", "gateway-probe", "desktop"]);

/** Sub-steps worth showing: the umbrella boot step is hidden when its parts are known. */
export function visibleSteps(steps: BuildStepView[]): BuildStepView[] {
  return steps.some((step) => SERVICE_STEPS.has(step.id)) ? steps.filter((step) => step.id !== "boot-and-verify") : steps;
}

export function readinessRows(tracker: BuildTracker, now: number): Row[] {
  const firstSeen = tracker.layerStarted.find((value) => value !== undefined);
  const rows: Row[] = [tracker.furthest >= 0
    ? { label: "Read this commit", state: "done", detail: firstSeen === undefined ? undefined : formatElapsed(firstSeen - tracker.started) }
    : { label: "Read this commit", state: tracker.failed ? "failed" : "running", detail: formatElapsed(now - tracker.started) }];
  for (const section of SECTIONS) {
    const last = Math.max(...section.layers);
    const seen = section.layers.filter((layer) => tracker.layerStarted[layer] !== undefined);
    const spent = seen.reduce((total, layer) => total + (tracker.layerEnded[layer] ?? now) - tracker.layerStarted[layer], 0);
    if (tracker.furthest > last) rows.push({ label: section.label, state: "done", detail: seen.length ? formatElapsed(spent) : "cached" });
    else if (section.layers.includes(tracker.furthest)) rows.push({ label: section.label, state: tracker.failed ? "failed" : "running", detail: formatElapsed(spent) });
    else rows.push({ label: section.label, state: "pending" });
  }
  return rows;
}

