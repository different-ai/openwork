import { randomUUID } from "node:crypto"
import Redis from "ioredis"
import { appLogger } from "../observability/logger.js"

type Listener = () => void
type ChannelName = "work" | "request_done" | "command_updated" | "user_update"

const REDIS_CHANNEL = "openwork:remote-session-signal:v1"
const INSTANCE_ID = randomUUID()

function createSignalHub(channel: ChannelName) {
  const listeners = new Map<string, Set<Listener>>()
  return {
    on(key: string, listener: Listener): () => void {
      const set = listeners.get(key) ?? new Set<Listener>()
      set.add(listener)
      listeners.set(key, set)
      return () => {
        set.delete(listener)
        if (set.size === 0 && listeners.get(key) === set) listeners.delete(key)
      }
    },
    emitLocal(key: string): void {
      for (const listener of listeners.get(key) ?? []) {
        try {
          listener()
        } catch (error) {
          appLogger.warn("remote_session_signal_listener_error", {
            component: "remote_session_signal",
            channel,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    },
  }
}

const hubs: Record<ChannelName, ReturnType<typeof createSignalHub>> = {
  work: createSignalHub("work"),
  request_done: createSignalHub("request_done"),
  command_updated: createSignalHub("command_updated"),
  user_update: createSignalHub("user_update"),
}

type PubSubState = {
  url: string
  pub: Redis
  sub: Redis
  ready: boolean
}

let pubSub: PubSubState | null = null
let configuredRedisUrl: string | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseSignalPayload(raw: string): { channel: ChannelName; key: string; origin: string } | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    const channel = parsed.channel
    const key = parsed.key
    const origin = parsed.origin
    if (
      (channel === "work" || channel === "request_done" || channel === "command_updated" || channel === "user_update")
      && typeof key === "string"
      && typeof origin === "string"
    ) {
      return { channel, key, origin }
    }
    return null
  } catch {
    return null
  }
}

export function configureRemoteSessionSignalRedis(redisUrl: string | null | undefined) {
  const normalized = redisUrl?.trim() || null
  if (normalized === configuredRedisUrl) return
  configuredRedisUrl = normalized
  const previous = pubSub
  pubSub = null
  if (previous) {
    previous.ready = false
    void previous.sub.quit().catch(() => undefined)
    void previous.pub.quit().catch(() => undefined)
  }
  if (!normalized) return
  const pub = new Redis(normalized, { maxRetriesPerRequest: 2, enableOfflineQueue: false })
  const sub = new Redis(normalized, { maxRetriesPerRequest: 2 })
  const state: PubSubState = { url: normalized, pub, sub, ready: false }
  pub.on("error", (error) => {
    appLogger.warn("remote_session_signal_redis_pub_error", { component: "remote_session_signal", error: error.message })
  })
  sub.on("error", (error) => {
    if (pubSub === state) state.ready = false
    appLogger.warn("remote_session_signal_redis_sub_error", { component: "remote_session_signal", error: error.message })
  })
  sub.on("ready", () => {
    void sub.subscribe(REDIS_CHANNEL).then(() => {
      if (pubSub === state) state.ready = true
    }).catch((error: unknown) => {
      appLogger.warn("remote_session_signal_redis_subscribe_error", {
        component: "remote_session_signal",
        error: error instanceof Error ? error.message : String(error),
      })
    })
  })
  sub.on("close", () => {
    if (pubSub === state) state.ready = false
  })
  sub.on("message", (channel, raw) => {
    if (channel !== REDIS_CHANNEL) return
    const message = parseSignalPayload(raw)
    if (!message || message.origin === INSTANCE_ID) return
    hubs[message.channel].emitLocal(message.key)
  })
  pubSub = state
}

export function hasRemoteSessionSignalPubSub(): boolean {
  return Boolean(pubSub?.ready)
}

function emit(channel: ChannelName, key: string): void {
  hubs[channel].emitLocal(key)
  if (!pubSub) return
  const payload = JSON.stringify({ channel, key, origin: INSTANCE_ID })
  void pubSub.pub.publish(REDIS_CHANNEL, payload).catch((error: unknown) => {
    appLogger.warn("remote_session_signal_redis_publish_error", {
      component: "remote_session_signal",
      channel,
      error: error instanceof Error ? error.message : String(error),
    })
  })
}

function pairKey(left: string, right: string): string {
  return `${left}\0${right}`
}

export function onRemoteSessionWork(organizationId: string, ownerMemberId: string, listener: Listener): () => void {
  return hubs.work.on(pairKey(organizationId, ownerMemberId), listener)
}

export function signalRemoteSessionWork(organizationId: string, ownerMemberId: string): void {
  emit("work", pairKey(organizationId, ownerMemberId))
}

export function onRemoteSessionRequestDone(requestId: string, listener: Listener): () => void {
  return hubs.request_done.on(requestId, listener)
}

export function signalRemoteSessionRequestDone(requestId: string): void {
  emit("request_done", requestId)
}

export function onRemoteSessionCommandUpdated(commandId: string, listener: Listener): () => void {
  return hubs.command_updated.on(commandId, listener)
}

export function signalRemoteSessionCommandUpdated(commandId: string): void {
  emit("command_updated", commandId)
}

export function onRemoteSessionUserUpdate(organizationId: string, userId: string, listener: Listener): () => void {
  return hubs.user_update.on(pairKey(organizationId, userId), listener)
}

export function signalRemoteSessionUserUpdate(organizationId: string, userId: string): void {
  emit("user_update", pairKey(organizationId, userId))
}

export function createSignalWaiter(subscribe: (wake: () => void) => () => void) {
  let woken = false
  let wakeCurrent: (() => void) | null = null
  const unsubscribe = subscribe(() => {
    woken = true
    wakeCurrent?.()
  })
  return {
    async wait(ms: number, signal?: AbortSignal): Promise<void> {
      if (woken || signal?.aborted || ms <= 0) {
        woken = false
        return
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(finish, ms)
        function finish() {
          clearTimeout(timer)
          signal?.removeEventListener("abort", finish)
          if (wakeCurrent === finish) wakeCurrent = null
          resolve()
        }
        wakeCurrent = finish
        signal?.addEventListener("abort", finish, { once: true })
      })
      woken = false
    },
    dispose() {
      unsubscribe()
    },
  }
}
