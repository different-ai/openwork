import { inventorySessionKey } from "./inventory-events.ts"
import { fetchGatewayInventory, type GatewayInventory } from "./providers.ts"
import type { DenSession, Fetch } from "./den.ts"

type CredentialScope = "den" | "desktop"

interface SharedFetch {
  readonly startedAfter: number
  readonly controller: AbortController
  readonly result: Promise<GatewayInventory>
  joiners: number
  settled: boolean
}

interface InventoryFetchHub {
  readonly ticket: () => number
  readonly fetch: (request: SharedInventoryRequest) => Promise<GatewayInventory>
}

export interface SharedInventoryRequest {
  readonly fetch: Fetch
  readonly session: DenSession
  readonly scope: CredentialScope
  readonly ticket: number
  readonly signal?: AbortSignal
}

declare global {
  var __openworkGatewayInventoryFetches: InventoryFetchHub | undefined
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError")
}

function createInventoryFetchHub(): InventoryFetchHub {
  const shared = new Map<string, SharedFetch>()
  let sequence = 0
  const ticket = () => ++sequence

  const start = (key: string, request: SharedInventoryRequest): SharedFetch => {
    const controller = new AbortController()
    const entry: SharedFetch = {
      startedAfter: ++sequence,
      controller,
      joiners: 0,
      settled: false,
      result: fetchGatewayInventory(request.fetch, request.session, controller.signal, request.scope),
    }
    const settle = () => {
      entry.settled = true
      if (shared.get(key) === entry) shared.delete(key)
    }
    entry.result.then(settle, settle)
    shared.set(key, entry)
    return entry
  }

  const fetch = async (request: SharedInventoryRequest): Promise<GatewayInventory> => {
    if (request.signal?.aborted) throw abortError(request.signal)
    const key = `${inventorySessionKey(request.session)}:${request.scope}`
    const entry = shared.get(key)
    const current = entry && !entry.settled && entry.startedAfter > request.ticket ? entry : start(key, request)
    current.joiners += 1
    const leave = () => {
      current.joiners -= 1
      if (current.joiners === 0 && !current.settled) current.controller.abort()
    }
    const signal = request.signal
    if (!signal) {
      try { return await current.result } finally { leave() }
    }
    let onAbort: (() => void) | undefined
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError(signal))
      signal.addEventListener("abort", onAbort, { once: true })
    })
    try {
      return await Promise.race([current.result, aborted])
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort)
      leave()
    }
  }

  return Object.freeze({ ticket: Object.freeze(ticket), fetch: Object.freeze(fetch) })
}

function hub(): InventoryFetchHub {
  let current = globalThis.__openworkGatewayInventoryFetches
  if (!current) {
    current = createInventoryFetchHub()
    Object.defineProperty(globalThis, "__openworkGatewayInventoryFetches", {
      value: current,
      writable: false,
      configurable: false,
      enumerable: false,
    })
  }
  return current
}

/** Taken when a Location decides it needs fresh inventory, before anything it awaits. */
export function inventoryRequestTicket(): number {
  return hub().ticket()
}

/**
 * The gateway inventory for this session, fetched once for every Location that
 * asks while one fetch is in flight. A Location never receives a fetch that
 * started before it asked, and aborting one Location's request leaves the
 * others running.
 */
export function fetchSharedGatewayInventory(request: SharedInventoryRequest): Promise<GatewayInventory> {
  return hub().fetch(request)
}
