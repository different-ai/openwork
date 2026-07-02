import { relations, sql } from "drizzle-orm"
import {
  index,
  json,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedTextColumn } from "../../columns"
import { MemberTable, OrganizationTable } from "../org"

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
     * connections this holds the dynamically-registered client metadata
     * (client_id_issued_at, registration_access_token, etc.) and cached
     * discovery state (authorization server URLs) so the SDK's `auth()`
     * doesn't have to re-discover on every call. For native providers this
     * is typically empty.
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
    /** Only set when authType = "apikey". Sent as a Bearer token. */
    apiKey: encryptedTextColumn("api_key"),
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

export const externalMcpConnectionRelations = relations(ExternalMcpConnectionTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [ExternalMcpConnectionTable.organizationId],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [ExternalMcpConnectionTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
}))
