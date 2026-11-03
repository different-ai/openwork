/**
 * Whether a read replica may serve reads. Each check reads this process's
 * heartbeat through the replica and on the primary, then writes the next beat.
 * A replica that is behind, unreachable, or another database (one that never
 * receives this process's beats) fails, and reads use the primary until a
 * later check finds it current. Nothing is trusted before the first check.
 */
export type ReplicaHealth = {
  /** Whether replica-routed reads may use the replica right now. */
  healthy(): boolean
  /** Runs one check now; overlapping calls share it. */
  check(): Promise<boolean>
  stop(): void
}

export type ReplicaHeartbeat = {
  /** This process's last beat as the target sees it, or null without one. */
  read(target: "primary" | "replica"): Promise<Date | null>
  /** Records a new beat on the primary. */
  write(): Promise<void>
}

/** Checks run this often. */
export const REPLICA_CHECK_INTERVAL_MS = 10_000
/** A replica further behind the primary than this serves no reads. */
export const REPLICA_MAX_LAG_MS = 30_000
/** The first beat is written at start; the first check waits this long for it to reach the replica. */
const FIRST_CHECK_DELAY_MS = 2_000

function describe(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)
}

export function createReplicaHealth(input: {
  heartbeat: ReplicaHeartbeat
  /** 0 runs no timers: checks happen only when `check` is called. */
  intervalMs?: number
  maxLagMs?: number
  log?: Pick<Console, "error" | "info">
}): ReplicaHealth {
  const intervalMs = input.intervalMs ?? REPLICA_CHECK_INTERVAL_MS
  const maxLagMs = input.maxLagMs ?? REPLICA_MAX_LAG_MS
  const log = input.log ?? console
  let healthy = false
  let reported: boolean | null = null
  let running: Promise<boolean> | null = null

  const report = (next: boolean, detail: Record<string, unknown>) => {
    if (next === reported) return
    // The first passing check is the normal start, so only a change or a failure is logged.
    if (!next) log.error("[db] read replica is not current; replica-routed reads use the primary", detail)
    else if (reported === false) log.info("[db] read replica is current again; reads use it", detail)
    reported = next
  }

  const check = () => running ??= (async () => {
    let next = false
    let detail: Record<string, unknown>
    try {
      // The replica is read first, so a beat landing between the two reads can only make it look further behind.
      const replica = await input.heartbeat.read("replica")
      const primary = await input.heartbeat.read("primary")
      const lagMs = primary && replica ? primary.getTime() - replica.getTime() : null
      next = lagMs !== null && lagMs <= maxLagMs
      detail = lagMs === null ? { reason: replica ? "no_primary_beat" : "no_replica_beat" } : { lagMs }
    } catch (error) {
      detail = { reason: "check_failed", error: describe(error) }
    }
    // A failed write shows up as lag on a later check.
    await input.heartbeat.write().catch(() => undefined)
    healthy = next
    report(next, detail)
    return next
  })().finally(() => { running = null })

  const timers: Array<ReturnType<typeof setTimeout>> = []
  if (intervalMs > 0) {
    void input.heartbeat.write().catch(() => undefined)
    timers.push(setTimeout(() => void check(), Math.min(FIRST_CHECK_DELAY_MS, intervalMs)))
    timers.push(setInterval(() => void check(), intervalMs))
    for (const timer of timers) timer.unref?.()
  }

  return {
    healthy: () => healthy,
    check,
    stop() {
      for (const timer of timers) clearTimeout(timer)
    },
  }
}
