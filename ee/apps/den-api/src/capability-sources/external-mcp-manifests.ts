import { createHash } from "node:crypto"
import { and, eq, inArray, isNull, lte, or, sql } from "@openwork-ee/den-db/drizzle"
import {
  ExternalMcpToolManifestTable,
  type CachedExternalMcpTool,
} from "@openwork-ee/den-db/schema"
import { createDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import type { ExternalMcpConnectionRow } from "./external-mcp-connections.js"
import { listExternalMcpToolsWithOptions } from "./external-mcp-client.js"
import type { ExternalMcpMemberContext } from "./external-mcp-client.js"

export type ManifestPrincipal = "shared" | DenTypeId<"member">
export type ExternalMcpToolManifestRow = typeof ExternalMcpToolManifestTable.$inferSelect

export type ManifestPair = {
  connection: ExternalMcpConnectionRow
  principal: ManifestPrincipal
}

export type ManifestClassification =
  | { state: "fresh"; row: ExternalMcpToolManifestRow }
  | { state: "stale"; row: ExternalMcpToolManifestRow }
  | { state: "miss"; row: ExternalMcpToolManifestRow | null }

export type ManifestRevalidationResult = "failed" | "lease_held" | "refreshed"

type SaveListingInput = {
  connection: ExternalMcpConnectionRow
  principal: ManifestPrincipal
  tools: readonly CachedExternalMcpTool[]
  durationMs: number
}

type SaveFailureInput = {
  connection: ExternalMcpConnectionRow
  principal: ManifestPrincipal
  error: unknown
  durationMs: number
}

type RevalidationInput = {
  connection: ExternalMcpConnectionRow
  principal: ManifestPrincipal
  redirectUri: string
  member?: ExternalMcpMemberContext
}

const inFlightRevalidations = new Map<string, Promise<void>>()
const MAX_REVALIDATION_BACKLOG = 20

type QueuedManifestRevalidation = {
  reject: (error: unknown) => void
  resolve: () => void
  run: () => Promise<void>
}

export function createBoundedManifestRevalidationQueue(input: {
  concurrency: number
  maxBacklog: number
}) {
  const concurrency = Math.max(1, Math.floor(input.concurrency))
  const maxBacklog = Math.max(0, Math.floor(input.maxBacklog))
  const queue: QueuedManifestRevalidation[] = []
  let active = 0

  const drain = () => {
    while (active < concurrency) {
      const item = queue.shift()
      if (!item) return
      active += 1
      void item.run()
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1
          drain()
        })
    }
  }

  return {
    enqueue(run: () => Promise<void>): Promise<void> | null {
      if (queue.length >= maxBacklog && active >= concurrency) return null
      const task = new Promise<void>((resolve, reject) => {
        queue.push({ reject, resolve, run })
      })
      drain()
      return task
    },
    stats() {
      return { active, queued: queue.length }
    },
  }
}

const manifestRevalidationQueue = createBoundedManifestRevalidationQueue({
  concurrency: env.mcpManifestRevalidateConcurrency,
  maxBacklog: MAX_REVALIDATION_BACKLOG,
})

export function manifestPrincipalFor(
  connection: ExternalMcpConnectionRow,
  member?: ExternalMcpMemberContext,
): ManifestPrincipal {
  if (connection.credentialMode === "per_member") {
    if (!member) {
      throw new Error(`Connection "${connection.id}" uses per-member manifests but no member context was provided.`)
    }
    return member.orgMembershipId
  }
  return "shared"
}

export function computeManifestConfigHash(connection: ExternalMcpConnectionRow): string {
  return createHash("sha256")
    .update(`${connection.url}\n${connection.authType}\n${connection.credentialMode}`)
    .digest("hex")
}

function rowKey(connectionId: string, principal: string) {
  return `${connectionId}\0${principal}`
}

function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 1024 ? `${message.slice(0, 1021)}...` : message
}

