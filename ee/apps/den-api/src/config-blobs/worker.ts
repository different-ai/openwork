/**
 * The config change request worker: a table-as-queue loop (as in
 * slack-assistant / github-sync). Each tick analyzes what was uploaded or went
 * stale, then applies what is queued, one request per organization at a time
 * (`claimNextApply` holds the org's apply lock through the claim's lease; a
 * long apply extends it).
 */
import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import { claimNextAnalysis, claimNextApply, expireSecretInputs } from "./repository.js"
import { analyzeClaimedChangeRequest, applyClaimedChangeRequest } from "./service.js"

const logger = appLogger.child({ component: "config_blob_worker" })
const DEFAULT_INTERVAL_MS = 1_000
/** Bounds one tick so a burst of uploads never starves the applies behind it. */
const MAX_PER_TICK = 10
/** Secret-input expiry runs at most this often (one small indexed query), at most EXPIRE_BATCH requests each time. */
const EXPIRE_EVERY_MS = 60_000
const EXPIRE_BATCH = 50
let lastExpiryAt = 0

export type ConfigBlobWorkerTick = { analyzed: number; applied: number; expired: number }

/**
 * One pass: secret-input expiry (once a minute), then up to MAX_PER_TICK
 * analyses, then up to MAX_PER_TICK applies. Exposed for tests.
 */
export async function runConfigBlobWorkerOnce(options: { now?: Date } = {}): Promise<ConfigBlobWorkerTick> {
  const tick: ConfigBlobWorkerTick = { analyzed: 0, applied: 0, expired: 0 }
  const now = options.now ?? new Date()
  if (options.now || now.getTime() - lastExpiryAt >= EXPIRE_EVERY_MS) {
    lastExpiryAt = now.getTime()
    try {
      tick.expired = (await expireSecretInputs({ now, limit: EXPIRE_BATCH })).length
    } catch (error) {
      logger.error("config secret input expiry failed", { error })
      captureException(error, { component: "config_blob_worker" })
    }
  }
  // A failing claim query (deadlock, lost connection) ends that loop for this tick; applies still get their turn.
  for (let index = 0; index < MAX_PER_TICK; index += 1) {
    let claim: Awaited<ReturnType<typeof claimNextAnalysis>>
    try {
      claim = await claimNextAnalysis()
    } catch (error) {
      logger.error("config change request analysis claim failed", { error })
      captureException(error, { component: "config_blob_worker" })
      break
    }
    if (!claim) break
    try {
      if (await analyzeClaimedChangeRequest(claim)) tick.analyzed += 1
    } catch (error) {
      // The analysis lease expires and the request is analyzed again.
      logger.error("config change request analysis crashed", { change_request_id: claim.id, organization_id: claim.organizationId, error })
      captureException(error, { component: "config_blob_worker" })
    }
  }
  for (let index = 0; index < MAX_PER_TICK; index += 1) {
    let claim: Awaited<ReturnType<typeof claimNextApply>>
    try {
      claim = await claimNextApply()
    } catch (error) {
      logger.error("config change request apply claim failed", { error })
      captureException(error, { component: "config_blob_worker" })
      break
    }
    if (!claim) break
    try {
      if (await applyClaimedChangeRequest(claim)) tick.applied += 1
    } catch (error) {
      // The lease expires; the next claim marks the request failed and its run interrupted, never applies it twice.
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
