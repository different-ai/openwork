/** @jsxImportSource react */
import { useEffect } from "react";

import { publishInspectorSlice, recordInspectorEvent } from "./app-inspector";
import { recordDebugLog } from "./debug-logger";

type RenderWatchdogDetails = Record<string, unknown>;

type RenderWatchdogStats = {
  name: string;
  totalCommits: number;
  windowCommits: number;
  windowStartedAt: number;
  lastCommitAt: number;
  lastWarnAt: number;
  lastDetails?: RenderWatchdogDetails;
};

const WINDOW_MS = 2_000;
const WARN_COMMIT_THRESHOLD = 40;
const WARN_COOLDOWN_MS = 5_000;
const statsByName = new Map<string, RenderWatchdogStats>();
let inspectorInstalled = false;

export function readReactRenderWatchdogSnapshot() {
  return Array.from(statsByName.values())
    .map((stats) => ({
      name: stats.name,
      totalCommits: stats.totalCommits,
      windowCommits: stats.windowCommits,
      windowAgeMs: Math.max(0, Date.now() - stats.windowStartedAt),
      lastCommitAgeMs: Math.max(0, Date.now() - stats.lastCommitAt),
      lastWarnAgeMs: stats.lastWarnAt > 0 ? Math.max(0, Date.now() - stats.lastWarnAt) : null,
      lastDetails: stats.lastDetails ?? null,
    }))
    .sort((a, b) => b.windowCommits - a.windowCommits || b.totalCommits - a.totalCommits);
}

export function resetReactRenderWatchdogStats() {
  statsByName.clear();
}

function installInspectorSlice() {
  if (inspectorInstalled) return;
  inspectorInstalled = true;
  publishInspectorSlice("reactRenderWatchdog", () => ({
    windowMs: WINDOW_MS,
    warnCommitThreshold: WARN_COMMIT_THRESHOLD,
    components: readReactRenderWatchdogSnapshot(),
  }));
}

function recordCommit(name: string, details?: RenderWatchdogDetails) {
  installInspectorSlice();
  const now = Date.now();
  let stats = statsByName.get(name);
  if (!stats) {
    stats = {
      name,
      totalCommits: 0,
      windowCommits: 0,
      windowStartedAt: now,
      lastCommitAt: now,
      lastWarnAt: 0,
    };
    statsByName.set(name, stats);
  }

  if (now - stats.windowStartedAt > WINDOW_MS) {
    stats.windowStartedAt = now;
    stats.windowCommits = 0;
  }

  stats.totalCommits += 1;
  stats.windowCommits += 1;
  stats.lastCommitAt = now;
  stats.lastDetails = details;

  if (
    stats.windowCommits >= WARN_COMMIT_THRESHOLD &&
    now - stats.lastWarnAt > WARN_COOLDOWN_MS
  ) {
    stats.lastWarnAt = now;
    const payload = {
      component: name,
      windowCommits: stats.windowCommits,
      windowMs: WINDOW_MS,
      totalCommits: stats.totalCommits,
      details: details ?? null,
    };
    recordInspectorEvent("react.render_loop_suspected", payload);
    recordDebugLog({
      level: "warn",
      source: "react-render-watchdog",
      message: "react.render_loop_suspected",
      extra: payload,
    });
  }
}

export function useReactRenderWatchdog(name: string, details?: RenderWatchdogDetails) {
  useEffect(() => {
    recordCommit(name, details);
  });
}