function normalizeTools(tools: readonly CachedExternalMcpTool[]): {
  tools: CachedExternalMcpTool[]
  toolCount: number
  toolsHash: string
  toolsTruncated: boolean
} {
  const normalized = tools.map((tool) => ({
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.description ? { description: tool.description } : {}),
  }))
  let candidate = normalized
  let toolsTruncated = false

  if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > env.mcpManifestMaxBytes) {
    candidate = candidate.map((tool) => ({
      ...tool,
      ...(tool.description ? { description: tool.description.slice(0, 500) } : {}),
    }))
    toolsTruncated = true
  }

  while (candidate.length > 0 && Buffer.byteLength(JSON.stringify(candidate), "utf8") > env.mcpManifestMaxBytes) {
    candidate = candidate.slice(0, -1)
    toolsTruncated = true
  }

  return {
    tools: candidate,
    toolCount: candidate.length,
    toolsHash: createHash("sha256").update(JSON.stringify(candidate)).digest("hex"),
    toolsTruncated,
  }
}

export function classifyManifest(
  row: ExternalMcpToolManifestRow | null,
  connection: ExternalMcpConnectionRow,
  now = new Date(),
): ManifestClassification {
  if (!row) return { state: "miss", row: null }
  if (row.configHash !== computeManifestConfigHash(connection)) return { state: "miss", row }
  if (row.tools.length === 0 || !row.listedAt) return { state: "miss", row }

  const ageMs = now.getTime() - row.listedAt.getTime()
  if (ageMs >= env.mcpManifestMaxAgeMs) return { state: "miss", row }
  if (row.staleAt && row.staleAt <= now) return { state: "stale", row }
  if (row.status === "ok" && ageMs < env.mcpManifestFreshTtlMs) return { state: "fresh", row }
  return { state: "stale", row }
}

export async function getManifests(input: {
  pairs: readonly ManifestPair[]
}): Promise<Map<string, ExternalMcpToolManifestRow>> {
  if (input.pairs.length === 0) return new Map()
  const connectionIds = [...new Set(input.pairs.map((pair) => pair.connection.id))]
  const principals = [...new Set(input.pairs.map((pair) => pair.principal))]
  const rows = await db
    .select()
    .from(ExternalMcpToolManifestTable)
    .where(and(
      inArray(ExternalMcpToolManifestTable.externalMcpConnectionId, connectionIds),
      inArray(ExternalMcpToolManifestTable.principal, principals),
    ))
  return new Map(rows.map((row) => [rowKey(row.externalMcpConnectionId, row.principal), row]))
}

export function manifestMapKey(connectionId: string, principal: ManifestPrincipal): string {
  return rowKey(connectionId, principal)
}

export async function saveManifestListing(input: SaveListingInput): Promise<ExternalMcpToolManifestRow> {
  const prepared = normalizeTools(input.tools)
  const values = {
    id: createDenTypeId("externalMcpToolManifest"),
    organizationId: input.connection.organizationId,
    externalMcpConnectionId: input.connection.id,
    principal: input.principal,
    configHash: computeManifestConfigHash(input.connection),
    status: "ok" as const,
    tools: prepared.tools,
    toolCount: prepared.toolCount,
    toolsHash: prepared.toolsHash,
    toolsTruncated: prepared.toolsTruncated,
    lastError: null,
    durationMs: input.durationMs,
    listedAt: new Date(),
    staleAt: null,
    refreshStartedAt: null,
  }
  await db
    .insert(ExternalMcpToolManifestTable)
    .values(values)
    .onDuplicateKeyUpdate({
      set: {
        configHash: values.configHash,
        status: values.status,
        tools: values.tools,
        toolCount: values.toolCount,
        toolsHash: values.toolsHash,
        toolsTruncated: values.toolsTruncated,
        lastError: values.lastError,
        durationMs: values.durationMs,
        listedAt: values.listedAt,
        staleAt: values.staleAt,
        refreshStartedAt: values.refreshStartedAt,
      },
    })

  const rows = await db
    .select()
    .from(ExternalMcpToolManifestTable)
    .where(and(
      eq(ExternalMcpToolManifestTable.externalMcpConnectionId, input.connection.id),
      eq(ExternalMcpToolManifestTable.principal, input.principal),
    ))
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error("Failed to save external MCP tool manifest.")
  return row
}

