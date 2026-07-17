import type { DenExternalMcpConnection } from "@/app/lib/den"

export const CHAT_MCP_RECONNECT_POLL_INTERVAL_MS = 2_000
export const CHAT_MCP_RECONNECT_TIMEOUT_MS = 90_000

export type ChatMcpReconnectScope = {
  baseUrl: string
  token: string
  organizationId: string
}

export function isChatMcpReconnectScopeCurrent(
  expected: ChatMcpReconnectScope,
  current: ChatMcpReconnectScope,
): boolean {
  return expected.baseUrl === current.baseUrl
    && expected.token === current.token
    && expected.organizationId === current.organizationId
}

export function hasFreshMcpAuthorization(
  connection: Pick<DenExternalMcpConnection, "connectedForMe" | "connectedAt"> | null | undefined,
  previousConnectedAt: string | null,
): boolean {
  return connection?.connectedForMe === true
    && typeof connection.connectedAt === "string"
    && connection.connectedAt.length > 0
    && connection.connectedAt !== previousConnectedAt
}

export async function waitForFreshMcpAuthorization(input: {
  connectionId: string
  connectionName: string
  previousConnectedAt: string | null
  listConnections: () => Promise<DenExternalMcpConnection[]>
  isScopeCurrent: () => boolean
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<DenExternalMcpConnection> {
  const timeoutMs = input.timeoutMs ?? CHAT_MCP_RECONNECT_TIMEOUT_MS
  const intervalMs = input.intervalMs ?? CHAT_MCP_RECONNECT_POLL_INTERVAL_MS
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)))
  const startedAt = now()

  while (now() - startedAt < timeoutMs) {
    if (!input.isScopeCurrent()) {
      throw new Error("The active OpenWork Cloud account changed while reconnecting. Try again in this workspace.")
    }
    try {
      const connections = await input.listConnections()
      if (!input.isScopeCurrent()) {
        throw new Error("The active OpenWork Cloud account changed while reconnecting. Try again in this workspace.")
      }
      const connection = connections.find((entry) => entry.id === input.connectionId)
      if (connection && hasFreshMcpAuthorization(connection, input.previousConnectedAt)) return connection
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The active OpenWork Cloud account changed")) throw error
      // A transient list failure should not turn a successful browser callback
      // into a false failure. Keep polling until the bounded timeout.
    }
    await sleep(intervalMs)
  }

  throw new Error(`Authorization for ${input.connectionName} did not finish. Complete it in the browser, then try reconnecting again.`)
}
