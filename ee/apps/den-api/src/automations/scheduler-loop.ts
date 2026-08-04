import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { automationService, type AutomationService } from "./service.js"

export type AutomationSchedulerLoopHandle = { stop(): Promise<void> }

export function startAutomationSchedulerLoop(options: {
  service?: AutomationService
  enabled?: boolean
  pollIntervalMs?: number
  batchSize?: number
  maxConcurrency?: number
} = {}): AutomationSchedulerLoopHandle {
  const service = options.service ?? automationService
  const enabled = options.enabled ?? true
  const pollIntervalMs = Math.max(1_000, options.pollIntervalMs ?? env.automations.pollIntervalMs)
  const batchSize = Math.max(1, Math.min(
    options.batchSize ?? env.automations.batchSize,
    options.maxConcurrency ?? env.automations.maxConcurrency,
  ))
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let cycle: Promise<void> | null = null

  const run = async () => {
    if (stopped) return
    try {
      await service.tick({ batchSize })
    } catch (error) {
      appLogger.error("Automation scheduler cycle failed", {
        component: "automation_scheduler",
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      cycle = null
      if (!stopped) {
        timer = setTimeout(() => {
          cycle = run()
        }, pollIntervalMs)
        timer.unref()
      }
    }
  }

  if (enabled) {
    appLogger.info("Automation scheduler enabled", {
      component: "automation_scheduler",
      poll_interval_ms: pollIntervalMs,
      batch_size: batchSize,
    })
    cycle = run()
  }

  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await cycle?.catch(() => undefined)
      await service.stop()
    },
  }
}
