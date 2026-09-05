import { eq } from "@openwork-ee/den-db/drizzle"
import { OAuthAccessTokenTable, OAuthRefreshTokenTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { cache } from "../cache.js"
import { db } from "../db.js"

export type McpSessionLiveness = "alive" | "missing" | "check_failed"

function normalizeMcpSessionId(sessionId: string) {
  return normalizeDenTypeId("session", sessionId)
}

type NormalizedMcpSessionId = ReturnType<typeof normalizeMcpSessionId>
type McpSessionSelect = (input: { normalizedSessionId: NormalizedMcpSessionId }) => Promise<readonly { id: NormalizedMcpSessionId }[]>

function livenessLogDetails(sessionId: NormalizedMcpSessionId, error: unknown) {
  return {
    sessionId: sessionId.slice(0, 12),
    error: String(error).slice(0, 200),
  }
}

const selectActiveMcpSession: McpSessionSelect = async ({ normalizedSessionId }) => {
  const session = await cache.auth.activeSessionId(normalizedSessionId)
  return session ? [{ id: session.id }] : []
}

let activeMcpSessionSelect = selectActiveMcpSession

export function setMcpSessionLivenessDependenciesForTest(input: {
  select?: McpSessionSelect
}) {
  const previousSelect = activeMcpSessionSelect
  if (input.select) activeMcpSessionSelect = input.select
  return () => {
    activeMcpSessionSelect = previousSelect
  }
}

export async function getMcpSessionLiveness(sessionId: string): Promise<McpSessionLiveness> {
  let normalizedSessionId: NormalizedMcpSessionId
  try {
    normalizedSessionId = normalizeMcpSessionId(sessionId)
  } catch {
    return "missing"
  }

  try {
    const rows = await activeMcpSessionSelect({ normalizedSessionId })
    return rows.length > 0 ? "alive" : "missing"
  } catch (error) {
    console.error("mcp_session_liveness_check_failed", livenessLogDetails(normalizedSessionId, error))
    return "check_failed"
  }
}

export async function hasActiveMcpSession(sessionId: string) {
  return (await getMcpSessionLiveness(sessionId)) === "alive"
}

export async function deleteMcpOAuthGrantFamilyForSession(sessionId: string) {
  const normalizedSessionId = normalizeDenTypeId("session", sessionId)

  await db
    .delete(OAuthAccessTokenTable)
    .where(eq(OAuthAccessTokenTable.sessionId, normalizedSessionId))

  await db
    .delete(OAuthRefreshTokenTable)
    .where(eq(OAuthRefreshTokenTable.sessionId, normalizedSessionId))
}
