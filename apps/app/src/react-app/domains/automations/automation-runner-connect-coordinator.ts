type Schedule = (callback: () => void, delayMs: number) => () => void

type AutomationRunnerConnectCoordinatorOptions = {
  connect: (isCurrent: () => boolean) => Promise<void>
  refreshMs: number
  schedule?: Schedule
}

function defaultSchedule(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}

export function createAutomationRunnerConnectCoordinator(
  options: AutomationRunnerConnectCoordinatorOptions,
) {
  let disposed = false
  let revision = 0
  let running: Promise<void> | undefined
  let cancelRefresh: (() => void) | undefined
  let rejectionAttempt = 0
  const schedule = options.schedule ?? defaultSchedule

  const clearRefresh = () => {
    cancelRefresh?.()
    cancelRefresh = undefined
  }

  const request = (resetRejections = true) => {
    if (disposed) return Promise.resolve()
    clearRefresh()
    if (resetRejections) rejectionAttempt = 0
    revision += 1
    if (running) return running
    const drain = async () => {
      while (!disposed) {
        const connectRevision = revision
        await options.connect(() => !disposed && revision === connectRevision)
        if (connectRevision === revision) return
      }
    }
    const task = drain()
    running = task
    const settle = () => {
      if (running !== task) return
      running = undefined
      if (!disposed && !cancelRefresh) {
        cancelRefresh = schedule(() => {
          cancelRefresh = undefined
          void request().catch(() => undefined)
        }, options.refreshMs)
      }
    }
    void task.then(settle, settle)
    return task
  }

  return {
    request: () => request(),
    credentialRejected() {
      if (disposed) return
      clearRefresh()
      const delayMs = rejectionAttempt === 0
        ? 0
        : Math.min(30_000, 500 * (2 ** (rejectionAttempt - 1)))
      rejectionAttempt += 1
      if (delayMs === 0) {
        void request(false).catch(() => undefined)
        return
      }
      cancelRefresh = schedule(() => {
        cancelRefresh = undefined
        void request(false).catch(() => undefined)
      }, delayMs)
    },
    dispose() {
      disposed = true
      revision += 1
      clearRefresh()
    },
  }
}
