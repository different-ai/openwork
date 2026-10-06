import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ConnectorAccountTable, ConnectorInstanceTable, ConnectorSyncEventTable, ConnectorTargetTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../../../../db.js"
import { type ConnectorInstanceRow, type ConnectorTargetRow, isRecord } from "../../store/internal.js"

type GithubWebhookTargetRow = {
  instance: ConnectorInstanceRow
  target: ConnectorTargetRow
}

async function listActiveGithubWebhookTargets(installationId: number) {
  return db
    .select({ instance: ConnectorInstanceTable, target: ConnectorTargetTable })
    .from(ConnectorTargetTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorTargetTable.connectorInstanceId, ConnectorInstanceTable.id))
    .innerJoin(ConnectorAccountTable, eq(ConnectorInstanceTable.connectorAccountId, ConnectorAccountTable.id))
    .where(and(
      eq(ConnectorTargetTable.connectorType, "github"),
      eq(ConnectorTargetTable.organizationId, ConnectorInstanceTable.organizationId),
      eq(ConnectorAccountTable.organizationId, ConnectorInstanceTable.organizationId),
      eq(ConnectorAccountTable.connectorType, "github"),
      eq(ConnectorAccountTable.remoteId, String(installationId)),
      eq(ConnectorAccountTable.status, "active"),
      eq(ConnectorInstanceTable.status, "active"),
    ))
}

function githubWebhookTargetMatchesRepository(input: {
  repositoryFullName: string
  repositoryId: number
  row: GithubWebhookTargetRow
}) {
  const targetConfig = input.row.target.targetConfigJson
  const storedRepositoryId = targetConfig.repositoryId
  return typeof storedRepositoryId === "number"
    ? storedRepositoryId === input.repositoryId
    : input.row.target.remoteId === input.repositoryFullName
}

function renamedRepositoryPreviousFullName(payload: Record<string, unknown>, repositoryFullName: string) {
  const changes = isRecord(payload.changes) ? payload.changes : null
  const repositoryChange = changes && isRecord(changes.repository) ? changes.repository : null
  const nameChange = repositoryChange && isRecord(repositoryChange.name) ? repositoryChange.name : null
  const previousName = nameChange && typeof nameChange.from === "string" ? nameChange.from.trim() : ""
  if (!previousName) return ""
  if (previousName.includes("/")) return previousName
  const owner = repositoryFullName.split("/")[0]?.trim() ?? ""
  return owner ? `${owner}/${previousName}` : previousName
}

async function handleGithubRepositoryRenamed(input: {
  deliveryId: string
  installationId: number
  payload: Record<string, unknown>
  repositoryFullName?: string
  repositoryId?: number
}) {
  const repositoryFullName = input.repositoryFullName
  const repositoryId = input.repositoryId
  if (!repositoryFullName || !repositoryId) {
    return 0
  }
  const previousFullName = renamedRepositoryPreviousFullName(input.payload, repositoryFullName)
  if (!previousFullName) {
    return 0
  }

  const rows = await listActiveGithubWebhookTargets(input.installationId)
  const matches = rows.filter((row) => githubWebhookTargetMatchesRepository({
    repositoryFullName: previousFullName,
    repositoryId,
    row,
  }))
  for (const row of matches) {
    const now = new Date()
    await db.update(ConnectorTargetTable).set({
      remoteId: repositoryFullName,
      targetConfigJson: {
        ...row.target.targetConfigJson,
        repositoryFullName,
      },
      updatedAt: now,
    }).where(eq(ConnectorTargetTable.id, row.target.id))
    await db.update(ConnectorInstanceTable).set({
      remoteId: repositoryFullName,
      updatedAt: now,
    }).where(eq(ConnectorInstanceTable.id, row.instance.id))

    await db.insert(ConnectorSyncEventTable).values({
      completedAt: now,
      connectorInstanceId: row.instance.id,
      connectorTargetId: row.target.id,
      connectorType: "github",
      eventType: "repository",
      externalEventRef: input.deliveryId,
      id: createDenTypeId("connectorSyncEvent"),
      organizationId: row.instance.organizationId,
      remoteId: repositoryFullName,
      sourceRevisionRef: null,
      startedAt: now,
      status: "completed",
      summaryJson: {
        action: "renamed",
        deliveryId: input.deliveryId,
        from: previousFullName,
        to: repositoryFullName,
        trigger: "webhook",
      },
    })

    const activeEvents = await db
      .select({ id: ConnectorSyncEventTable.id })
      .from(ConnectorSyncEventTable)
      .where(and(
        eq(ConnectorSyncEventTable.connectorTargetId, row.target.id),
        inArray(ConnectorSyncEventTable.status, ["queued", "running"]),
      ))
      .limit(1)
    if (!activeEvents[0]) {
      await db.insert(ConnectorSyncEventTable).values({
        connectorInstanceId: row.instance.id,
        connectorTargetId: row.target.id,
        connectorType: "github",
        eventType: "manual_resync",
        externalEventRef: input.deliveryId,
        id: createDenTypeId("connectorSyncEvent"),
        organizationId: row.instance.organizationId,
        remoteId: repositoryFullName,
        sourceRevisionRef: null,
        startedAt: now,
        status: "queued",
        summaryJson: { trigger: "webhook" },
      })
    }
  }
  return matches.length
}

