import type { McpSessionLiveness } from "./session-liveness.js"

export type McpRefreshGrantRow = {
  sessionId?: string | null
  clientId?: string | null
  userId?: string | null
  referenceId?: string | null
}

export class McpRefreshGrantRevokedError extends Error {
  constructor() {
    super("MCP refresh grant consent is no longer live")
    this.name = "McpRefreshGrantRevokedError"
  }
}

export async function assertLiveMcpRefreshGrant(input: {
  grant: McpRefreshGrantRow | null
  getSessionLiveness: (sessionId: string) => Promise<McpSessionLiveness>
  findConsent: (identity: { clientId: string; userId: string; referenceId: string }) => Promise<{ id: string } | null>
  deleteGrantFamily: (sessionId: string) => Promise<void>
}) {
  const sessionId = typeof input.grant?.sessionId === "string" && input.grant.sessionId.trim()
    ? input.grant.sessionId.trim()
    : null
  if (!sessionId) {
    return
  }

  const sessionLiveness = await input.getSessionLiveness(sessionId)
  if (sessionLiveness === "alive" || sessionLiveness === "check_failed") {
    return
  }

  const clientId = typeof input.grant?.clientId === "string" && input.grant.clientId.trim()
    ? input.grant.clientId.trim()
    : null
  const userId = typeof input.grant?.userId === "string" && input.grant.userId.trim()
    ? input.grant.userId.trim()
    : null
  const referenceId = typeof input.grant?.referenceId === "string" && input.grant.referenceId.trim()
    ? input.grant.referenceId.trim()
    : null
  const consent = clientId && userId && referenceId
    ? await input.findConsent({ clientId, userId, referenceId })
    : null
  if (consent) {
    return
  }

  await input.deleteGrantFamily(sessionId)
  throw new McpRefreshGrantRevokedError()
}
