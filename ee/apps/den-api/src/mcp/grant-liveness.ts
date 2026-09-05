import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { cache } from "../cache.js"

export type McpGrantLiveness = "live" | "missing" | "check_failed"

function normalizeMcpGrantId(grantId: string) {
  return normalizeDenTypeId("oauthConsent", grantId)
}

type NormalizedMcpGrantId = ReturnType<typeof normalizeMcpGrantId>
type McpGrantSelect = (input: { normalizedGrantId: NormalizedMcpGrantId }) => Promise<readonly { id: NormalizedMcpGrantId }[]>

function livenessLogDetails(grantId: NormalizedMcpGrantId, error: unknown) {
  return {
    grantId: grantId.slice(0, 12),
    error: String(error).slice(0, 200),
  }
}

const selectActiveMcpGrant: McpGrantSelect = async ({ normalizedGrantId }) => {
  const grant = await cache.auth.grant(normalizedGrantId)
  return grant ? [{ id: grant.id }] : []
}

let activeMcpGrantSelect = selectActiveMcpGrant

export function setMcpGrantLivenessDependenciesForTest(input: {
  select?: McpGrantSelect
}) {
  const previousSelect = activeMcpGrantSelect
  if (input.select) activeMcpGrantSelect = input.select
  return () => {
    activeMcpGrantSelect = previousSelect
  }
}

export async function getMcpGrantLiveness(grantId: string): Promise<McpGrantLiveness> {
  let normalizedGrantId: NormalizedMcpGrantId
  try {
    normalizedGrantId = normalizeMcpGrantId(grantId)
  } catch {
    return "missing"
  }

  try {
    const rows = await activeMcpGrantSelect({ normalizedGrantId })
    return rows.length > 0 ? "live" : "missing"
  } catch (error) {
    console.error("mcp_grant_liveness_check_failed", livenessLogDetails(normalizedGrantId, error))
    return "check_failed"
  }
}