function removedGithubRepositories(payload: Record<string, unknown>) {
  return Array.isArray(payload.repositories_removed)
    ? payload.repositories_removed.flatMap((entry) => {
        if (!isRecord(entry) || typeof entry.id !== "number" || typeof entry.full_name !== "string") return []
        const repositoryFullName = entry.full_name.trim()
        return repositoryFullName ? [{ repositoryFullName, repositoryId: entry.id }] : []
      })
    : []
}

async function handleGithubInstallationRepositoriesRemoved(input: {
  deliveryId: string
  installationId: number
  payload: Record<string, unknown>
}) {
  const removed = removedGithubRepositories(input.payload)
  if (removed.length === 0) return 0
  const rows = await listActiveGithubWebhookTargets(input.installationId)
  let matchedCount = 0
  for (const row of rows) {
    const repository = removed.find((entry) => githubWebhookTargetMatchesRepository({ ...entry, row }))
    if (!repository) continue
    matchedCount += 1
    const now = new Date()
    await db.update(ConnectorTargetTable).set({
      targetConfigJson: {
        ...row.target.targetConfigJson,
        status: "disabled",
      },
      updatedAt: now,
    }).where(eq(ConnectorTargetTable.id, row.target.id))
    await db.update(ConnectorInstanceTable).set({
      status: "disabled",
      updatedAt: now,
    }).where(eq(ConnectorInstanceTable.id, row.instance.id))
    await db.insert(ConnectorSyncEventTable).values({
      completedAt: now,
      connectorInstanceId: row.instance.id,
      connectorTargetId: row.target.id,
      connectorType: "github",
      eventType: "installation_repositories",
      externalEventRef: input.deliveryId,
      id: createDenTypeId("connectorSyncEvent"),
      organizationId: row.instance.organizationId,
      remoteId: row.target.remoteId,
      sourceRevisionRef: null,
      startedAt: now,
      status: "completed",
      summaryJson: {
        action: "removed",
        deliveryId: input.deliveryId,
        repositoryFullName: repository.repositoryFullName,
        repositoryId: repository.repositoryId,
        trigger: "webhook",
      },
    })
  }
  return matchedCount
}

