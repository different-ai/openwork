import { ApiError } from "./errors.js";
import type { ManagedOpencodeV2Server } from "./managed-opencode-v2.js";
import { isRecord } from "./workspace-kv-store.js";

/** Pinned v2 global APIs: no location query and no target-workspace plugin
 * initialization. Include background shell/subagent/image work, not just drains. */
export async function assertSandboxEngineIdle(active: Pick<ManagedOpencodeV2Server, "fetchJson">): Promise<void> {
  const results = await Promise.all([
    active.fetchJson("/api/session/active", { timeoutMs: 5_000 }),
    active.fetchJson("/api/experimental/job?status=running", { timeoutMs: 5_000 }),
  ]).catch(() => null);
  const sessions = results?.[0];
  const jobs = results?.[1];
  if (sessions?.status !== 200 || !isRecord(sessions.json) || !isRecord(sessions.json.data)
    || jobs?.status !== 200 || !isRecord(jobs.json) || !Array.isArray(jobs.json.data)
    || jobs.json.data.some(job => !isRecord(job) || typeof job.status !== "string")) {
    throw new ApiError(409, "sandbox_engine_activity_unavailable", "OpenWork could not verify that tasks are idle. Retry when your tasks have finished; nothing was restarted.");
  }
  if (Object.keys(sessions.json.data).length || jobs.json.data.some(job => isRecord(job) && job.status === "running")) {
    throw new ApiError(409, "sandbox_engine_busy", "Wait for running tasks and background jobs to finish, then retry this setting or message. Nothing was restarted.");
  }
}
