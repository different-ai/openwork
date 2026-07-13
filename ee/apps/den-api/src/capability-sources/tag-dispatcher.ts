import {
  claimNextTagEvent,
  retryTagEvent,
  setTagEventStatus,
  type TagEventRow,
} from "./tag-store.js"
import { isRetryableTagSlackOAuthError } from "./tag-slack-oauth.js"

const DISPATCH_INTERVAL_MS = 2_000
const MAX_EVENTS_PER_DRAIN = 20
const DISPATCH_CONCURRENCY = 4

type TagEventProcessor = (event: TagEventRow) => Promise<void>

let processor: TagEventProcessor | null = null
let drainPromise: Promise<void> | null = null
let interval: ReturnType<typeof setInterval> | null = null

export class RetryableTagEventError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error))
    this.name = "RetryableTagEventError"
  }
}

export function setTagEventProcessor(next: TagEventProcessor) {
  processor = next
}

async function drainTagLane(limit: number, activeProcessor: TagEventProcessor) {
  for (let index = 0; index < limit; index += 1) {
    const event = await claimNextTagEvent()
    if (!event) return
    try {
      await activeProcessor(event)
    } catch (error) {
      if (!event.processingToken) continue
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof RetryableTagEventError || isRetryableTagSlackOAuthError(error)) {
        await retryTagEvent({
          connectionId: event.connectionId,
          error: message,
          id: event.id,
          processingToken: event.processingToken,
        })
      } else {
        await setTagEventStatus({
          connectionId: event.connectionId,
          error: message,
          id: event.id,
          processingToken: event.processingToken,
          status: "failed",
        })
      }
    }
  }
}

async function drainTagEvents() {
  if (!processor) return
  const laneLimit = Math.ceil(MAX_EVENTS_PER_DRAIN / DISPATCH_CONCURRENCY)
  await Promise.all(Array.from(
    { length: DISPATCH_CONCURRENCY },
    () => drainTagLane(laneLimit, processor as TagEventProcessor),
  ))
}

export function triggerTagEventDispatcher() {
  if (drainPromise) return
  drainPromise = drainTagEvents().finally(() => {
    drainPromise = null
  })
  void drainPromise.catch((error) => console.error("[tag] event dispatcher failed", error))
}

export function startTagEventDispatcher() {
  if (interval) return
  triggerTagEventDispatcher()
  interval = setInterval(triggerTagEventDispatcher, DISPATCH_INTERVAL_MS)
  interval.unref()
}
