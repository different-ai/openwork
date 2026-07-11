import { relations, sql } from "drizzle-orm"
import {
  boolean,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedTextColumn } from "../../columns"
import { MemberTable, OrganizationTable } from "../org"
import {
  MCP_DIAGNOSTIC_ATTEMPT_STATUSES,
  MCP_DIAGNOSTIC_ACTION_OWNERS,
  MCP_DIAGNOSTIC_EVENT_OUTCOMES,
  MCP_DIAGNOSTIC_HEALTH_LEVELS,
  MCP_DIAGNOSTIC_PHASES,
  type McpDiagnosticSafeEvidence,
} from "@openwork/types/den/mcp-diagnostics"

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
    /**
     * Free-form provider-specific extras: for MCP-SDK-driven external
     * connections this holds a small allowlist of non-secret registration
     * metadata. Registration access tokens and client secrets are never
     * stored in this JSON column; client secrets use the encrypted column.
     * For native providers this is typically empty.
     */
    extra: json("extra").$type<Record<string, unknown>>(),
    createdByOrgMembershipId: denTypeIdColumn(
      "member",
      "created_by_org_membership_id",
    ).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    revision: int("revision").notNull().default(1),
  },
  (table) => [
    index("org_oauth_client_organization_id").on(table.organizationId),
    uniqueIndex("org_oauth_client_org_provider").on(
      table.organizationId,
      table.providerId,
    ),
  ],
)

export const ConnectedAccountTable = mysqlTable(
  "connected_account",
  {
    id: denTypeIdColumn("connectedAccount", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    /**
     * Mandatory single owner. Unlike LLM provider keys (legitimately
     * org-shared), a connected account's credential belongs to one human's
     * grant (their inbox, their Drive, their MCP session) — it is never
     * org-wide or team-shared.
     */
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    externalAccountId: varchar("external_account_id", { length: 255 }),
    scopes: json("scopes").$type<string[]>(),
    accessToken: encryptedTextColumn("access_token"),
    refreshToken: encryptedTextColumn("refresh_token"),
    tokenType: varchar("token_type", { length: 64 }),
    expiresAt: timestamp("expires_at", { fsp: 3 }),
    /**
     * Transient PKCE code verifier, present only between connect/start and
     * connect/callback for a given (org, member, provider). Cleared once
     * tokens are saved.
     */
    pendingCodeVerifier: encryptedTextColumn("pending_code_verifier"),
    connectedAt: timestamp("connected_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("connected_account_organization_id").on(table.organizationId),
    index("connected_account_org_membership_id").on(table.orgMembershipId),
    uniqueIndex("connected_account_member_provider").on(
      table.orgMembershipId,
      table.providerId,
    ),
  ],
)

export const externalMcpAuthTypeValues = ["oauth", "apikey", "none"] as const
export type ExternalMcpAuthType = (typeof externalMcpAuthTypeValues)[number]

export const externalMcpCredentialModeValues = ["shared", "per_member"] as const
export type ExternalMcpCredentialMode = (typeof externalMcpCredentialModeValues)[number]

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
    url: varchar("url", { length: 2048 }).notNull(),
    authType: mysqlEnum("auth_type", externalMcpAuthTypeValues).notNull(),
    /**
     * How the connection's credential relates to people:
     * - "shared": one org-level credential (this row's token columns, or
     *   apiKey). Everyone granted access acts as that single account —
     *   right for service-account/bot-style integrations.
     * - "per_member": the connection (and its dynamically-registered OAuth
     *   client) is org-level, but each member authorizes their own account;
     *   tokens live in ConnectedAccountTable keyed by
     *   (orgMembershipId, providerId = this row's id). The agent then acts
     *   as the calling member, preserving the provider's own ACLs and audit
     *   trail — right for Notion/Linear-style personal-permission SaaS.
     */
    credentialMode: mysqlEnum("credential_mode", externalMcpCredentialModeValues).notNull().default("shared"),
    /** Only set when authType = "apikey". Sent as a Bearer token. */
    apiKey: encryptedTextColumn("api_key"),
    /**
     * OAuth tokens for authType = "oauth". Unlike ConnectedAccountTable,
     * this is deliberately org-level, not per-member: an external MCP
     * connection (Notion, Linear, ...) is a shared org integration, like an
     * LLM provider key, not one person's personal grant. Populated by the
     * MCP SDK's own OAuthClientProvider machinery (client/auth.ts), which
     * also handles silent refresh via StreamableHTTPClientTransport.
     */
    accessToken: encryptedTextColumn("access_token"),
    refreshToken: encryptedTextColumn("refresh_token"),
    tokenType: varchar("token_type", { length: 64 }),
    scope: varchar("scope", { length: 1024 }),
    expiresAt: timestamp("expires_at", { fsp: 3 }),
    /**
     * Transient PKCE code verifier, present only between connect/start and
     * connect/callback. Cleared once tokens are saved.
     */
    pendingCodeVerifier: encryptedTextColumn("pending_code_verifier"),
    /** Serializes first-time dynamic client registration for this connection. */
    oauthRegistrationLeaseHash: varchar("oauth_registration_lease_hash", { length: 64 }),
    oauthRegistrationLeaseExpiresAt: timestamp("oauth_registration_lease_expires_at", { fsp: 3 }),
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
    index("emc_access_grant_org_membership_id").on(table.orgMembershipId),
    index("emc_access_grant_team_id").on(table.teamId),
    uniqueIndex("emc_access_grant_connection_member").on(
      table.externalMcpConnectionId,
      table.orgMembershipId,
    ),
    uniqueIndex("emc_access_grant_connection_team").on(
      table.externalMcpConnectionId,
      table.teamId,
    ),
  ],
)