export async function saveManifestFailure(input: SaveFailureInput): Promise<void> {
  const existingRows = await db
    .select()
    .from(ExternalMcpToolManifestTable)
    .where(and(
      eq(ExternalMcpToolManifestTable.externalMcpConnectionId, input.connection.id),
      eq(ExternalMcpToolManifestTable.principal, input.principal),
    ))
    .limit(1)
  const existing = existingRows[0]
  const currentHash = computeManifestConfigHash(input.connection)
  const keepExistingTools = Boolean(existing && existing.configHash === currentHash)
  const values = {
    id: existing?.id ?? createDenTypeId("externalMcpToolManifest"),
    organizationId: input.connection.organizationId,
    externalMcpConnectionId: input.connection.id,
    principal: input.principal,
    configHash: existing?.configHash ?? currentHash,
    status: "error" as const,
    tools: keepExistingTools ? existing?.tools ?? [] : [],
    toolCount: keepExistingTools ? existing?.toolCount ?? 0 : 0,
    toolsHash: keepExistingTools ? existing?.toolsHash ?? null : null,
    toolsTruncated: keepExistingTools ? existing?.toolsTruncated ?? false : false,
    lastError: shortErrorMessage(input.error),
    durationMs: input.durationMs,
    listedAt: keepExistingTools ? existing?.listedAt ?? null : null,
    staleAt: keepExistingTools ? existing?.staleAt ?? null : null,
    refreshStartedAt: null,
  }

  await db
    .insert(ExternalMcpToolManifestTable)
    .values(values)
    .onDuplicateKeyUpdate({
      set: {
        configHash: values.configHash,
        status: values.status,
        tools: values.tools,
        toolCount: values.toolCount,
        toolsHash: values.toolsHash,
        toolsTruncated: values.toolsTruncated,
        lastError: values.lastError,
        durationMs: values.durationMs,
        listedAt: values.listedAt,
        staleAt: values.staleAt,
        refreshStartedAt: values.refreshStartedAt,
      },
    })
}

export async function markManifestsStale(input: {
  connectionId: DenTypeId<"externalMcpConnection">
  principal?: ManifestPrincipal
}): Promise<void> {
  const where = input.principal
    ? and(
        eq(ExternalMcpToolManifestTable.externalMcpConnectionId, input.connectionId),
        eq(ExternalMcpToolManifestTable.principal, input.principal),
      )
    : eq(ExternalMcpToolManifestTable.externalMcpConnectionId, input.connectionId)
  await db
    .update(ExternalMcpToolManifestTable)
    .set({ staleAt: new Date() })
    .where(where)
}

export async function deleteManifests(input: {
  connectionId: DenTypeId<"externalMcpConnection">
  principal?: ManifestPrincipal
}): Promise<void> {
  const where = input.principal
    ? and(
        eq(ExternalMcpToolManifestTable.externalMcpConnectionId, input.connectionId),
        eq(ExternalMcpToolManifestTable.principal, input.principal),
      )
    : eq(ExternalMcpToolManifestTable.externalMcpConnectionId, input.connectionId)
  await db.delete(ExternalMcpToolManifestTable).where(where)
}

export async function claimManifestRefresh(input: {
  rowId: DenTypeId<"externalMcpToolManifest">
  leaseMs?: number
}): Promise<boolean> {
  const leaseMs = input.leaseMs ?? env.mcpManifestRefreshLeaseMs
  const leaseMicros = leaseMs * 1000
  const result = await db
    .update(ExternalMcpToolManifestTable)
    .set({ refreshStartedAt: sql`NOW(3)` })
    .where(and(
      eq(ExternalMcpToolManifestTable.id, input.rowId),
      or(
        isNull(ExternalMcpToolManifestTable.refreshStartedAt),
        lte(ExternalMcpToolManifestTable.refreshStartedAt, sql`DATE_SUB(NOW(3), INTERVAL ${leaseMicros} MICROSECOND)`),
      ),
    ))
  return rowsAffected(result) === 1
}

