/** @jsxImportSource react */

/**
 * Dev-only React profiler + overlay.
 *
 * <DevProfiler id="SessionSurface"> wraps a subtree with React's built-in
 * <Profiler>. It aggregates commits per id (count, total time, self time,
 * last commit timestamp, recent burst).
 *
 * <DevProfilerOverlay /> renders a small floating card in the bottom-right
 * that shows the hottest zones. Toggle with Cmd+Shift+P or set
 * localStorage.openwork.debug.profilerOverlay = "1" / "0".
 *
 * In prod builds the wrapper is a pass-through (no Profiler overhead) and
 * the overlay renders null.
 *
 * Findings also land on window.__openwork.slice("profiler") so external
 * tools / Chrome MCP can read them.
 */

import {
  Profiler,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";

import { publishInspectorSlice } from "./app-inspector";

type CommitRecord = {
  id: string;
  phase: "mount" | "update" | "nested-update";
  actualMs: number;
  baseMs: number;
  commitAt: number;
};

type ZoneStats = {
  id: string;
  commitCount: number;
  totalActualMs: number;
  totalBaseMs: number;
  lastActualMs: number;
  lastBaseMs: number;
  lastCommitAt: number;
  lastPhase: CommitRecord["phase"];
  mountCount: number;
  updateCount: number;
};

type ProfilerState = {
  zonesById: Map<string, ZoneStats>;
  recent: CommitRecord[];
};

// Profiler is OFF BY DEFAULT, even in dev builds.
//
// Running React's <Profiler> under sustained streaming commits causes the
// browser's performance timeline to accumulate `measure` entries faster than
// it can reclaim them; React-dom's own `logComponentRender` eventually hits
// "Failed to execute 'measure' on 'Performance': Data cannot be cloned, out
// of memory" and the webview freezes mid-stream. That matches the "stream
// produces 2 words then the app blocks" symptom.
//
// Explicit opt-ins:
//   - VITE_OPENWORK_PROFILER=1 at `pnpm dev`
//   - window.localStorage.setItem("openwork.debug.profiler", "1")
// When off, <DevProfiler> is a pure pass-through (no <Profiler> mounted) and
// the overlay renders null.
const PROFILER_ENABLED = (() => {
  if (typeof window === "undefined") return false;
  try {
    const env = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {};
    const flag = env.VITE_OPENWORK_PROFILER;
    if (flag === "1" || flag === "true" || flag === true) return true;
  } catch {
    // ignore
  }
  try {
    if (window.localStorage.getItem("openwork.debug.profiler") === "1") return true;
  } catch {
    // ignore
  }
  return false;
})();

const RECENT_MAX = 200;

const state: ProfilerState = {
  zonesById: new Map(),
  recent: [],
};

const subscribers = new Set<() => void>();

function emit() {
  for (const fn of subscribers) {
    try {
      fn();
    } catch {
      // ignore faulty subscribers
    }
  }
}

function readSnapshot() {
  const zones = Array.from(state.zonesById.values()).sort(
    (a, b) => b.commitCount - a.commitCount,
  );
  return {
    zones,
    recent: state.recent.slice(-20),
    totalCommits: zones.reduce((acc, z) => acc + z.commitCount, 0),
    totalActualMs: Math.round(zones.reduce((acc, z) => acc + z.totalActualMs, 0) * 10) / 10,
  };
}

// Register a top-level inspector slice so the snapshot is accessible via
// window.__openwork.slice("profiler") — even for operators who aren't
// looking at the overlay.
if (typeof window !== "undefined") {
  publishInspectorSlice("profiler", readSnapshot);
}

function recordCommit(record: CommitRecord) {
  // Fast path: when nobody is listening (overlay hidden, no external
  // reader), don't mutate the map at all. This is critical — otherwise the
  // overlay renders, re-renders itself inside the profiler zone, records
  // its own commit, schedules another emit, re-renders, and so on forever.
  // With zero subscribers we also never schedule an rAF, so the profiler
  // is effectively free when it's off.
  if (subscribers.size === 0) return;

  const prev = state.zonesById.get(record.id);
  if (!prev) {
    state.zonesById.set(record.id, {
      id: record.id,
      commitCount: 1,
      totalActualMs: record.actualMs,
      totalBaseMs: record.baseMs,
      lastActualMs: record.actualMs,
      lastBaseMs: record.baseMs,
      lastCommitAt: record.commitAt,
      lastPhase: record.phase,
      mountCount: record.phase === "mount" ? 1 : 0,
      updateCount: record.phase === "mount" ? 0 : 1,
    });
  } else {
    prev.commitCount += 1;
    prev.totalActualMs += record.actualMs;
    prev.totalBaseMs += record.baseMs;
    prev.lastActualMs = record.actualMs;
    prev.lastBaseMs = record.baseMs;
    prev.lastCommitAt = record.commitAt;
    prev.lastPhase = record.phase;
    if (record.phase === "mount") prev.mountCount += 1;
    else prev.updateCount += 1;
  }
  state.recent.push(record);
  if (state.recent.length > RECENT_MAX) {
    state.recent.splice(0, state.recent.length - RECENT_MAX);
  }
  // Notify overlay subscribers. We throttle via rAF so a burst of commits
  // during a stream doesn't flood setState.
  scheduleEmit();
}

let emitScheduled = false;
function scheduleEmit() {
  if (emitScheduled) return;
  if (typeof window === "undefined") return;
  if (subscribers.size === 0) return;
  emitScheduled = true;
  window.requestAnimationFrame(() => {
    emitScheduled = false;
    emit();
  });
}

const onRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  _startTime,
  commitTime,
) => {
  recordCommit({
    id,
    phase: phase as CommitRecord["phase"],
    actualMs: Math.round(actualDuration * 10) / 10,
    baseMs: Math.round(baseDuration * 10) / 10,
    commitAt: commitTime,
  });
};

