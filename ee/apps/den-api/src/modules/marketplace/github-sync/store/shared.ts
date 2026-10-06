import { and, eq } from "@openwork-ee/den-db/drizzle"
import {
  ConnectorAccountTable,
  ConnectorInstanceTable,
  ConnectorMappingTable,
  ConnectorSyncEventTable,
  ConnectorTargetTable,
} from "@openwork-ee/den-db/schema"
import { type PluginArchActorContext, requirePluginArchResourceRole } from "../../../../routes/org/plugin-system/access.js"
import { getGithubConnectorAppConfig, GithubConnectorConfigError, GithubConnectorRequestError } from "../github-app.js"
import { db } from "../../../../db.js"
import { env } from "../../../../env.js"
import { PluginArchRouteFailure } from "../../store/route-failure.js"
import {
  type ConnectorAccountId,
  type ConnectorAccountRow,
  type ConnectorInstanceId,
  type ConnectorInstanceRow,
  type ConnectorMappingId,
  type ConnectorMappingRow,
  type ConnectorSyncEventId,
  type ConnectorSyncEventRow,
  type ConnectorTargetId,
  type ConnectorTargetRow,
  getConnectorInstanceRow,
  type OrganizationId,
} from "../../store/internal.js"

export function serializeConnectorAccount(row: ConnectorAccountRow, creatorName: string | null = null) {
  return {
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    createdByName: creatorName,
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    displayName: row.displayName,
    externalAccountRef: row.externalAccountRef,
    id: row.id,
    metadata: row.metadataJson ?? undefined,
    organizationId: row.organizationId,
    remoteId: row.remoteId,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function resolveCreatorName(context: PluginArchActorContext, memberId: string) {
  const member = context.organizationContext.members.find((entry) => entry.id === memberId)
  if (!member) return null
  return member.user.name?.trim() || member.user.email || null
}

export function serializeConnectorInstance(row: ConnectorInstanceRow) {
  return {
    connectorAccountId: row.connectorAccountId,
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    createdByOrgMembershipId: row.createdByOrgMembershipId,
    id: row.id,
    instanceConfigJson: row.instanceConfigJson,
    lastSyncCursor: row.lastSyncCursor,
    lastSyncStatus: row.lastSyncStatus,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
    name: row.name,
    organizationId: row.organizationId,
    remoteId: row.remoteId,
    status: row.status,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializeConnectorTarget(row: ConnectorTargetRow) {
  return {
    connectorInstanceId: row.connectorInstanceId,
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    externalTargetRef: row.externalTargetRef,
    id: row.id,
    remoteId: row.remoteId,
    targetConfigJson: row.targetConfigJson,
    targetKind: row.targetKind,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializeConnectorMapping(row: ConnectorMappingRow) {
  return {
    autoAddToPlugin: row.autoAddToPlugin,
    connectorInstanceId: row.connectorInstanceId,
    connectorTargetId: row.connectorTargetId,
    connectorType: row.connectorType,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    mappingConfigJson: row.mappingConfigJson,
    mappingKind: row.mappingKind,
    objectType: row.objectType,
    pluginId: row.pluginId,
    remoteId: row.remoteId,
    selector: row.selector,
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializeConnectorSyncEvent(row: ConnectorSyncEventRow) {
  return {
    attemptCount: row.attemptCount,
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    connectorInstanceId: row.connectorInstanceId,
    connectorTargetId: row.connectorTargetId,
    connectorType: row.connectorType,
    eventType: row.eventType,
    externalEventRef: row.externalEventRef,
    id: row.id,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    remoteId: row.remoteId,
    sourceRevisionRef: row.sourceRevisionRef,
    startedAt: row.startedAt.toISOString(),
    status: row.status,
    summaryJson: row.summaryJson,
  }
}

export async function getConnectorAccountRow(organizationId: OrganizationId, connectorAccountId: ConnectorAccountId) {
  const rows = await db
    .select()
    .from(ConnectorAccountTable)
    .where(and(eq(ConnectorAccountTable.organizationId, organizationId), eq(ConnectorAccountTable.id, connectorAccountId)))
    .limit(1)

  return rows[0] ?? null
}

export async function getConnectorTargetRow(organizationId: OrganizationId, connectorTargetId: ConnectorTargetId) {
  const rows = await db
    .select({ target: ConnectorTargetTable, instance: ConnectorInstanceTable })
    .from(ConnectorTargetTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorTargetTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorTargetTable.id, connectorTargetId), eq(ConnectorInstanceTable.organizationId, organizationId)))
    .limit(1)

  return rows[0]?.target ?? null
}

export async function getConnectorMappingRow(organizationId: OrganizationId, connectorMappingId: ConnectorMappingId) {
  const rows = await db
    .select({ mapping: ConnectorMappingTable, instance: ConnectorInstanceTable })
    .from(ConnectorMappingTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorMappingTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorMappingTable.id, connectorMappingId), eq(ConnectorInstanceTable.organizationId, organizationId)))
    .limit(1)

  return rows[0]?.mapping ?? null
}

export async function getConnectorSyncEventRow(organizationId: OrganizationId, connectorSyncEventId: ConnectorSyncEventId) {
  const rows = await db
    .select({ event: ConnectorSyncEventTable, instance: ConnectorInstanceTable })
    .from(ConnectorSyncEventTable)
    .innerJoin(ConnectorInstanceTable, eq(ConnectorSyncEventTable.connectorInstanceId, ConnectorInstanceTable.id))
    .where(and(eq(ConnectorSyncEventTable.id, connectorSyncEventId), eq(ConnectorInstanceTable.organizationId, organizationId)))
    .limit(1)

  return rows[0]?.event ?? null
}

export async function ensureEditableConnectorInstance(context: PluginArchActorContext, connectorInstanceId: ConnectorInstanceId) {
  const row = await getConnectorInstanceRow(context.organizationContext.organization.id, connectorInstanceId)
  if (!row) {
    throw new PluginArchRouteFailure(404, "connector_instance_not_found", "Connector instance not found.")
  }
  await requirePluginArchResourceRole({ context, resourceId: row.id, resourceKind: "connector_instance", role: "editor" })
  return row
}

export function githubConnectorAppConfig() {
  try {
    return getGithubConnectorAppConfig(env.githubConnectorApp)
  } catch (error) {
    if (error instanceof GithubConnectorConfigError) {
      throw new PluginArchRouteFailure(409, "github_connector_app_not_configured", error.message)
    }
    throw error
  }
}

export function wrapGithubConnectorError(error: unknown): never {
  if (error instanceof PluginArchRouteFailure) {
    throw error
  }

  if (error instanceof GithubConnectorConfigError) {
    throw new PluginArchRouteFailure(409, "github_connector_app_not_configured", error.message)
  }

  if (error instanceof GithubConnectorRequestError) {
    throw new PluginArchRouteFailure(409, "github_connector_request_failed", error.message, { cause: error })
  }

  throw error
}
