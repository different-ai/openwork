import { createRequire } from "node:module"
import type { Fetch } from "./den.ts"

interface CredentialBroker {
  initialize(): Promise<void>
  fetchSession(fetcher: Fetch, endpoint: string, signal?: AbortSignal): Promise<Response | null>
  fetchInventory(fetcher: Fetch, endpoint: string, path: string, identity: string, signal?: AbortSignal): Promise<Response | null>
}
function isBroker(value: unknown): value is CredentialBroker {
  return typeof value === "object" && value !== null
    && "initialize" in value && typeof value.initialize === "function"
    && "fetchSession" in value && typeof value.fetchSession === "function"
    && "fetchInventory" in value && typeof value.fetchInventory === "function"
}

const filename = process.env.OPENWORK_PROVIDER_SESSION_BROKER
const loaded: unknown = filename ? createRequire(import.meta.url)(filename) : null
if (loaded !== null && !isBroker(loaded)) throw new Error("Invalid desktop credential broker")
const broker = isBroker(loaded) ? loaded : null

/** Finish consuming/closing the inherited channel even when the rollout is off. */
export async function initializeDesktopCredentialChannel(): Promise<void> {
  await broker?.initialize()
}

/** Shared by every Location/reload; deliberately never exports the capability. */
export async function fetchDesktopSession(fetcher: Fetch, endpoint: string, signal?: AbortSignal): Promise<Response | null> {
  return broker ? broker.fetchSession(fetcher, endpoint, signal) : null
}

export async function fetchDesktopInventory(fetcher: Fetch, endpoint: string, path: string, identity: string, signal?: AbortSignal): Promise<Response | null> {
  return broker ? broker.fetchInventory(fetcher, endpoint, path, identity, signal) : null
}
