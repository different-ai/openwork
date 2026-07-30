import { and, eq, gt, lt, lte } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable, OAuthAccessTokenTable, OAuthRefreshTokenTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { getDenSessionExpiresAt, getDenSessionRefreshCutoff } from "../session-lifetime.js"

export type McpSessionLiveness = "alive" | "missing" | "check_failed"

function normalizeMcpSessionId(sessionId: string) {
  return normalizeDenTypeId("session", sessionId)
}

type NormalizedMcpSessionId = ReturnType<typeof normalizeMcpSessionId>
type McpSessionTouch = (input: { normalizedSessionId: NormalizedMcpSessionId; now: Date; nextExpiresAt: Date }) => Promise<void>
type McpSessionSelect = (input: { normalizedSessionId: NormalizedMcpSessionId; now: Date }) => Promise<readonly { id: NormalizedMcpSessionId }[]>

function livenessLogDetails(sessionId: NormalizedMcpSessionId, error: unknown) {
  return {
    sessionId: sessionId.slice(0, 12),
    error: String(error).slice(0, 200),
  }
}

const touchMcpSession: McpSessionTouch = async ({ normalizedSessionId, now, nextExpiresAt }) => {
  // MCP clients can be the only active surface for days at a time. Apply
  // the same rolling-session policy used by desktop bearer requests so a
  // regularly used, rotating OAuth grant does not die at the original
  // seven-day browser-session boundary. The active-session predicate keeps
  // this update from ever resurrecting an expired or explicitly deleted
  // session, and the expiry guard prevents concurrent touches from
  // shortening a session another request already renewed.
  await db
    .update(AuthSessionTable)
    .set({
      expiresAt: nextExpiresAt,
      updatedAt: now,
    })
    .where(and(
      eq(AuthSessionTable.id, normalizedSessionId),
      gt(AuthSessionTable.expiresAt, now),
      lte(AuthSessionTable.expiresAt, getDenSessionRefreshCutoff(now)),
      lt(AuthSessionTable.expiresAt, nextExpiresAt),
    ))
}

const selectActiveMcpSession: McpSessionSelect = ({ normalizedSessionId, now }) => db
  .select({ id: AuthSessionTable.id })
  .from(AuthSessionTable)
  .where(and(
    eq(AuthSessionTable.id, normalizedSessionId),
    gt(AuthSessionTable.expiresAt, now),
  ))
  .limit(1)

let activeMcpSessionTouch = touchMcpSession
let activeMcpSessionSelect = selectActiveMcpSession

export function setMcpSessionLivenessDependenciesForTest(input: {
  touch?: McpSessionTouch
  select?: McpSessionSelect
}) {
  const previousTouch = activeMcpSessionTouch
  const previousSelect = activeMcpSessionSelect
  if (input.touch) activeMcpSessionTouch = input.touch
  if (input.select) activeMcpSessionSelect = input.select
  return () => {
    activeMcpSessionTouch = previousTouch
    activeMcpSessionSelect = previousSelect
  }
}

export async function getMcpSessionLiveness(sessionId: string, now = new Date()): Promise<McpSessionLiveness> {
  let normalizedSessionId: NormalizedMcpSessionId
  try {
    normalizedSessionId = normalizeMcpSessionId(sessionId)
  } catch {
    return "missing"
  }

  const nextExpiresAt = getDenSessionExpiresAt(now)

  try {
    await activeMcpSessionTouch({ normalizedSessionId, now, nextExpiresAt })
  } catch (error) {
    console.error("mcp_session_liveness_touch_failed", livenessLogDetails(normalizedSessionId, error))
  }

  try {
    const rows = await activeMcpSessionSelect({ normalizedSessionId, now })
    return rows.length > 0 ? "alive" : "missing"
  } catch (error) {
    console.error("mcp_session_liveness_check_failed", livenessLogDetails(normalizedSessionId, error))
    return "check_failed"
  }
}

export async function hasActiveMcpSession(sessionId: string, now = new Date()) {
  return (await getMcpSessionLiveness(sessionId, now)) === "alive"
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
