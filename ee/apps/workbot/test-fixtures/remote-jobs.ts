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
