import { ApiError } from "./errors.js";
import type { ManagedOpencodeV2Server } from "./managed-opencode-v2.js";
import { isRecord } from "./workspace-kv-store.js";

export function sandboxPolicyPending() {
  return new ApiError(409, "sandbox_engine_policy_pending", "Your sandbox setting is saved and applies when current tasks finish. Send this again then.");
}

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
    throw new ApiError(409, "sandbox_engine_activity_unavailable", "OpenWork couldn’t check whether tasks have finished. Try again once they’re done.");
  }
  if (Object.keys(sessions.json.data).length || jobs.json.data.some(job => isRecord(job) && job.status === "running")) {
    throw new ApiError(409, "sandbox_engine_busy", "Wait for current tasks to finish, then try again.");
  }
}
