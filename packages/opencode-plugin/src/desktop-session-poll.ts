import { createHash } from "node:crypto"
import type { SessionCheck } from "./desktop.ts"

export interface SessionPollListener {
  /** One local check with this Location's transport. Every listener on a key gets the same answer. */
  readonly check: (signal: AbortSignal) => Promise<SessionCheck>
  /** Every check's result, whoever asked for it. */
  readonly receive: (check: SessionCheck) => void
  readonly intervalMs: number
  /** Aborting releases this listener; the last one stops the poll. */
  readonly signal: AbortSignal
}

interface SessionPoll {
  readonly controller: AbortController
  readonly listeners: Map<symbol, SessionPollListener>
  inflight: Promise<SessionCheck> | null
  intervalMs: number
  timer: ReturnType<typeof setInterval> | null
}

interface SessionPollHub {
  readonly join: (endpoint: string, capability: string | undefined, listener: SessionPollListener) => () => Promise<SessionCheck>
}

// OpenCode creates one plugin instance per Location, each in its own ESM graph.
// Without sharing, N open Locations each check the local session every second,
// which is what makes those checks time out under load. Like the inventory
// hubs, only an immutable join capability is global; the capability and the
// Locations' transports stay in this closure.
declare global {
  var __openworkDesktopSessionPolls: SessionPollHub | undefined
}

const UNKNOWN: SessionCheck = { kind: "unknown" }

function createSessionPollHub(): SessionPollHub {
  const shared = new Map<string, SessionPoll>()

  const run = (entry: SessionPoll): Promise<SessionCheck> => {
    if (entry.inflight) return entry.inflight
    let owner: SessionPollListener | undefined
    for (const listener of entry.listeners.values()) if (!listener.signal.aborted) { owner = listener; break }
    if (!owner) return Promise.resolve(UNKNOWN)
    const result = owner.check(entry.controller.signal).catch((): SessionCheck => UNKNOWN).then(check => {
      entry.inflight = null
      // Fan out to every Location still listening, including ones that joined mid-check.
      for (const listener of entry.listeners.values()) {
        if (!listener.signal.aborted) { try { listener.receive(check) } catch {} }
      }
      return check
    })
    entry.inflight = result
    return result
  }

  const schedule = (entry: SessionPoll) => {
    if (entry.timer) clearInterval(entry.timer)
    entry.timer = setInterval(() => { void run(entry) }, entry.intervalMs)
    entry.timer.unref?.()
  }

  const join = (endpoint: string, capability: string | undefined, listener: SessionPollListener) => {
    if (listener.signal.aborted) return () => Promise.resolve(UNKNOWN)
    const key = createHash("sha256").update(JSON.stringify([endpoint, capability ?? null])).digest("hex")
    let entry = shared.get(key)
    if (!entry) {
      entry = { controller: new AbortController(), listeners: new Map(), inflight: null, intervalMs: listener.intervalMs, timer: null }
      shared.set(key, entry)
      schedule(entry)
    } else if (listener.intervalMs < entry.intervalMs) {
      entry.intervalMs = listener.intervalMs
      schedule(entry)
    }
    const current = entry
    const id = Symbol()
    current.listeners.set(id, listener)
    listener.signal.addEventListener("abort", () => {
      current.listeners.delete(id)
      if (current.listeners.size) return
      if (shared.get(key) === current) shared.delete(key)
      if (current.timer) clearInterval(current.timer)
      current.controller.abort()
    }, { once: true })
    // Check now, or join the check already in flight; the result reaches everyone.
    return () => listener.signal.aborted ? Promise.resolve(UNKNOWN) : run(current)
  }

  return Object.freeze({ join: Object.freeze(join) })
}

/**
 * One local session poll per endpoint and capability for the whole process,
 * fanned out to every Location. Returns a function that checks immediately
 * (or joins the check in flight).
 */
export function joinDesktopSessionPoll(endpoint: string, capability: string | undefined, listener: SessionPollListener): () => Promise<SessionCheck> {
  let hub = globalThis.__openworkDesktopSessionPolls
  if (!hub) {
    hub = createSessionPollHub()
    Object.defineProperty(globalThis, "__openworkDesktopSessionPolls", {
      value: hub,
      writable: false,
      configurable: false,
      enumerable: false,
    })
  }
  return hub.join(endpoint, capability, listener)
}
