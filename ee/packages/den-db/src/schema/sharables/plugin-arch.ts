import { relations, sql } from "drizzle-orm"
import {
  boolean,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedColumn, encryptedTextColumn } from "../../columns"
import { MemberTable, OrganizationTable } from "../org"
import { TeamTable } from "../teams"

export const configObjectTypeValues = ["skill", "agent", "command", "tool", "mcp", "hook", "context", "custom"] as const
export const configObjectSourceModeValues = ["cloud", "import", "connector"] as const
export const configObjectStatusValues = ["active", "inactive", "deleted", "archived", "ingestion_error"] as const
export const configObjectCreatedViaValues = ["cloud", "import", "connector", "system"] as const
export const pluginStatusValues = ["active", "inactive", "deleted", "archived"] as const
export const membershipSourceValues = ["manual", "connector", "api", "system"] as const
export const accessRoleValues = ["viewer", "editor", "manager"] as const
export const connectorTypeValues = ["github"] as const
export const connectorAccountStatusValues = ["active", "inactive", "disconnected", "error"] as const
export const connectorInstanceStatusValues = ["active", "disabled", "archived", "error"] as const
export const connectorTargetKindValues = ["repository_branch"] as const
export const connectorMappingKindValues = ["path", "api", "custom"] as const
export const connectorSyncEventTypeValues = ["push", "installation", "installation_repositories", "repository", "manual_resync"] as const
export const connectorSyncStatusValues = ["pending", "queued", "running", "completed", "failed", "partial", "ignored"] as const

function encryptedJsonColumn<TData extends Record<string, unknown> | Array<unknown> | null>(columnName: string) {
  return encryptedColumn<TData>(columnName, {
    deserialize: (value) => JSON.parse(value) as TData,
    serialize: (value) => JSON.stringify(value),
  })
}

