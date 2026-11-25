import { appLogger } from "../observability/logger.js"
import { captureException } from "../observability/runtime.js"
import { withPrimaryReads } from "../read-routing.js"
import { claimNextAnalysis, claimNextApply, expireSecretInputs } from "./repository.js"
import { analyzeClaimedChangeRequest, applyClaimedChangeRequest } from "./service.js"

const logger = appLogger.child({ component: "config_blob_worker" })
const DEFAULT_INTERVAL_MS = 1_000
const MAX_PER_TICK = 10
const EXPIRE_EVERY_MS = 60_000
const EXPIRE_BATCH = 50
let lastExpiryAt = 0

export type ConfigBlobWorkerTick = { analyzed: number; applied: number; expired: number }

export function runConfigBlobWorkerOnce(options: { now?: Date } = {}): Promise<ConfigBlobWorkerTick> {
  return withPrimaryReads(() => runTick(options))
}

async function runTick(options: { now?: Date }): Promise<ConfigBlobWorkerTick> {
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
