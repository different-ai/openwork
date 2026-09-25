/**
 * Free Auto runs in the same Gateway process and database as paid Den Gateway traffic. This bounds how much free
 * work one instance runs at once, so a surge of public traffic waits here, or is turned away, instead of piling up
 * behind database locks where it would slow paying customers. Settlement never goes through it.
 */
export class FreeAutoBusyError extends Error {
  readonly status = 503 as const
  readonly code = "free_auto_busy"
  constructor() { super("Auto is busy right now. Try again in a moment.") }
}

export type FreeCapacity = { run<T>(work: () => Promise<T>): Promise<T>; readonly active: number; readonly queued: number }

export function createFreeCapacity(input: { maxActive: number; maxQueued: number }): FreeCapacity {
  let active = 0
  const queue: Array<() => void> = []
  const release = () => {
    const next = queue.shift()
    if (next) next()
    else active--
  }
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      if (active >= input.maxActive) {
        if (queue.length >= input.maxQueued) throw new FreeAutoBusyError()
        await new Promise<void>((resolve) => queue.push(resolve))
      } else active++
      try { return await work() } finally { release() }
    },
    get active() { return active },
    get queued() { return queue.length },
  }
}
