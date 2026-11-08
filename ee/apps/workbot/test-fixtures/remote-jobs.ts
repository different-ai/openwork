import type { WorkbotRemoteJob } from "@openwork/types/workbot-remote-jobs"

/** UI-only deterministic fixtures; no registered computer is contacted or stopped. */
export function fixtureRemoteJobs(stopped = false): WorkbotRemoteJob[] {
  const now = Date.now()
  const job = (id: string, state: "running" | "waiting" | "idle", startedAt: number, title: string, latestStep: string): WorkbotRemoteJob => ({
    key: `command:${id}`, ref: { commandId: id }, title, target: "registered", toolCallId: `call-${id}`, turnId: "remote-parent", startedAt,
    watcherTaskIds: id === "fixture-running" ? ["remote-parent.t1"] : [], stale: false,
    status: { ref: id, changed: true, version: "v1", target: "desktop", state, waitingFor: state === "waiting" ? "permission" : null,
      title, computerId: "fixture-studio", computerLabel: "Mac Studio", sessionId: `session-${id}`, workspaceId: "workspace-fixture", messageCount: 4,
      preview: state === "idle" ? "The checks passed. The draft is ready." : null, latestStep, error: null, observedAt: now },
  })
  return [
    job("fixture-running", stopped ? "idle" : "running", now - 6 * 60_000, "Review the browser changes", "Checking the mobile browser flow"),
    job("fixture-waiting", "waiting", now - 12 * 60_000, "Review the UI changes", "Waiting for permission to run checks"),
    job("fixture-done", "idle", now - 30 * 60_000, "Check the release notes", "Verified the final changes"),
  ]
}

/**
 * Production on Nov 8: the last status refresh failed, so every row carries its last verified state (stale).
 * Titles mirror the reported rows; nothing is contacted.
 */
export function fixtureStaleRemoteJobs(): WorkbotRemoteJob[] {
  const now = Date.now()
  const job = (id: string, state: "running" | "idle", startedAt: number, title: string, checkedAgo: number, preview: string | null = null): WorkbotRemoteJob => ({
    key: `command:${id}`, ref: { commandId: id }, title, target: "desktop", toolCallId: `call-${id}`, turnId: "remote-parent", startedAt,
    watcherTaskIds: [], stale: true, checkedAt: now - checkedAgo,
    status: { ref: id, changed: true, version: "v1", target: "desktop", state, waitingFor: null,
      title, computerId: "fixture-studio", computerLabel: "Benjamin’s Mac Studio", sessionId: `session-${id}`, workspaceId: "workspace-fixture", messageCount: 40,
      preview, latestStep: state === "running" ? "Ran a command" : null, error: null, observedAt: now - checkedAgo },
  })
  return [
    job("fixture-browser", "idle", now - 9 * 3_600_000, "Workbot browser: why it fails + fix", 4 * 60_000, "#7137 is cleanly stacked on merged #7136."),
    job("fixture-round-two", "idle", now - 8 * 3_600_000, "Workbot UI round 2: profile, waiting, human reply", 4 * 60_000),
    job("fixture-card", "running", now - 20 * 60_000, "Workbot browser card: no Computer flash", 2 * 60_000),
    job("fixture-den", "idle", now - 11 * 3_600_000, "Investigate DEN-API-6A DB connect timeout", 4 * 60_000, "A brief network hiccup between den-api and PlanetScale."),
    job("fixture-merge", "idle", now - 10 * 3_600_000, "Fix merge order: Workbot UI PRs onto dev", 4 * 60_000),
    job("fixture-plan", "idle", now - 13 * 3_600_000, "Plan: Workbot introspection of background tasks", 4 * 60_000),
  ]
}
