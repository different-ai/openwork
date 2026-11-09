/**
 * The config change request worker: a table-as-queue loop (as in
 * slack-assistant / github-sync). Each tick analyzes what was uploaded or went
 * stale, then applies what is queued, one request per organization at a time
 * (`claimNextApply` holds the org's apply lock through the claim's lease; a
 * long apply extends it). Organizations with `configBlobs` off are skipped:
 * their requests are put back and wait until the feature is on again.
 */
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import { claimNextAnalysis, claimNextApply } from "./repository.js"
import { analyzeClaimedChangeRequest, applyClaimedChangeRequest } from "./service.js"

const logger = appLogger.child({ component: "config_blob_worker" })
const DEFAULT_INTERVAL_MS = 1_000
/** Bounds one tick so a burst of uploads never starves the applies behind it. */
const MAX_PER_TICK = 10

export type ConfigBlobWorkerTick = { analyzed: number; applied: number }

/** One pass: up to MAX_PER_TICK analyses, then up to MAX_PER_TICK applies. Exposed for tests. */
export async function runConfigBlobWorkerOnce(): Promise<ConfigBlobWorkerTick> {
  const tick: ConfigBlobWorkerTick = { analyzed: 0, applied: 0 }
  for (let index = 0; index < MAX_PER_TICK; index += 1) {
    const claim = await claimNextAnalysis()
    if (!claim) break
    if (await analyzeClaimedChangeRequest(claim)) tick.analyzed += 1
  }
  for (let index = 0; index < MAX_PER_TICK; index += 1) {
    const claim = await claimNextApply()
    if (!claim) break
    try {
      if (await applyClaimedChangeRequest(claim)) tick.applied += 1
    } catch (error) {
      // The lease expires and the request is claimed again; nothing else to do here.
      logger.error("config change request apply crashed", { change_request_id: claim.id, organization_id: claim.organizationId, error })
      captureException(error, { component: "config_blob_worker" })
    }
  }
  return tick
}

export function startConfigBlobWorker(intervalMs = DEFAULT_INTERVAL_MS): () => Promise<void> {
  let running: Promise<void> | null = null
  const run = () => {
    if (running) return
    running = runConfigBlobWorkerOnce()
      .then(() => undefined)
      .catch((error: unknown) => {
        logger.error("config blob worker tick failed", { error })
        captureException(error, { component: "config_blob_worker" })
      })
      .finally(() => {
        running = null
      })
  }
  const timer = Number.isFinite(intervalMs) && intervalMs > 0 ? setInterval(run, intervalMs) : null
  timer?.unref()
  return async () => {
    if (timer) clearInterval(timer)
    await running
  }
}
