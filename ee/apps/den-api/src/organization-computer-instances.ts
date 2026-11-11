import { and, desc, eq, sql, type SQL } from "@openwork-ee/den-db/drizzle"
import { AuthUserTable, CloudRuntimeInstanceTable, MemberTable, WorkerTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { OrganizationComputerInstance } from "@openwork/types/den/remote-devices"
import { db } from "./db.js"

/** Explicit allowlist: never select worker paths, endpoints, provider_ref, credentials or descriptions. */
const columns = {
  id: WorkerTable.id, name: WorkerTable.name, destination: WorkerTable.destination, status: WorkerTable.status,
  ownerMemberId: MemberTable.id, ownerName: AuthUserTable.name, ownerEmail: AuthUserTable.email,
  imageVersion: WorkerTable.image_version, provider: CloudRuntimeInstanceTable.provider_id, region: CloudRuntimeInstanceTable.region,
  lastHeartbeatAt: WorkerTable.last_heartbeat_at, lastActiveAt: WorkerTable.last_active_at,
  createdAt: WorkerTable.created_at, updatedAt: WorkerTable.updated_at,
}
function query(where: SQL) {
  return db.select(columns).from(WorkerTable)
    .leftJoin(CloudRuntimeInstanceTable, eq(CloudRuntimeInstanceTable.worker_id, WorkerTable.id))
    .leftJoin(MemberTable, and(eq(MemberTable.organizationId, WorkerTable.org_id), eq(MemberTable.userId, WorkerTable.created_by_user_id)))
    .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
    .where(where)
}
type Row = Awaited<ReturnType<typeof query>>[number]
function view(row: Row): OrganizationComputerInstance {
  return {
    id: row.id, name: row.name, destination: row.destination, status: row.status,
    owner: row.ownerName !== null || row.ownerEmail !== null ? { memberId: row.ownerMemberId, name: row.ownerName, email: row.ownerEmail } : null,
    version: row.imageVersion, provider: row.provider, region: row.region,
    lastSeenAt: row.lastHeartbeatAt?.toISOString() ?? null, lastActiveAt: row.lastActiveAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}
export type OrganizationInstanceFilters = {
  search?: string
  instancePage?: number
  instanceDestination?: "local" | "cloud"
  instanceStatus?: "provisioning" | "healthy" | "failed" | "stopped"
  instanceProvider?: string
}
export async function listOrganizationComputerInstances(organizationId: DenTypeId<"organization">, filters: OrganizationInstanceFilters = {}) {
  const page = Math.max(1, filters.instancePage ?? 1)
  const pageSize = 50
  const pattern = filters.search?.trim() ? `%${filters.search.trim().toLowerCase().replace(/[|%_]/g, (char) => `|${char}`)}%` : null
  const where = and(
    eq(WorkerTable.org_id, organizationId),
    filters.instanceDestination ? eq(WorkerTable.destination, filters.instanceDestination) : undefined,
    filters.instanceStatus ? eq(WorkerTable.status, filters.instanceStatus) : undefined,
    filters.instanceProvider ? eq(CloudRuntimeInstanceTable.provider_id, filters.instanceProvider) : undefined,
    pattern ? sql`(lower(${WorkerTable.name}) like ${pattern} escape '|' or lower(${WorkerTable.id}) like ${pattern} escape '|')` : undefined,
  )!
  const [rows, counts] = await Promise.all([
    query(where).orderBy(desc(WorkerTable.created_at), desc(WorkerTable.id)).limit(pageSize).offset((page - 1) * pageSize),
    db.select({ total: sql<number>`count(*)` }).from(WorkerTable)
      .leftJoin(CloudRuntimeInstanceTable, eq(CloudRuntimeInstanceTable.worker_id, WorkerTable.id)).where(where),
  ])
  return { instances: rows.map(view), instancesTotal: Number(counts[0]?.total ?? 0), instancePage: page, instancePageSize: pageSize }
}
export async function readOrganizationComputerInstance(organizationId: DenTypeId<"organization">, id: DenTypeId<"worker">) {
  const [row] = await query(and(eq(WorkerTable.org_id, organizationId), eq(WorkerTable.id, id))!).limit(1)
  return row ? { instance: view(row) } : null
}