export async function createRefreshLeaseForPair(input: {
  connection: ExternalMcpConnectionRow
  principal: ManifestPrincipal
}): Promise<ExternalMcpToolManifestRow> {
  const values = {
    id: createDenTypeId("externalMcpToolManifest"),
    organizationId: input.connection.organizationId,
    externalMcpConnectionId: input.connection.id,
    principal: input.principal,
    configHash: computeManifestConfigHash(input.connection),
    status: "error" as const,
    tools: [],
    toolCount: 0,
    toolsHash: null,
    toolsTruncated: false,
    lastError: null,
    durationMs: null,
    listedAt: null,
    staleAt: new Date(),
    refreshStartedAt: null,
  }
  await db
    .insert(ExternalMcpToolManifestTable)
    .values(values)
    .onDuplicateKeyUpdate({
      set: {
        staleAt: values.staleAt,
      },
    })
  const rows = await db
    .select()
    .from(ExternalMcpToolManifestTable)
    .where(and(
      eq(ExternalMcpToolManifestTable.externalMcpConnectionId, input.connection.id),
      eq(ExternalMcpToolManifestTable.principal, input.principal),
    ))
    .limit(1)
  const row = rows[0]
  if (!row) throw new Error("Failed to create external MCP manifest refresh lease.")
  return row
}

export function scheduleManifestRevalidation(input: RevalidationInput): void {
  const key = rowKey(input.connection.id, input.principal)
  if (inFlightRevalidations.has(key)) return
  const task = manifestRevalidationQueue.enqueue(async () => {
    const result = await revalidateManifest(input)
    if (result === "failed") {
      console.warn(`[mcp-manifest][revalidate_failed] connectionId=${input.connection.id} principal=${input.principal}`)
    }
  })
  if (!task) {
    console.warn(`[mcp-manifest][revalidate_dropped] connectionId=${input.connection.id} principal=${input.principal} reason=queue_full`)
    return
  }
  task.catch((error) => {
    console.warn(`[mcp-manifest][revalidate_failed] connectionId=${input.connection.id} principal=${input.principal} reason=${shortErrorMessage(error)}`)
  }).finally(() => {
    inFlightRevalidations.delete(key)
  })
  inFlightRevalidations.set(key, task)
}

export async function revalidateManifestWithClaim(input: RevalidationInput & {
  claimRefresh: (rowId: DenTypeId<"externalMcpToolManifest">) => Promise<boolean>
  row: ExternalMcpToolManifestRow
}): Promise<ManifestRevalidationResult> {
  const claimed = await input.claimRefresh(input.row.id)
  if (!claimed) return "lease_held"
  const startedAt = Date.now()
  try {
    const tools = await listExternalMcpToolsWithOptions(input.connection, input.redirectUri, input.member, {
      timeoutMs: env.mcpListToolsTimeoutMs,
    })
    await saveManifestListing({
      connection: input.connection,
      principal: input.principal,
      tools,
      durationMs: Date.now() - startedAt,
    })
    return "refreshed"
  } catch (error) {
    await saveManifestFailure({
      connection: input.connection,
      principal: input.principal,
      error,
      durationMs: Date.now() - startedAt,
    })
    return "failed"
  }
}

export async function revalidateManifest(input: RevalidationInput): Promise<ManifestRevalidationResult> {
  const row = await createRefreshLeaseForPair({ connection: input.connection, principal: input.principal })
  return revalidateManifestWithClaim({
    ...input,
    row,
    claimRefresh: (rowId) => claimManifestRefresh({ rowId }),
  })
}

function rowsAffected(result: unknown): number {
  if (Array.isArray(result)) {
    const first = result[0]
    if (typeof first === "object" && first !== null && "affectedRows" in first) {
      const affectedRows = first.affectedRows
      return typeof affectedRows === "number" ? affectedRows : 0
    }
  }
  if (typeof result === "object" && result !== null && "rowsAffected" in result) {
    const rowsAffectedValue = result.rowsAffected
    return typeof rowsAffectedValue === "number" ? rowsAffectedValue : 0
  }
  return 0
}
