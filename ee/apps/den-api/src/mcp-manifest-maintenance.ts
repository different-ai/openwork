import { and, eq, isNotNull, isNull, lt, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  ConnectedAccountTable,
  ExternalMcpConnectionTable,
  ExternalMcpToolManifestTable,
} from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, isDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "./db.js"
import { env } from "./env.js"
import { listTeamsForMember } from "./orgs.js"
import {
  deleteManifests,
  revalidateManifest,
  type ManifestPrincipal,
} from "./capability-sources/external-mcp-manifests.js"
import {
  memberCanUseExternalMcpConnection,
  type ExternalMcpConnectionRow,
} from "./capability-sources/external-mcp-connections.js"

let manifestMaintenanceRunning = false
let warnedMissingPublicUrl = false

function redirectUriForRefresh(connectionId: string) {
  if (!env.apiPublicUrl) return null
  return `${env.apiPublicUrl.replace(/\/+$/, "")}/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/callback`
}

function isSharedRefreshable(connection: ExternalMcpConnectionRow) {
  if (connection.credentialMode !== "shared") return false
  if (connection.authType === "oauth") return Boolean(connection.accessToken)
  if (connection.authType === "apikey") return Boolean(connection.apiKey)
  return true
}

async function refreshManifestRow(row: typeof ExternalMcpToolManifestTable.$inferSelect) {
  const connectionRows = await db
    .select()
    .from(ExternalMcpConnectionTable)
    .where(eq(ExternalMcpConnectionTable.id, row.externalMcpConnectionId))
    .limit(1)
  const connection = connectionRows[0]
  if (!connection) {
    await deleteManifests({ connectionId: row.externalMcpConnectionId, principal: row.principal as ManifestPrincipal })
    return "deleted" as const
  }

  const redirectUri = redirectUriForRefresh(connection.id)
  if (!redirectUri) return "skipped" as const

  if (row.principal === "shared") {
    if (!isSharedRefreshable(connection)) {
      await deleteManifests({ connectionId: connection.id, principal: "shared" })
      return "deleted" as const
    }
    return revalidateManifest({ connection, principal: "shared", redirectUri })
  }

  if (!isDenTypeId("member", row.principal)) {
    await deleteManifests({ connectionId: connection.id, principal: row.principal as ManifestPrincipal })
    return "deleted" as const
  }
  const orgMembershipId = normalizeDenTypeId("member", row.principal)
  const accountRows = await db
    .select({ id: ConnectedAccountTable.id, accessToken: ConnectedAccountTable.accessToken })
    .from(ConnectedAccountTable)
    .where(and(
      eq(ConnectedAccountTable.organizationId, connection.organizationId),
      eq(ConnectedAccountTable.orgMembershipId, orgMembershipId),
      eq(ConnectedAccountTable.providerId, connection.id),
    ))
    .limit(1)
  const account = accountRows[0]
  if (!account?.accessToken) {
    await deleteManifests({ connectionId: connection.id, principal: orgMembershipId })
    return "deleted" as const
  }
  const teams = await listTeamsForMember({ organizationId: connection.organizationId, memberId: orgMembershipId })
  const canUse = await memberCanUseExternalMcpConnection({
    connectionId: connection.id,
    orgMembershipId,
    teamIds: teams.map((team) => team.id),
  })
  if (!canUse) {
    await deleteManifests({ connectionId: connection.id, principal: orgMembershipId })
    return "deleted" as const
  }
  return revalidateManifest({
    connection,
    principal: orgMembershipId,
    redirectUri,
    member: { orgMembershipId },
  })
}

async function seedSharedConnectionRows(limit: number) {
  if (limit <= 0) return 0
  const rows = await db
    .select({ connection: ExternalMcpConnectionTable })
    .from(ExternalMcpConnectionTable)
    .leftJoin(
      ExternalMcpToolManifestTable,
      and(
        eq(ExternalMcpToolManifestTable.externalMcpConnectionId, ExternalMcpConnectionTable.id),
        eq(ExternalMcpToolManifestTable.principal, "shared"),
      ),
    )
    .where(and(
      eq(ExternalMcpConnectionTable.credentialMode, "shared"),
      isNull(ExternalMcpToolManifestTable.id),
      or(
        eq(ExternalMcpConnectionTable.authType, "none"),
        and(eq(ExternalMcpConnectionTable.authType, "oauth"), isNotNull(ExternalMcpConnectionTable.accessToken)),
        and(eq(ExternalMcpConnectionTable.authType, "apikey"), isNotNull(ExternalMcpConnectionTable.apiKey)),
      ),
    ))
    .orderBy(ExternalMcpConnectionTable.createdAt)
    .limit(limit)
  let seeded = 0
  for (const { connection } of rows) {
    if (!isSharedRefreshable(connection)) continue
    const redirectUri = redirectUriForRefresh(connection.id)
    if (!redirectUri) continue
    const result = await revalidateManifest({ connection, principal: "shared", redirectUri })
    if (result === "refreshed") seeded += 1
  }
  return seeded
}

export async function runMcpManifestMaintenanceOnce() {
  if (!env.apiPublicUrl) {
    if (!warnedMissingPublicUrl) {
      console.warn("[mcp-manifest][refresh_disabled] reason=missing_api_public_url")
      warnedMissingPublicUrl = true
    }
    return { scanned: 0, refreshed: 0, failures: 0, deleted: 0, seeded: 0 }
  }

  const staleCutoff = new Date(Date.now() - Math.floor(env.mcpManifestFreshTtlMs * 0.8))
  const errorCutoff = new Date(Date.now() - env.mcpManifestFreshTtlMs)
  const rows = await db
    .select()
    .from(ExternalMcpToolManifestTable)
    .where(or(
      and(lte(ExternalMcpToolManifestTable.staleAt, new Date())),
      lt(ExternalMcpToolManifestTable.listedAt, staleCutoff),
      and(
        eq(ExternalMcpToolManifestTable.status, "error"),
        lt(ExternalMcpToolManifestTable.updatedAt, errorCutoff),
      ),
      isNull(ExternalMcpToolManifestTable.listedAt),
    ))
    .orderBy(sql`${ExternalMcpToolManifestTable.listedAt} ASC`)
    .limit(env.mcpManifestRefreshBatchSize)

  let refreshed = 0
  let failures = 0
  let deleted = 0
  for (const row of rows) {
    try {
      const result = await refreshManifestRow(row)
      if (result === "refreshed") refreshed += 1
      if (result === "failed") failures += 1
      if (result === "deleted") deleted += 1
    } catch (error) {
      failures += 1
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[mcp-manifest][refresh] connectionId=${row.externalMcpConnectionId} principal=${row.principal} status=error reason=${message}`)
    }
  }
  const seeded = await seedSharedConnectionRows(Math.max(0, env.mcpManifestRefreshBatchSize - rows.length))
  console.info(`[mcp-manifest][refresh_summary] scanned=${rows.length} refreshed=${refreshed} failures=${failures} deleted=${deleted} seeded=${seeded}`)
  return { scanned: rows.length, refreshed, failures, deleted, seeded }
}

export function startMcpManifestMaintenanceLoop(intervalMs = env.mcpManifestRefreshIntervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => undefined
  }

  const run = () => {
    if (manifestMaintenanceRunning) return
    manifestMaintenanceRunning = true
    void runMcpManifestMaintenanceOnce()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[mcp-manifest][maintenance_failed] reason=${message}`)
      })
      .finally(() => {
        manifestMaintenanceRunning = false
      })
  }

  const timer = setInterval(run, intervalMs)
  timer.unref()
  run()
  return () => clearInterval(timer)
}
