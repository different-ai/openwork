import { AsyncResource } from "node:async_hooks"

type AdmissionCode =
  | "usage_start_capacity"
  | "usage_start_cancelled"
  | "usage_start_deadline"
  | "usage_reservation_missing"
export class UsageWriteAdmissionError extends Error {
  constructor(readonly code: AdmissionCode) {
    super(code)
  }
}
type Job = {
  key: string
  kind: "start" | "settle"
  run: () => Promise<void>
  previous?: Job
  next?: Job
  queued: boolean
  dispose: () => void
}
type Reservation = {
  key: string
  started: boolean
  start?: Promise<void>
  settlement?: Promise<boolean>
}
export type UsageQueueOptions = {
  maxQueuedStarts?: number
  maxQueuedStartsPerMember?: number
  maxInFlight?: number
  maxInFlightPerMember?: number
  startDeadlineMs?: number
}

export function createUsageWriteQueue(concurrency = 8, options: UsageQueueOptions = {}) {
  const limits = {
    maxQueuedStarts: 64,
    maxQueuedStartsPerMember: 8,
    maxInFlight: 128,
    maxInFlightPerMember: 64,
    startDeadlineMs: 2000,
    ...options,
  }
  if (
    ![concurrency, ...Object.values(limits)].every((value) => Number.isInteger(value) && value > 0)
  )
    throw new Error("Invalid write queue bounds")
  const pending = new Map<string, { head: Job; tail: Job }>()
  const ready = new Set<string>(),
    activeKeys = new Set<string>()
  const reservations = new Map<string, Reservation>(),
    inFlightByMember = new Map<string, number>(),
    startsByMember = new Map<string, number>()
  let active = 0,
    queued = 0,
    queuedStarts = 0
  function release(requestId: string) {
    const lease = reservations.get(requestId)
    if (!lease) return
    reservations.delete(requestId)
    const count = (inFlightByMember.get(lease.key) ?? 1) - 1
    if (count) inFlightByMember.set(lease.key, count)
    else inFlightByMember.delete(lease.key)
  }
  function unlink(job: Job) {
    if (!job.queued) return
    const list = pending.get(job.key)
    if (!list) return
    if (job.previous) job.previous.next = job.next
    else if (job.next) list.head = job.next
    if (job.next) job.next.previous = job.previous
    else if (job.previous) list.tail = job.previous
    if (!job.previous && !job.next) {
      pending.delete(job.key)
      ready.delete(job.key)
    }
    job.previous = undefined
    job.next = undefined
    job.queued = false
    queued--
    if (job.kind === "start") {
      queuedStarts--
      const count = (startsByMember.get(job.key) ?? 1) - 1
      if (count) startsByMember.set(job.key, count)
      else startsByMember.delete(job.key)
    }
    job.dispose()
  }
  function drain() {
    while (active < concurrency) {
      const key = ready.values().next().value
      if (key === undefined) return
      ready.delete(key)
      const list = pending.get(key)
      if (!list) continue
      const job = list.head
      unlink(job)
      active++
      activeKeys.add(key)
      void job.run().finally(() => {
        active--
        activeKeys.delete(key)
        if (pending.has(key)) ready.add(key)
        drain()
      })
    }
  }
  function enqueue(job: Job) {
    const list = pending.get(job.key)
    if (list) {
      job.previous = list.tail
      list.tail.next = job
      list.tail = job
    } else pending.set(job.key, { head: job, tail: job })
    queued++
    if (job.kind === "start") {
      queuedStarts++
      startsByMember.set(job.key, (startsByMember.get(job.key) ?? 0) + 1)
    }
    if (!activeKeys.has(job.key)) ready.add(job.key)
    drain()
  }
  return {
    start(
      key: string,
      requestId: string,
      work: () => Promise<void>,
      signal?: AbortSignal,
    ): Promise<void> {
      if (signal?.aborted)
        return Promise.reject(new UsageWriteAdmissionError("usage_start_cancelled"))
      const existing = reservations.get(requestId)
      if (existing)
        return existing.key === key && existing.start
          ? existing.start
          : Promise.reject(new UsageWriteAdmissionError("usage_start_capacity"))
      if (
        queuedStarts >= limits.maxQueuedStarts ||
        (startsByMember.get(key) ?? 0) >= limits.maxQueuedStartsPerMember ||
        reservations.size >= limits.maxInFlight ||
        (inFlightByMember.get(key) ?? 0) >= limits.maxInFlightPerMember
      )
        return Promise.reject(new UsageWriteAdmissionError("usage_start_capacity"))
      const lease: Reservation = { key, started: false }
      reservations.set(requestId, lease)
      inFlightByMember.set(key, (inFlightByMember.get(key) ?? 0) + 1)
      lease.start = new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const cancel = (code: AdmissionCode) => {
          if (!job.queued) return
          unlink(job)
          release(requestId)
          reject(new UsageWriteAdmissionError(code))
          drain()
        }
        const aborted = () => cancel("usage_start_cancelled")
        const job: Job = {
          key,
          kind: "start",
          queued: true,
          dispose: () => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", aborted)
          },
          run: AsyncResource.bind(async () => {
            try {
              if (signal?.aborted) throw new UsageWriteAdmissionError("usage_start_cancelled")
              await work()
              lease.started = true
              resolve()
            } catch (error) {
              release(requestId)
              reject(error)
            }
          }),
        }
        signal?.addEventListener("abort", aborted, { once: true })
        timer = setTimeout(() => cancel("usage_start_deadline"), limits.startDeadlineMs)
        enqueue(job)
      })
      return lease.start
    },
    settle(key: string, requestId: string, work: () => Promise<boolean>): Promise<boolean> {
      const lease = reservations.get(requestId)
      if (!lease || lease.key !== key || !lease.started)
        return Promise.reject(new UsageWriteAdmissionError("usage_reservation_missing"))
      if (lease.settlement) return lease.settlement
      lease.settlement = new Promise<boolean>((resolve, reject) => {
        enqueue({
          key,
          kind: "settle",
          queued: true,
          dispose() {},
          run: AsyncResource.bind(async () => {
            try {
              const result = await Promise.resolve().then(work)
              release(requestId)
              resolve(result)
            } catch (error) {
              lease.settlement = undefined
              reject(error)
            }
          }),
        })
      })
      return lease.settlement
    },
    releaseFailedSettlement(requestId: string) {
      const lease = reservations.get(requestId)
      if (lease?.started && !lease.settlement) release(requestId)
    },
    state() {
      return {
        active,
        queued,
        queuedStarts,
        reservations: reservations.size,
        activeMembers: activeKeys.size,
        limits: { ...limits },
      }
    },
  }
}

export const gatewayUsageWrites = createUsageWriteQueue(8)