/**
 * Zone wrapper. In prod this is a pass-through and the Profiler is never
 * mounted so we don't pay the runtime cost.
 */
export function DevProfiler({
  id,
  children,
}: PropsWithChildren<{ id: string }>): ReactNode {
  if (!PROFILER_ENABLED) return children as ReactNode;
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  );
}

function readOverlayStoredPreference(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("openwork.debug.profilerOverlay");
    if (raw === "1") return true;
    if (raw === "0") return false;
    return null;
  } catch {
    return null;
  }
}

function writeOverlayStoredPreference(value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("openwork.debug.profilerOverlay", value ? "1" : "0");
  } catch {
    // ignore
  }
}

export function useDevProfilerSnapshot() {
  const [snapshot, setSnapshot] = useState(readSnapshot);
  useEffect(() => {
    const tick = () => setSnapshot(readSnapshot());
    subscribers.add(tick);
    return () => {
      subscribers.delete(tick);
    };
  }, []);
  return snapshot;
}

export function DevProfilerOverlay() {
  if (!PROFILER_ENABLED) return null;
  return <DevProfilerOverlayToggle />;
}

/**
 * Owns only visibility state + the global keybind. Does NOT subscribe to
 * profiler snapshots. When the user toggles the overlay on, it mounts
 * <DevProfilerOverlayVisible/> which is the only component that subscribes.
 * This means when the overlay is hidden there are zero subscribers and
 * `recordCommit` short-circuits — the profiler becomes free.
 */
function DevProfilerOverlayToggle() {
  const stored = readOverlayStoredPreference();
  const [visible, setVisible] = useState(stored === null ? false : stored);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const metaOrCtrl = event.metaKey || event.ctrlKey;
      if (!metaOrCtrl || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      setVisible((prev) => {
        writeOverlayStoredPreference(!prev);
        return !prev;
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!visible) return null;
  return <DevProfilerOverlayVisible onHide={() => {
    writeOverlayStoredPreference(false);
    setVisible(false);
  }} />;
}

function DevProfilerOverlayVisible({ onHide }: { onHide: () => void }) {
  const [collapsed, setCollapsed] = useState(false);
  const snapshot = useDevProfilerSnapshot();
  const lastCommitByIdRef = useRef<Record<string, number>>({});

  // Flash zones whose lastCommitAt changed since the previous render so
  // operators can spot hot spots.
  const flashing = new Set<string>();
  const now = performance.now();
  for (const zone of snapshot.zones) {
    const prev = lastCommitByIdRef.current[zone.id];
    if (prev !== zone.lastCommitAt) {
      lastCommitByIdRef.current[zone.id] = zone.lastCommitAt;
      if (now - zone.lastCommitAt < 500) {
        flashing.add(zone.id);
      }
    }
  }

  const topZones = snapshot.zones.slice(0, 12);

  return (
    <div
      className="pointer-events-auto fixed bottom-3 right-3 z-[1100] w-[280px] overflow-hidden rounded-lg border border-dls-border bg-dls-canvas/95 text-[11px] text-dls-text backdrop-blur-sm"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between border-b border-dls-border px-2.5 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-dls-secondary">
            react profiler
          </span>
          <span className="text-[10px] text-dls-secondary">
            {snapshot.totalCommits} commits · {snapshot.totalActualMs}ms
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-dls-secondary hover:bg-dls-hover"
            onClick={() => {
              state.zonesById.clear();
              state.recent.length = 0;
              emit();
            }}
            title="Reset counters"
          >
            reset
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-dls-secondary hover:bg-dls-hover"
            onClick={() => setCollapsed((value) => !value)}
            title="Collapse"
          >
            {collapsed ? "+" : "–"}
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-[10px] text-dls-secondary hover:bg-dls-hover"
            onClick={onHide}
            title="Hide (Cmd+Shift+P to toggle)"
          >
            ×
          </button>
        </div>
      </div>
      {collapsed ? null : (
        <div className="max-h-[50vh] overflow-y-auto">
          {topZones.length === 0 ? (
            <div className="px-3 py-3 text-dls-secondary">
              No profiler data yet. Interact with the app.
            </div>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-[10px] uppercase tracking-[0.1em] text-dls-secondary">
                  <th className="px-2 py-1 text-left font-medium">zone</th>
                  <th className="px-2 py-1 text-right font-medium">#</th>
                  <th className="px-2 py-1 text-right font-medium">last</th>
                  <th className="px-2 py-1 text-right font-medium">total</th>
                </tr>
              </thead>
              <tbody>
                {topZones.map((zone) => {
                  const isFlashing = flashing.has(zone.id);
                  return (
                    <tr
                      key={zone.id}
                      className={`border-t border-dls-border transition-colors ${
                        isFlashing ? "bg-[rgba(var(--dls-accent-rgb),0.14)]" : ""
                      }`}
                    >
                      <td className="px-2 py-1 font-mono text-[11px] text-dls-text">
                        <span className="block truncate" title={zone.id}>
                          {zone.id}
                        </span>
                        <span className="block text-[9px] uppercase tracking-[0.1em] text-dls-secondary">
                          {zone.mountCount}m · {zone.updateCount}u
                        </span>
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {zone.commitCount}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-dls-secondary">
                        {zone.lastActualMs}ms
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-dls-secondary">
                        {Math.round(zone.totalActualMs)}ms
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
      <div className="border-t border-dls-border px-2.5 py-1 text-[10px] text-dls-secondary">
        Cmd+Shift+P to toggle. Prod builds: off.
      </div>
    </div>
  );
}