export async function enqueueGithubWebhookSync(input: {
  deliveryId: string
  event: "installation" | "installation_repositories" | "push" | "repository"
  headSha?: string
  installationId?: number
  payload: Record<string, unknown>
  ref?: string
  repositoryFullName?: string
  repositoryId?: number
}) {
  if (!input.installationId) {
    return { accepted: false as const, reason: "missing installation id" }
  }

  const accounts = await db
    .select()
    .from(ConnectorAccountTable)
    .where(and(eq(ConnectorAccountTable.connectorType, "github"), eq(ConnectorAccountTable.remoteId, String(input.installationId))))

  if (input.event !== "push") {
    if (input.event === "installation") {
      const action = typeof input.payload.action === "string" ? input.payload.action : null
      if (action === "deleted") {
        for (const account of accounts) {
          await db.update(ConnectorAccountTable).set({ status: "disconnected", updatedAt: new Date() }).where(eq(ConnectorAccountTable.id, account.id))
        }
        return { accepted: true as const, queued: false as const }
      }
    }
    if (input.event === "repository" && input.payload.action === "renamed") {
      const matchedCount = await handleGithubRepositoryRenamed({
        deliveryId: input.deliveryId,
        installationId: input.installationId,
        payload: input.payload,
        repositoryFullName: input.repositoryFullName,
        repositoryId: input.repositoryId,
      })
      return matchedCount > 0
        ? { accepted: true as const, queued: true as const }
        : { accepted: false as const, reason: "event ignored" }
    }
    if (input.event === "installation_repositories" && input.payload.action === "removed") {
      const matchedCount = await handleGithubInstallationRepositoriesRemoved({
        deliveryId: input.deliveryId,
        installationId: input.installationId,
        payload: input.payload,
      })
      return matchedCount > 0
        ? { accepted: true as const, queued: false as const }
        : { accepted: false as const, reason: "event ignored" }
    }
    return { accepted: false as const, reason: "event ignored" }
  }

  if (!input.repositoryFullName || !input.ref || !input.headSha || !input.repositoryId) {
    return { accepted: false as const, reason: "missing push metadata" }
  }

  const instances = await db
    .select({ instance: ConnectorInstanceTable, target: ConnectorTargetTable })
    .from(ConnectorTargetTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorTargetTable.connectorInstanceId, ConnectorInstanceTable.id))
    .innerJoin(ConnectorAccountTable, eq(ConnectorInstanceTable.connectorAccountId, ConnectorAccountTable.id))
    .where(and(
      eq(ConnectorTargetTable.connectorType, "github"),
      eq(ConnectorTargetTable.remoteId, input.repositoryFullName),
      eq(ConnectorTargetTable.organizationId, ConnectorInstanceTable.organizationId),
      eq(ConnectorAccountTable.organizationId, ConnectorInstanceTable.organizationId),
      eq(ConnectorAccountTable.connectorType, "github"),
      eq(ConnectorAccountTable.remoteId, String(input.installationId)),
      eq(ConnectorAccountTable.status, "active"),
      eq(ConnectorInstanceTable.status, "active"),
    ))

  const queuedIds: string[] = []
  for (const row of instances) {
    const targetConfig = row.target.targetConfigJson ?? {}
    const targetRef = typeof targetConfig.ref === "string" ? targetConfig.ref : null
    if (targetRef && targetRef !== input.ref) {
      continue
    }

    const existing = await db
      .select({ id: ConnectorSyncEventTable.id })
      .from(ConnectorSyncEventTable)
      .where(and(
        eq(ConnectorSyncEventTable.connectorTargetId, row.target.id),
        eq(ConnectorSyncEventTable.eventType, "push"),
        eq(ConnectorSyncEventTable.sourceRevisionRef, input.headSha),
      ))
      .limit(1)

    if (existing[0]) continue

    const id = createDenTypeId("connectorSyncEvent")
    await db.insert(ConnectorSyncEventTable).values({
      connectorInstanceId: row.instance.id,
      connectorTargetId: row.target.id,
      connectorType: "github",
      eventType: "push",
      externalEventRef: input.deliveryId,
      id,
      organizationId: row.instance.organizationId,
      remoteId: input.repositoryFullName,
      sourceRevisionRef: input.headSha,
      startedAt: new Date(),
      status: "queued",
      summaryJson: {
        deliveryId: input.deliveryId,
        headSha: input.headSha,
        installationId: input.installationId,
        ref: input.ref,
        repositoryFullName: input.repositoryFullName,
        repositoryId: input.repositoryId,
      },
    })
    queuedIds.push(id)
  }

  return queuedIds.length > 0
    ? { accepted: true as const, queued: true as const, syncEventIds: queuedIds }
    : { accepted: false as const, reason: "event ignored" }
}
