import { relations, sql } from "drizzle-orm"
import {
  boolean,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import {
  compatJsonColumn,
  denTypeIdColumn,
  encryptedTextColumn,
} from "../../columns"
import { MemberTable, OrganizationTable } from "../org"
import { ConfigObjectTable, PluginTable } from "./plugin-arch"

/**
 * Generic credential layer for "bring your own OAuth client" integrations.
 *
 * This is deliberately provider-agnostic: `providerId` identifies WHAT is
 * being connected, but the shape is identical whether that's a native
 * capability source we implement ourselves (e.g. "google-workspace") or an
 * external MCP server a user adds (where `providerId` is that connection's
 * own row id in ExternalMcpConnectionTable). Adding a new native provider or
 * a new external MCP connection never requires new tables — only a new
 * `providerId` value and, for native providers, a small registry entry
 * describing its OAuth endpoints.
 */

export const OrgOAuthClientTable = mysqlTable(
  "org_oauth_client",
  {
    id: denTypeIdColumn("orgOAuthClient", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    clientId: varchar("client_id", { length: 512 }).notNull(),
    clientSecret: encryptedTextColumn("client_secret"),
    extra: compatJsonColumn<Record<string, unknown>>("extra"),
    createdByOrgMembershipId: denTypeIdColumn(
      "member",
      "created_by_org_membership_id",
    ).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("org_oauth_client_org_provider").on(
      table.organizationId,
      table.providerId,
    ),
  ],
)

export type ExternalMcpReadinessFailure = "sign_in_required" | "sign_in_rejected" | "setup_required" | "provider_setup_required" | "unavailable" | "timed_out" | "settings_changed" | "tools_unreadable"

export type ExternalMcpReadinessCheck = {
  status: "ready" | "could_not_verify"
  checkedAt: string
  lastSuccessfulAt: string | null
  reason: string | null
  failure?: ExternalMcpReadinessFailure | null
  code?: string | null
  referenceId?: string | null
  providerSettingsUrl?: string | null
  fingerprint: string
}

export const ConnectedAccountTable = mysqlTable(
  "connected_account",
  {
    id: denTypeIdColumn("connectedAccount", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    externalAccountId: varchar("external_account_id", { length: 255 }),
    scopes: compatJsonColumn<string[]>("scopes"),
    accessToken: encryptedTextColumn("access_token"),
    refreshToken: encryptedTextColumn("refresh_token"),
    tokenType: varchar("token_type", { length: 64 }),
    expiresAt: timestamp("expires_at", { fsp: 3 }),
    pendingCodeVerifier: encryptedTextColumn("pending_code_verifier"),
    credentialHealth: compatJsonColumn<ExternalMcpCredentialHealth>("credential_health"),
    readinessCheck: compatJsonColumn<ExternalMcpReadinessCheck>("readiness_check"),
    readinessCredentialBinding: varchar("readiness_credential_binding", { length: 64 }),
    connectedAt: timestamp("connected_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("connected_account_organization_id").on(table.organizationId),
    uniqueIndex("connected_account_member_provider").on(
      table.orgMembershipId,
      table.providerId,
    ),
  ],
)

export const externalMcpAuthTypeValues = ["oauth", "apikey", "none"] as const
export type ExternalMcpAuthType = (typeof externalMcpAuthTypeValues)[number]

export const externalMcpConnectionKindValues = ["external_mcp", "native_provider"] as const
export type ExternalMcpConnectionKind = (typeof externalMcpConnectionKindValues)[number]

export const externalMcpCredentialModeValues = ["shared", "per_member"] as const
export type ExternalMcpCredentialMode = (typeof externalMcpCredentialModeValues)[number]

export const externalMcpOAuthCallbackModeValues = ["shared-v1", "isolated-v1", "legacy-v1"] as const
export type ExternalMcpOAuthCallbackMode = (typeof externalMcpOAuthCallbackModeValues)[number]

export type ExternalMcpOAuthConfiguration = {
  version: 1
  authorizationServerIssuer: string | null
  requestedScopes: string[]
  requestSelectedScopesOnly?: boolean
  callbackMode: ExternalMcpOAuthCallbackMode
  manualOAuthEndpoints?: { authorizationEndpoint: string; tokenEndpoint: string }
  discovery?: Record<string, unknown>
}

export type ExternalMcpToolPolicy = {
  version: 1
  allDisabled: boolean
  disabledTools: string[]
  updatedByOrgMembershipId?: string
  updatedByName?: string
  updatedAt?: string
}

export type ExternalMcpCredentialHealth = {
  version: 1
  status: "ready" | "reconnect_required"
  reason:
    | "authorization_rejected"
    | "credential_expired"
    | "post_authorization_validation_failed"
    | null
  checkedAt: string
}

/**
 * "Add any MCP" — an org-level registration of a third-party MCP server.
 * This is what makes Notion (or anything else) just an example rather than a
 * special case: any URL can be added here, and once connected, its tools are
 * merged into the same search_capabilities/execute_capability surface as
 * every native capability.
 */
export const ExternalMcpConnectionTable = mysqlTable(
  "external_mcp_connection",
  {
    id: denTypeIdColumn("externalMcpConnection", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    externalKey: varchar("external_key", { length: 128 }),
    url: varchar("url", { length: 2048 }).notNull(),
    authType: mysqlEnum("auth_type", externalMcpAuthTypeValues).notNull(),
    kind: mysqlEnum("kind", externalMcpConnectionKindValues).notNull().default("external_mcp"),
    nativeProviderKey: varchar("native_provider_key", { length: 64 }),
    oauthConfiguration: compatJsonColumn<ExternalMcpOAuthConfiguration>("oauth_configuration"),
    toolPolicy: compatJsonColumn<ExternalMcpToolPolicy>("tool_policy"),
    exposeDirectly: boolean("expose_directly").notNull().default(false),
    credentialMode: mysqlEnum("credential_mode", externalMcpCredentialModeValues).notNull().default("shared"),
    apiKey: encryptedTextColumn("api_key"),
    apiKeyAuthScheme: mysqlEnum("api_key_auth_scheme", ["bearer", "token"]).notNull().default("bearer"),
    requestHeaders: encryptedTextColumn("request_headers"),
    accessToken: encryptedTextColumn("access_token"),
    refreshToken: encryptedTextColumn("refresh_token"),
    tokenType: varchar("token_type", { length: 64 }),
    scope: text("scope"),
    expiresAt: timestamp("expires_at", { fsp: 3 }),
    pendingCodeVerifier: encryptedTextColumn("pending_code_verifier"),
    credentialHealth: compatJsonColumn<ExternalMcpCredentialHealth>("credential_health"),
    readinessCheck: compatJsonColumn<ExternalMcpReadinessCheck>("readiness_check"),
    readinessCredentialBinding: varchar("readiness_credential_binding", { length: 64 }),
    oauthIssuerReviewRequiredAt: timestamp("oauth_issuer_review_required_at", { fsp: 3 }),
    connectedAt: timestamp("connected_at", { fsp: 3 }),
    createdByOrgMembershipId: denTypeIdColumn(
      "member",
      "created_by_org_membership_id",
    ).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("external_mcp_connection_organization_id").on(table.organizationId),
    uniqueIndex("external_mcp_connection_org_external_key").on(
      table.organizationId,
      table.externalKey,
    ),
  ],
)

/**
 * Who in the org can USE a connection (see it in search_capabilities and
 * call it via execute_capability). One row = one grant to a member, a team,
 * or the whole org (exactly one of orgMembershipId / teamId / orgWide per
 * row). Deliberately naive vs the plugin-arch grant tables: no role column
 * (use = use; managing connections stays admin-only) and hard-delete
 * (mirrors LlmProviderAccessTable). Access is never implicit: zero rows
 * means nobody (but org admins) can use the connection.
 */
export const ExternalMcpConnectionAccessGrantTable = mysqlTable(
  "external_mcp_connection_access_grant",
  {
    id: denTypeIdColumn("externalMcpConnectionAccessGrant", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    externalMcpConnectionId: denTypeIdColumn(
      "externalMcpConnection",
      "external_mcp_connection_id",
    ).notNull(),
    pluginMcpRequirementBindingId: denTypeIdColumn("pluginMcpRequirementBinding", "plugin_mcp_requirement_binding_id"),
    sourceKey: varchar("source_key", { length: 64 }).notNull().default("direct"),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    orgWide: boolean("org_wide").notNull().default(false),
    createdByOrgMembershipId: denTypeIdColumn(
      "member",
      "created_by_org_membership_id",
    ).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("emc_access_grant_organization_id").on(table.organizationId),
    index("emc_access_grant_connection_id").on(table.externalMcpConnectionId),
    index("emc_access_grant_plugin_mcp_binding_id").on(table.pluginMcpRequirementBindingId),
    index("emc_access_grant_org_membership_id").on(table.orgMembershipId),
    index("emc_access_grant_team_id").on(table.teamId),
    uniqueIndex("emc_access_grant_connection_member").on(
      table.externalMcpConnectionId,
      table.orgMembershipId,
      table.sourceKey,
    ),
    uniqueIndex("emc_access_grant_connection_team").on(
      table.externalMcpConnectionId,
      table.teamId,
      table.sourceKey,
    ),
  ],
)

export const PluginMcpRequirementBindingTable = mysqlTable(
  "plugin_mcp_requirement_binding",
  {
    id: denTypeIdColumn("pluginMcpRequirementBinding", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    pluginId: denTypeIdColumn("plugin", "plugin_id").notNull(),
    configObjectId: denTypeIdColumn("configObject", "config_object_id").notNull(),
    serverName: varchar("server_name", { length: 255 }).notNull(),
    externalMcpConnectionId: denTypeIdColumn("externalMcpConnection", "external_mcp_connection_id").notNull(),
    requiredAuthType: mysqlEnum("required_auth_type", externalMcpAuthTypeValues),
    connectionOwnedByPlugin: boolean("connection_owned_by_plugin").notNull().default(false),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("plugin_mcp_req_binding_plugin_id").on(table.pluginId),
    index("plugin_mcp_req_binding_config_object_id").on(table.configObjectId),
    index("plugin_mcp_req_binding_connection_id").on(table.externalMcpConnectionId),
    uniqueIndex("plugin_mcp_req_binding_org_plugin_object_server").on(table.organizationId, table.pluginId, table.configObjectId, table.serverName),
  ],
)

export const orgOAuthClientRelations = relations(OrgOAuthClientTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [OrgOAuthClientTable.organizationId],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [OrgOAuthClientTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
}))

export const connectedAccountRelations = relations(ConnectedAccountTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [ConnectedAccountTable.organizationId],
    references: [OrganizationTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [ConnectedAccountTable.orgMembershipId],
    references: [MemberTable.id],
  }),
}))

export const externalMcpConnectionRelations = relations(ExternalMcpConnectionTable, ({ one, many }) => ({
  organization: one(OrganizationTable, {
    fields: [ExternalMcpConnectionTable.organizationId],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [ExternalMcpConnectionTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  accessGrants: many(ExternalMcpConnectionAccessGrantTable),
  pluginMcpRequirementBindings: many(PluginMcpRequirementBindingTable),
}))

export const externalMcpConnectionAccessGrantRelations = relations(ExternalMcpConnectionAccessGrantTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [ExternalMcpConnectionAccessGrantTable.organizationId],
    references: [OrganizationTable.id],
  }),
  connection: one(ExternalMcpConnectionTable, {
    fields: [ExternalMcpConnectionAccessGrantTable.externalMcpConnectionId],
    references: [ExternalMcpConnectionTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [ExternalMcpConnectionAccessGrantTable.orgMembershipId],
    references: [MemberTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [ExternalMcpConnectionAccessGrantTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  pluginMcpRequirementBinding: one(PluginMcpRequirementBindingTable, {
    fields: [ExternalMcpConnectionAccessGrantTable.pluginMcpRequirementBindingId],
    references: [PluginMcpRequirementBindingTable.id],
  }),
}))

export const pluginMcpRequirementBindingRelations = relations(PluginMcpRequirementBindingTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [PluginMcpRequirementBindingTable.organizationId],
    references: [OrganizationTable.id],
  }),
  plugin: one(PluginTable, {
    fields: [PluginMcpRequirementBindingTable.pluginId],
    references: [PluginTable.id],
  }),
  configObject: one(ConfigObjectTable, {
    fields: [PluginMcpRequirementBindingTable.configObjectId],
    references: [ConfigObjectTable.id],
  }),
  connection: one(ExternalMcpConnectionTable, {
    fields: [PluginMcpRequirementBindingTable.externalMcpConnectionId],
    references: [ExternalMcpConnectionTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [PluginMcpRequirementBindingTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
}))
