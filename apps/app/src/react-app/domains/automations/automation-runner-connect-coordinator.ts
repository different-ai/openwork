type Schedule = (callback: () => void, delayMs: number) => () => void

type AutomationRunnerConnectCoordinatorOptions = {
  connect: (isCurrent: () => boolean) => Promise<void | "disconnected">
  refreshMs: number
  disconnectedRetryMs: number
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
  let running: Promise<void | "disconnected"> | undefined
  let cancelRefresh: (() => void) | undefined
  let rejectionAttempt = 0
  let failureAttempt = 0
  const schedule = options.schedule ?? defaultSchedule

  const clearRefresh = () => {
    cancelRefresh?.()
    cancelRefresh = undefined
  }

  const request = (resetRejections = true) => {
    if (disposed) return Promise.resolve(undefined)
    clearRefresh()
    if (resetRejections) rejectionAttempt = 0
    revision += 1
    if (running) return running
    const drain = async () => {
      while (!disposed) {
        const connectRevision = revision
        let outcome: void | "disconnected"
        try {
          outcome = await options.connect(() => !disposed && revision === connectRevision)
        } catch (error) {
          if (disposed || connectRevision !== revision) continue
          throw error
        }
        if (connectRevision === revision) return outcome
      }
    }
    const task = drain()
    running = task
    const settle = (nextMs: number | null) => {
      if (running !== task) return
      running = undefined
      failureAttempt = nextMs === null ? failureAttempt + 1 : 0
      if (!disposed && !cancelRefresh) {
        cancelRefresh = schedule(() => {
          cancelRefresh = undefined
          void request().catch(() => undefined)
        }, nextMs ?? Math.min(30_000, 1_000 * (2 ** Math.min(failureAttempt - 1, 5))))
      }
    }
    void task.then(
      (outcome) => settle(outcome === "disconnected" ? options.disconnectedRetryMs : options.refreshMs),
      () => settle(null),
    )
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
    computerDisconnected() {
      if (disposed) return
      clearRefresh()
      cancelRefresh = schedule(() => {
        cancelRefresh = undefined
        void request().catch(() => undefined)
      }, options.disconnectedRetryMs)
    },
    dispose() {
      disposed = true
      revision += 1
      clearRefresh()
    },
  }
}
