export type ConnectDebugProxyLogEntry = {
  appliedFault: string
  latencyMs: number
  method: string
  path: string
  receivedAt: string
  scenario: string
  status: number | null
}

declare global {
  var __openworkConnectDebugProxyLog: ConnectDebugProxyLogEntry[] | undefined
}

const maximumEntries = 100
const entries = globalThis.__openworkConnectDebugProxyLog ??= []

export function recordConnectDebugProxyRequest(entry: ConnectDebugProxyLogEntry): void {
  entries.unshift(entry)
  entries.splice(maximumEntries)
}

export function listConnectDebugProxyRequests(): readonly ConnectDebugProxyLogEntry[] {
  return [...entries]
}

export function clearConnectDebugProxyRequests(): void {
  entries.splice(0, entries.length)
}
