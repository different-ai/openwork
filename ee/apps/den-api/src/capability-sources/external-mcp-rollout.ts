/**
 * Staged-rollout gate for member-facing org MCP connections.
 *
 * When a deployment enables gating (DEN_MCP_CONNECTIONS_GATING_ENABLED=true,
 * see env.ts), members of an organization only discover connections once the
 * org opted in via metadata `mcpConnectionsEnabled: true`. Non-opted-in orgs
 * get an empty list — byte-identical to an org with no published connections,
 * on every desktop version in the field. Admin management (scope=manageable,
 * create, access grants) stays available so orgs can stage connections before
 * the flag flips.
 *
 * Gating is off by default so local dev, evals, and self-hosted deployments
 * keep the feature working out of the box.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function memberFacingMcpConnectionsEnabled(
  metadata: Record<string, unknown> | string | null | undefined,
  options: { gatingEnabled: boolean },
): boolean {
  if (!options.gatingEnabled) {
    return true
  }
  if (!metadata) {
    return false
  }
  let parsed: unknown = metadata
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata)
    } catch {
      return false
    }
  }
  return isRecord(parsed) && parsed.mcpConnectionsEnabled === true
}