export const ConfigObjectTable = mysqlTable(
  "config_object",
  {
    id: denTypeIdColumn("configObject", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    objectType: mysqlEnum("object_type", configObjectTypeValues).notNull(),
    sourceMode: mysqlEnum("source_mode", configObjectSourceModeValues).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: text("description"),
    searchText: text("search_text"),
    currentFileName: varchar("current_file_name", { length: 255 }),
    currentFileExtension: varchar("current_file_extension", { length: 64 }),
    currentRelativePath: varchar("current_relative_path", { length: 255 }),
    status: mysqlEnum("status", configObjectStatusValues).notNull().default("active"),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    connectorInstanceId: denTypeIdColumn("connectorInstance", "connector_instance_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    deletedAt: timestamp("deleted_at", { fsp: 3 }),
  },
  (table) => [
    index("config_object_organization_id").on(table.organizationId),
    index("config_object_type").on(table.objectType),
    index("config_object_source_mode").on(table.sourceMode),
    index("config_object_status").on(table.status),
    index("config_object_created_by_org_membership_id").on(table.createdByOrgMembershipId),
    index("config_object_connector_instance_id").on(table.connectorInstanceId),
    index("config_object_current_relative_path").on(table.currentRelativePath),
  ],
)

export const ConfigObjectVersionTable = mysqlTable(
  "config_object_version",
  {
    id: denTypeIdColumn("configObjectVersion", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    configObjectId: denTypeIdColumn("configObject", "config_object_id").notNull(),
    normalizedPayloadJson: encryptedJsonColumn<Record<string, unknown> | null>("normalized_payload_json"),
    rawSourceText: encryptedTextColumn("raw_source_text"),
    schemaVersion: varchar("schema_version", { length: 100 }),
    createdVia: mysqlEnum("created_via", configObjectCreatedViaValues).notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id"),
    connectorSyncEventId: denTypeIdColumn("connectorSyncEvent", "connector_sync_event_id"),
    sourceRevisionRef: varchar("source_revision_ref", { length: 255 }),
    isDeletedVersion: boolean("is_deleted_version").notNull().default(false),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("config_object_version_organization_id").on(table.organizationId),
    index("config_object_version_config_object_id").on(table.configObjectId),
    index("config_object_version_created_by_org_membership_id").on(table.createdByOrgMembershipId),
    index("config_object_version_connector_sync_event_id").on(table.connectorSyncEventId),
    index("config_object_version_source_revision_ref").on(table.sourceRevisionRef),
    index("config_object_version_lookup_latest").on(table.configObjectId, table.createdAt, table.id),
  ],
)

export const PluginTable = mysqlTable(
  "plugin",
  {
    id: denTypeIdColumn("plugin", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: mysqlEnum("status", pluginStatusValues).notNull().default("active"),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    deletedAt: timestamp("deleted_at", { fsp: 3 }),
  },
  (table) => [
    index("plugin_organization_id").on(table.organizationId),
    index("plugin_created_by_org_membership_id").on(table.createdByOrgMembershipId),
    index("plugin_status").on(table.status),
    index("plugin_name").on(table.name),
  ],
)

export const PluginConfigObjectTable = mysqlTable(
  "plugin_config_object",
  {
    id: denTypeIdColumn("pluginConfigObject", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    pluginId: denTypeIdColumn("plugin", "plugin_id").notNull(),
    configObjectId: denTypeIdColumn("configObject", "config_object_id").notNull(),
    membershipSource: mysqlEnum("membership_source", membershipSourceValues).notNull().default("manual"),
    connectorMappingId: denTypeIdColumn("connectorMapping", "connector_mapping_id"),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
  },
  (table) => [
    index("plugin_config_object_organization_id").on(table.organizationId),
    index("plugin_config_object_plugin_id").on(table.pluginId),
    index("plugin_config_object_config_object_id").on(table.configObjectId),
    index("plugin_config_object_connector_mapping_id").on(table.connectorMappingId),
    uniqueIndex("plugin_config_object_plugin_config_object").on(table.pluginId, table.configObjectId),
  ],
)

export const ConfigObjectAccessGrantTable = mysqlTable(
  "config_object_access_grant",
  {
    id: denTypeIdColumn("configObjectAccessGrant", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    configObjectId: denTypeIdColumn("configObject", "config_object_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    orgWide: boolean("org_wide").notNull().default(false),
    role: mysqlEnum("role", accessRoleValues).notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
  },
  (table) => [
    index("config_object_access_grant_organization_id").on(table.organizationId),
    index("config_object_access_grant_config_object_id").on(table.configObjectId),
    index("config_object_access_grant_org_membership_id").on(table.orgMembershipId),
    index("config_object_access_grant_team_id").on(table.teamId),
    index("config_object_access_grant_org_wide").on(table.orgWide),
    uniqueIndex("config_object_access_grant_object_org_membership").on(table.configObjectId, table.orgMembershipId),
    uniqueIndex("config_object_access_grant_object_team").on(table.configObjectId, table.teamId),
  ],
)

export const PluginAccessGrantTable = mysqlTable(
  "plugin_access_grant",
  {
    id: denTypeIdColumn("pluginAccessGrant", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    pluginId: denTypeIdColumn("plugin", "plugin_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    orgWide: boolean("org_wide").notNull().default(false),
    role: mysqlEnum("role", accessRoleValues).notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
  },
  (table) => [
    index("plugin_access_grant_organization_id").on(table.organizationId),
    index("plugin_access_grant_plugin_id").on(table.pluginId),
    index("plugin_access_grant_org_membership_id").on(table.orgMembershipId),
    index("plugin_access_grant_team_id").on(table.teamId),
    index("plugin_access_grant_org_wide").on(table.orgWide),
    uniqueIndex("plugin_access_grant_plugin_org_membership").on(table.pluginId, table.orgMembershipId),
    uniqueIndex("plugin_access_grant_plugin_team").on(table.pluginId, table.teamId),
  ],
)

export const ConnectorAccountTable = mysqlTable(
  "connector_account",
  {
    id: denTypeIdColumn("connectorAccount", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    connectorType: mysqlEnum("connector_type", connectorTypeValues).notNull(),
    remoteId: varchar("remote_id", { length: 255 }).notNull(),
    externalAccountRef: varchar("external_account_ref", { length: 255 }),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    status: mysqlEnum("status", connectorAccountStatusValues).notNull().default("active"),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    metadataJson: json("metadata_json").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("connector_account_organization_id").on(table.organizationId),
    index("connector_account_created_by_org_membership_id").on(table.createdByOrgMembershipId),
    index("connector_account_connector_type").on(table.connectorType),
    index("connector_account_status").on(table.status),
    uniqueIndex("connector_account_org_type_remote_id").on(table.organizationId, table.connectorType, table.remoteId),
  ],
)

export const ConnectorInstanceTable = mysqlTable(
  "connector_instance",
  {
    id: denTypeIdColumn("connectorInstance", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    connectorAccountId: denTypeIdColumn("connectorAccount", "connector_account_id").notNull(),
    connectorType: mysqlEnum("connector_type", connectorTypeValues).notNull(),
    remoteId: varchar("remote_id", { length: 255 }),
    name: varchar("name", { length: 255 }).notNull(),
    status: mysqlEnum("status", connectorInstanceStatusValues).notNull().default("active"),
    instanceConfigJson: json("instance_config_json").$type<Record<string, unknown> | null>(),
    lastSyncedAt: timestamp("last_synced_at", { fsp: 3 }),
    lastSyncStatus: mysqlEnum("last_sync_status", connectorSyncStatusValues),
    lastSyncCursor: text("last_sync_cursor"),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("connector_instance_organization_id").on(table.organizationId),
    index("connector_instance_connector_account_id").on(table.connectorAccountId),
    index("connector_instance_created_by_org_membership_id").on(table.createdByOrgMembershipId),
    index("connector_instance_connector_type").on(table.connectorType),
    index("connector_instance_status").on(table.status),
    uniqueIndex("connector_instance_org_name").on(table.organizationId, table.name),
  ],
)

export const ConnectorInstanceAccessGrantTable = mysqlTable(
  "connector_instance_access_grant",
  {
    id: denTypeIdColumn("connectorInstanceAccessGrant", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    connectorInstanceId: denTypeIdColumn("connectorInstance", "connector_instance_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    orgWide: boolean("org_wide").notNull().default(false),
    role: mysqlEnum("role", accessRoleValues).notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { fsp: 3 }),
  },
  (table) => [
    index("connector_instance_access_grant_organization_id").on(table.organizationId),
    index("connector_instance_access_grant_instance_id").on(table.connectorInstanceId),
    index("connector_instance_access_grant_org_membership_id").on(table.orgMembershipId),
    index("connector_instance_access_grant_team_id").on(table.teamId),
    index("connector_instance_access_grant_org_wide").on(table.orgWide),
    uniqueIndex("connector_instance_access_grant_instance_org_membership").on(table.connectorInstanceId, table.orgMembershipId),
    uniqueIndex("connector_instance_access_grant_instance_team").on(table.connectorInstanceId, table.teamId),
  ],
)

export const ConnectorTargetTable = mysqlTable(
  "connector_target",
  {
    id: denTypeIdColumn("connectorTarget", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    connectorInstanceId: denTypeIdColumn("connectorInstance", "connector_instance_id").notNull(),
    connectorType: mysqlEnum("connector_type", connectorTypeValues).notNull(),
    remoteId: varchar("remote_id", { length: 255 }).notNull(),
    targetKind: mysqlEnum("target_kind", connectorTargetKindValues).notNull(),
    externalTargetRef: varchar("external_target_ref", { length: 255 }),
    targetConfigJson: json("target_config_json").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("connector_target_organization_id").on(table.organizationId),
    index("connector_target_connector_instance_id").on(table.connectorInstanceId),
    index("connector_target_connector_type").on(table.connectorType),
    index("connector_target_target_kind").on(table.targetKind),
    uniqueIndex("connector_target_instance_remote_id").on(table.connectorInstanceId, table.remoteId),
  ],
)

export const ConnectorMappingTable = mysqlTable(
  "connector_mapping",
  {
    id: denTypeIdColumn("connectorMapping", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    connectorInstanceId: denTypeIdColumn("connectorInstance", "connector_instance_id").notNull(),
    connectorTargetId: denTypeIdColumn("connectorTarget", "connector_target_id").notNull(),
    connectorType: mysqlEnum("connector_type", connectorTypeValues).notNull(),
    remoteId: varchar("remote_id", { length: 255 }),
    mappingKind: mysqlEnum("mapping_kind", connectorMappingKindValues).notNull(),
    selector: varchar("selector", { length: 255 }).notNull(),
    objectType: mysqlEnum("object_type", configObjectTypeValues).notNull(),
    pluginId: denTypeIdColumn("plugin", "plugin_id"),
    autoAddToPlugin: boolean("auto_add_to_plugin").notNull().default(false),
    mappingConfigJson: json("mapping_config_json").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("connector_mapping_organization_id").on(table.organizationId),
    index("connector_mapping_connector_instance_id").on(table.connectorInstanceId),
    index("connector_mapping_connector_target_id").on(table.connectorTargetId),
    index("connector_mapping_object_type").on(table.objectType),
    index("connector_mapping_plugin_id").on(table.pluginId),
    uniqueIndex("connector_mapping_target_selector_object_type").on(table.connectorTargetId, table.selector, table.objectType),
  ],
)

export const ConnectorSyncEventTable = mysqlTable(
  "connector_sync_event",
  {
    id: denTypeIdColumn("connectorSyncEvent", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    connectorInstanceId: denTypeIdColumn("connectorInstance", "connector_instance_id").notNull(),
    connectorTargetId: denTypeIdColumn("connectorTarget", "connector_target_id"),
    connectorType: mysqlEnum("connector_type", connectorTypeValues).notNull(),
    remoteId: varchar("remote_id", { length: 255 }),
    eventType: mysqlEnum("event_type", connectorSyncEventTypeValues).notNull(),
    externalEventRef: varchar("external_event_ref", { length: 255 }),
    sourceRevisionRef: varchar("source_revision_ref", { length: 255 }),
    status: mysqlEnum("status", connectorSyncStatusValues).notNull().default("pending"),
    summaryJson: json("summary_json").$type<Record<string, unknown> | null>(),
    startedAt: timestamp("started_at", { fsp: 3 }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { fsp: 3 }),
  },
  (table) => [
    index("connector_sync_event_organization_id").on(table.organizationId),
    index("connector_sync_event_connector_instance_id").on(table.connectorInstanceId),
    index("connector_sync_event_connector_target_id").on(table.connectorTargetId),
    index("connector_sync_event_event_type").on(table.eventType),
    index("connector_sync_event_status").on(table.status),
    index("connector_sync_event_source_revision_ref").on(table.sourceRevisionRef),
    index("connector_sync_event_external_event_ref").on(table.externalEventRef),
  ],
)

export const ConnectorSourceBindingTable = mysqlTable(
  "connector_source_binding",
  {
    id: denTypeIdColumn("connectorSourceBinding", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    configObjectId: denTypeIdColumn("configObject", "config_object_id").notNull(),
    connectorInstanceId: denTypeIdColumn("connectorInstance", "connector_instance_id").notNull(),
    connectorTargetId: denTypeIdColumn("connectorTarget", "connector_target_id").notNull(),
    connectorMappingId: denTypeIdColumn("connectorMapping", "connector_mapping_id").notNull(),
    connectorType: mysqlEnum("connector_type", connectorTypeValues).notNull(),
    remoteId: varchar("remote_id", { length: 255 }),
    externalLocator: varchar("external_locator", { length: 255 }).notNull(),
    externalStableRef: varchar("external_stable_ref", { length: 255 }),
    lastSeenSourceRevisionRef: varchar("last_seen_source_revision_ref", { length: 255 }),
    status: mysqlEnum("status", configObjectStatusValues).notNull().default("active"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    deletedAt: timestamp("deleted_at", { fsp: 3 }),
  },
  (table) => [
    index("connector_source_binding_organization_id").on(table.organizationId),
    index("connector_source_binding_config_object_id").on(table.configObjectId),
    index("connector_source_binding_connector_instance_id").on(table.connectorInstanceId),
    index("connector_source_binding_connector_target_id").on(table.connectorTargetId),
    index("connector_source_binding_connector_mapping_id").on(table.connectorMappingId),
    index("connector_source_binding_external_locator").on(table.externalLocator),
    uniqueIndex("connector_source_binding_config_object").on(table.configObjectId),
  ],
)

export const ConnectorSourceTombstoneTable = mysqlTable(
  "connector_source_tombstone",
  {
    id: denTypeIdColumn("connectorSourceTombstone", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    connectorInstanceId: denTypeIdColumn("connectorInstance", "connector_instance_id").notNull(),
    connectorTargetId: denTypeIdColumn("connectorTarget", "connector_target_id").notNull(),
    connectorMappingId: denTypeIdColumn("connectorMapping", "connector_mapping_id").notNull(),
    connectorType: mysqlEnum("connector_type", connectorTypeValues).notNull(),
    remoteId: varchar("remote_id", { length: 255 }),
    externalLocator: varchar("external_locator", { length: 255 }).notNull(),
    formerConfigObjectId: denTypeIdColumn("configObject", "former_config_object_id").notNull(),
    deletedInSyncEventId: denTypeIdColumn("connectorSyncEvent", "deleted_in_sync_event_id").notNull(),
    deletedSourceRevisionRef: varchar("deleted_source_revision_ref", { length: 255 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("connector_source_tombstone_organization_id").on(table.organizationId),
    index("connector_source_tombstone_connector_instance_id").on(table.connectorInstanceId),
    index("connector_source_tombstone_connector_target_id").on(table.connectorTargetId),
    index("connector_source_tombstone_connector_mapping_id").on(table.connectorMappingId),
    index("connector_source_tombstone_external_locator").on(table.externalLocator),
    index("connector_source_tombstone_former_config_object_id").on(table.formerConfigObjectId),
  ],
)

export const configObjectRelations = relations(ConfigObjectTable, ({ many, one }) => ({
  accessGrants: many(ConfigObjectAccessGrantTable),
  connectorInstance: one(ConnectorInstanceTable, {
    fields: [ConfigObjectTable.connectorInstanceId],
    references: [ConnectorInstanceTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [ConfigObjectTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  memberships: many(PluginConfigObjectTable),
  organization: one(OrganizationTable, {
    fields: [ConfigObjectTable.organizationId],
    references: [OrganizationTable.id],
  }),
  sourceBindings: many(ConnectorSourceBindingTable),
  versions: many(ConfigObjectVersionTable),
}))

export const configObjectVersionRelations = relations(ConfigObjectVersionTable, ({ one }) => ({
  configObject: one(ConfigObjectTable, {
    fields: [ConfigObjectVersionTable.configObjectId],
    references: [ConfigObjectTable.id],
  }),
  connectorSyncEvent: one(ConnectorSyncEventTable, {
    fields: [ConfigObjectVersionTable.connectorSyncEventId],
    references: [ConnectorSyncEventTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [ConfigObjectVersionTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
}))

export const pluginRelations = relations(PluginTable, ({ many, one }) => ({
  accessGrants: many(PluginAccessGrantTable),
  createdByOrgMembership: one(MemberTable, {
    fields: [PluginTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  memberships: many(PluginConfigObjectTable),
  organization: one(OrganizationTable, {
    fields: [PluginTable.organizationId],
    references: [OrganizationTable.id],
  }),
  mappings: many(ConnectorMappingTable),
}))

export const pluginConfigObjectRelations = relations(PluginConfigObjectTable, ({ one }) => ({
  configObject: one(ConfigObjectTable, {
    fields: [PluginConfigObjectTable.configObjectId],
    references: [ConfigObjectTable.id],
  }),
  connectorMapping: one(ConnectorMappingTable, {
    fields: [PluginConfigObjectTable.connectorMappingId],
    references: [ConnectorMappingTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [PluginConfigObjectTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  plugin: one(PluginTable, {
    fields: [PluginConfigObjectTable.pluginId],
    references: [PluginTable.id],
  }),
}))

export const configObjectAccessGrantRelations = relations(ConfigObjectAccessGrantTable, ({ one }) => ({
  configObject: one(ConfigObjectTable, {
    fields: [ConfigObjectAccessGrantTable.configObjectId],
    references: [ConfigObjectTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [ConfigObjectAccessGrantTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [ConfigObjectAccessGrantTable.orgMembershipId],
    references: [MemberTable.id],
  }),
  team: one(TeamTable, {
    fields: [ConfigObjectAccessGrantTable.teamId],
    references: [TeamTable.id],
  }),
}))

export const pluginAccessGrantRelations = relations(PluginAccessGrantTable, ({ one }) => ({
  createdByOrgMembership: one(MemberTable, {
    fields: [PluginAccessGrantTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [PluginAccessGrantTable.orgMembershipId],
    references: [MemberTable.id],
  }),
  plugin: one(PluginTable, {
    fields: [PluginAccessGrantTable.pluginId],
    references: [PluginTable.id],
  }),
  team: one(TeamTable, {
    fields: [PluginAccessGrantTable.teamId],
    references: [TeamTable.id],
  }),
}))

export const connectorAccountRelations = relations(ConnectorAccountTable, ({ many, one }) => ({
  createdByOrgMembership: one(MemberTable, {
    fields: [ConnectorAccountTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  instances: many(ConnectorInstanceTable),
  organization: one(OrganizationTable, {
    fields: [ConnectorAccountTable.organizationId],
    references: [OrganizationTable.id],
  }),
}))

export const connectorInstanceRelations = relations(ConnectorInstanceTable, ({ many, one }) => ({
  accessGrants: many(ConnectorInstanceAccessGrantTable),
  account: one(ConnectorAccountTable, {
    fields: [ConnectorInstanceTable.connectorAccountId],
    references: [ConnectorAccountTable.id],
  }),
  configObjects: many(ConfigObjectTable),
  createdByOrgMembership: one(MemberTable, {
    fields: [ConnectorInstanceTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  mappings: many(ConnectorMappingTable),
  organization: one(OrganizationTable, {
    fields: [ConnectorInstanceTable.organizationId],
    references: [OrganizationTable.id],
  }),
  sourceBindings: many(ConnectorSourceBindingTable),
  syncEvents: many(ConnectorSyncEventTable),
  targets: many(ConnectorTargetTable),
  tombstones: many(ConnectorSourceTombstoneTable),
}))

export const connectorInstanceAccessGrantRelations = relations(ConnectorInstanceAccessGrantTable, ({ one }) => ({
  connectorInstance: one(ConnectorInstanceTable, {
    fields: [ConnectorInstanceAccessGrantTable.connectorInstanceId],
    references: [ConnectorInstanceTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [ConnectorInstanceAccessGrantTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [ConnectorInstanceAccessGrantTable.orgMembershipId],
    references: [MemberTable.id],
  }),
  team: one(TeamTable, {
    fields: [ConnectorInstanceAccessGrantTable.teamId],
    references: [TeamTable.id],
  }),
}))

export const connectorTargetRelations = relations(ConnectorTargetTable, ({ many, one }) => ({
  connectorInstance: one(ConnectorInstanceTable, {
    fields: [ConnectorTargetTable.connectorInstanceId],
    references: [ConnectorInstanceTable.id],
  }),
  mappings: many(ConnectorMappingTable),
  sourceBindings: many(ConnectorSourceBindingTable),
  syncEvents: many(ConnectorSyncEventTable),
  tombstones: many(ConnectorSourceTombstoneTable),
}))

export const connectorMappingRelations = relations(ConnectorMappingTable, ({ many, one }) => ({
  connectorInstance: one(ConnectorInstanceTable, {
    fields: [ConnectorMappingTable.connectorInstanceId],
    references: [ConnectorInstanceTable.id],
  }),
  connectorTarget: one(ConnectorTargetTable, {
    fields: [ConnectorMappingTable.connectorTargetId],
    references: [ConnectorTargetTable.id],
  }),
  plugin: one(PluginTable, {
    fields: [ConnectorMappingTable.pluginId],
    references: [PluginTable.id],
  }),
  pluginMemberships: many(PluginConfigObjectTable),
  sourceBindings: many(ConnectorSourceBindingTable),
  tombstones: many(ConnectorSourceTombstoneTable),
}))

export const connectorSyncEventRelations = relations(ConnectorSyncEventTable, ({ many, one }) => ({
  connectorInstance: one(ConnectorInstanceTable, {
    fields: [ConnectorSyncEventTable.connectorInstanceId],
    references: [ConnectorInstanceTable.id],
  }),
  connectorTarget: one(ConnectorTargetTable, {
    fields: [ConnectorSyncEventTable.connectorTargetId],
    references: [ConnectorTargetTable.id],
  }),
  tombstones: many(ConnectorSourceTombstoneTable),
  versions: many(ConfigObjectVersionTable),
}))

export const connectorSourceBindingRelations = relations(ConnectorSourceBindingTable, ({ one }) => ({
  configObject: one(ConfigObjectTable, {
    fields: [ConnectorSourceBindingTable.configObjectId],
    references: [ConfigObjectTable.id],
  }),
  connectorInstance: one(ConnectorInstanceTable, {
    fields: [ConnectorSourceBindingTable.connectorInstanceId],
    references: [ConnectorInstanceTable.id],
  }),
  connectorMapping: one(ConnectorMappingTable, {
    fields: [ConnectorSourceBindingTable.connectorMappingId],
    references: [ConnectorMappingTable.id],
  }),
  connectorTarget: one(ConnectorTargetTable, {
    fields: [ConnectorSourceBindingTable.connectorTargetId],
    references: [ConnectorTargetTable.id],
  }),
}))

export const connectorSourceTombstoneRelations = relations(ConnectorSourceTombstoneTable, ({ one }) => ({
  connectorInstance: one(ConnectorInstanceTable, {
    fields: [ConnectorSourceTombstoneTable.connectorInstanceId],
    references: [ConnectorInstanceTable.id],
  }),
  connectorMapping: one(ConnectorMappingTable, {
    fields: [ConnectorSourceTombstoneTable.connectorMappingId],
    references: [ConnectorMappingTable.id],
  }),
  connectorTarget: one(ConnectorTargetTable, {
    fields: [ConnectorSourceTombstoneTable.connectorTargetId],
    references: [ConnectorTargetTable.id],
  }),
  deletedInSyncEvent: one(ConnectorSyncEventTable, {
    fields: [ConnectorSourceTombstoneTable.deletedInSyncEventId],
    references: [ConnectorSyncEventTable.id],
  }),
  formerConfigObject: one(ConfigObjectTable, {
    fields: [ConnectorSourceTombstoneTable.formerConfigObjectId],
    references: [ConfigObjectTable.id],
  }),
}))

export const configObject = ConfigObjectTable
export const configObjectVersion = ConfigObjectVersionTable
export const plugin = PluginTable
export const pluginConfigObject = PluginConfigObjectTable
export const configObjectAccessGrant = ConfigObjectAccessGrantTable
export const pluginAccessGrant = PluginAccessGrantTable
export const connectorAccount = ConnectorAccountTable
export const connectorInstance = ConnectorInstanceTable
export const connectorInstanceAccessGrant = ConnectorInstanceAccessGrantTable
export const connectorTarget = ConnectorTargetTable
export const connectorMapping = ConnectorMappingTable
export const connectorSyncEvent = ConnectorSyncEventTable
export const connectorSourceBinding = ConnectorSourceBindingTable
export const connectorSourceTombstone = ConnectorSourceTombstoneTable