/**
 * One-time PKCE grants keyed by a SHA-256 digest of the signed OAuth state.
 * A row belongs to one browser authorization attempt, so concurrent starts
 * for the same shared connection or member cannot overwrite each other's
 * verifier. The raw signed state is never persisted.
 */
export const ExternalMcpOAuthPendingGrantTable = mysqlTable(
  "external_mcp_oauth_pending_grant",
  {
    stateHash: varchar("state_hash", { length: 64 }).notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    externalMcpConnectionId: denTypeIdColumn("externalMcpConnection", "external_mcp_connection_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    codeVerifier: encryptedTextColumn("code_verifier").notNull(),
    orgOAuthClientId: denTypeIdColumn("orgOAuthClient", "org_oauth_client_id").notNull(),
    clientRevision: int("client_revision").notNull(),
    diagnosticAttemptId: denTypeIdColumn("mcpDiagnosticAttempt", "diagnostic_attempt_id"),
    diagnosticGeneration: int("diagnostic_generation"),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("emopg_organization_id").on(table.organizationId),
    index("emopg_connection_id").on(table.externalMcpConnectionId),
    index("emopg_expires_at").on(table.expiresAt),
  ],
)

export const McpDiagnosticAttemptTable = mysqlTable(
  "mcp_diagnostic_attempt",
  {
    id: denTypeIdColumn("mcpDiagnosticAttempt", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    externalMcpConnectionId: denTypeIdColumn("externalMcpConnection", "external_mcp_connection_id").notNull(),
    createdByOrgMembershipId: denTypeIdColumn("member", "created_by_org_membership_id").notNull(),
    status: mysqlEnum("status", MCP_DIAGNOSTIC_ATTEMPT_STATUSES).notNull().default("running"),
    highestHealthLevel: mysqlEnum("highest_health_level", MCP_DIAGNOSTIC_HEALTH_LEVELS).notNull().default("configured"),
    firstFailedPhase: mysqlEnum("first_failed_phase", MCP_DIAGNOSTIC_PHASES),
    firstFailureCategory: varchar("first_failure_category", { length: 128 }),
    firstFailureMessage: text("first_failure_message"),
    actionOwner: mysqlEnum("action_owner", MCP_DIAGNOSTIC_ACTION_OWNERS),
    operatorAction: varchar("operator_action", { length: 128 }),
    authorizationGeneration: int("authorization_generation").notNull().default(0),
    authorizationClaimId: varchar("authorization_claim_id", { length: 64 }),
    authorizationLeaseExpiresAt: timestamp("authorization_lease_expires_at", { fsp: 3 }),
    lastSequence: int("last_sequence").notNull().default(0),
    startedAt: timestamp("started_at", { fsp: 3 }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { fsp: 3 }),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
  },
  (table) => [
    index("mcp_diagnostic_attempt_organization_id").on(table.organizationId),
    index("mcp_diagnostic_attempt_connection_id").on(table.externalMcpConnectionId),
    index("mcp_diagnostic_attempt_expires_at").on(table.expiresAt),
  ],
)

export const McpDiagnosticEventTable = mysqlTable(
  "mcp_diagnostic_event",
  {
    id: denTypeIdColumn("mcpDiagnosticEvent", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    attemptId: denTypeIdColumn("mcpDiagnosticAttempt", "attempt_id").notNull(),
    sequence: int("sequence").notNull(),
    phase: mysqlEnum("phase", MCP_DIAGNOSTIC_PHASES).notNull(),
    outcome: mysqlEnum("outcome", MCP_DIAGNOSTIC_EVENT_OUTCOMES).notNull(),
    elapsedMs: int("elapsed_ms").notNull(),
    phaseDurationMs: int("phase_duration_ms"),
    healthLevel: mysqlEnum("health_level", MCP_DIAGNOSTIC_HEALTH_LEVELS).notNull(),
    messageSafe: varchar("message_safe", { length: 512 }).notNull(),
    category: varchar("category", { length: 128 }),
    retryable: boolean("retryable"),
    actionOwner: mysqlEnum("action_owner", MCP_DIAGNOSTIC_ACTION_OWNERS),
    operatorAction: varchar("operator_action", { length: 128 }),
    evidence: json("evidence").$type<McpDiagnosticSafeEvidence>().notNull(),
    occurredAt: timestamp("occurred_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("mcp_diagnostic_event_organization_id").on(table.organizationId),
    index("mcp_diagnostic_event_attempt_id").on(table.attemptId),
    index("mcp_diagnostic_event_attempt_time").on(table.attemptId, table.occurredAt, table.id),
    uniqueIndex("mcp_diagnostic_event_attempt_sequence").on(table.attemptId, table.sequence),
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
  pendingOAuthGrants: many(ExternalMcpOAuthPendingGrantTable),
  diagnosticAttempts: many(McpDiagnosticAttemptTable),
}))

export const externalMcpOAuthPendingGrantRelations = relations(ExternalMcpOAuthPendingGrantTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [ExternalMcpOAuthPendingGrantTable.organizationId],
    references: [OrganizationTable.id],
  }),
  connection: one(ExternalMcpConnectionTable, {
    fields: [ExternalMcpOAuthPendingGrantTable.externalMcpConnectionId],
    references: [ExternalMcpConnectionTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [ExternalMcpOAuthPendingGrantTable.orgMembershipId],
    references: [MemberTable.id],
  }),
}))

export const mcpDiagnosticAttemptRelations = relations(McpDiagnosticAttemptTable, ({ one, many }) => ({
  organization: one(OrganizationTable, {
    fields: [McpDiagnosticAttemptTable.organizationId],
    references: [OrganizationTable.id],
  }),
  connection: one(ExternalMcpConnectionTable, {
    fields: [McpDiagnosticAttemptTable.externalMcpConnectionId],
    references: [ExternalMcpConnectionTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [McpDiagnosticAttemptTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  events: many(McpDiagnosticEventTable),
}))

export const mcpDiagnosticEventRelations = relations(McpDiagnosticEventTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [McpDiagnosticEventTable.organizationId],
    references: [OrganizationTable.id],
  }),
  attempt: one(McpDiagnosticAttemptTable, {
    fields: [McpDiagnosticEventTable.attemptId],
    references: [McpDiagnosticAttemptTable.id],
  }),
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
}))
