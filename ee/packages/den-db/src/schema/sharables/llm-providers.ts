import { relations, sql } from "drizzle-orm"
import {
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedTextColumn } from "../../columns"
import { MemberTable, OrganizationTable } from "../org"
import { TeamTable } from "../teams"

export const LlmProviderTable = mysqlTable(
  "llm_provider",
  {
    id: denTypeIdColumn("llmProvider", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    createdByOrgMembershipId: denTypeIdColumn(
      "member",
      "created_by_org_membership_id",
    ).notNull(),
    source: mysqlEnum("source", ["models_dev", "custom", "openwork"]).notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    providerConfig: json("provider_config")
      .$type<Record<string, unknown>>()
      .notNull(),
    /**
     * How the provider credential relates to people. Shared providers use the
     * org-level apiKey below; per-member providers resolve a credential from
     * LlmProviderMemberCredentialTable for the calling member.
     */
    credentialMode: mysqlEnum("credential_mode", ["shared", "per_member"]).notNull().default("shared"),
    apiKey: encryptedTextColumn("api_key"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("llm_provider_organization_id").on(table.organizationId),
    index("llm_provider_created_by_org_membership_id").on(
      table.createdByOrgMembershipId,
    ),
    index("llm_provider_source").on(table.source),
    index("llm_provider_provider_id").on(table.providerId),
  ],
)

export const LlmProviderModelTable = mysqlTable(
  "llm_provider_model",
  {
    id: denTypeIdColumn("llmProviderModel", "id").notNull().primaryKey(),
    llmProviderId: denTypeIdColumn("llmProvider", "llm_provider_id").notNull(),
    modelId: varchar("model_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    modelConfig: json("model_config")
      .$type<Record<string, unknown>>()
      .notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("llm_provider_model_model_id").on(table.modelId),
    uniqueIndex("llm_provider_model_provider_model").on(
      table.llmProviderId,
      table.modelId,
    ),
  ],
)

export const LlmProviderAccessTable = mysqlTable(
  "llm_provider_access",
  {
    id: denTypeIdColumn("llmProviderAccess", "id").notNull().primaryKey(),
    llmProviderId: denTypeIdColumn("llmProvider", "llm_provider_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id"),
    teamId: denTypeIdColumn("team", "team_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("llm_provider_access_org_membership_id").on(table.orgMembershipId),
    index("llm_provider_access_team_id").on(table.teamId),
    uniqueIndex("llm_provider_access_provider_org_membership").on(
      table.llmProviderId,
      table.orgMembershipId,
    ),
    uniqueIndex("llm_provider_access_provider_team").on(
      table.llmProviderId,
      table.teamId,
    ),
  ],
)

/**
 * One member-scoped credential for a per-member LLM provider. The encrypted
 * secret uses the same scalar-or-env-map encoding as LlmProviderTable.apiKey.
 */
export const LlmProviderMemberCredentialTable = mysqlTable(
  "llm_provider_member_credential",
  {
    id: denTypeIdColumn("llmProviderMemberCredential", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    llmProviderId: denTypeIdColumn("llmProvider", "llm_provider_id").notNull(),
    orgMembershipId: denTypeIdColumn("member", "org_membership_id").notNull(),
    secret: encryptedTextColumn("secret").notNull(),
    externalPrincipalId: varchar("external_principal_id", { length: 255 }),
    externalCredentialId: varchar("external_credential_id", { length: 255 }),
    state: mysqlEnum("state", ["active", "blocked", "stale", "error"]).notNull().default("active"),
    version: int("version").notNull().default(1),
    createdBy: mysqlEnum("created_by", ["member", "admin", "provisioner"]).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("llm_provider_member_credential_organization_id").on(table.organizationId),
    uniqueIndex("llm_provider_member_credential_member_provider").on(
      table.orgMembershipId,
      table.llmProviderId,
    ),
  ],
)

export const llmProviderRelations = relations(LlmProviderTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [LlmProviderTable.organizationId],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [LlmProviderTable.createdByOrgMembershipId],
    references: [MemberTable.id],
  }),
  models: many(LlmProviderModelTable),
  accessLinks: many(LlmProviderAccessTable),
  memberCredentials: many(LlmProviderMemberCredentialTable),
}))

export const llmProviderModelRelations = relations(
  LlmProviderModelTable,
  ({ one }) => ({
    llmProvider: one(LlmProviderTable, {
      fields: [LlmProviderModelTable.llmProviderId],
      references: [LlmProviderTable.id],
    }),
  }),
)

export const llmProviderAccessRelations = relations(
  LlmProviderAccessTable,
  ({ one }) => ({
    llmProvider: one(LlmProviderTable, {
      fields: [LlmProviderAccessTable.llmProviderId],
      references: [LlmProviderTable.id],
    }),
    orgMembership: one(MemberTable, {
      fields: [LlmProviderAccessTable.orgMembershipId],
      references: [MemberTable.id],
    }),
    team: one(TeamTable, {
      fields: [LlmProviderAccessTable.teamId],
      references: [TeamTable.id],
    }),
  }),
)

export const llmProviderMemberCredentialRelations = relations(
  LlmProviderMemberCredentialTable,
  ({ one }) => ({
    organization: one(OrganizationTable, {
      fields: [LlmProviderMemberCredentialTable.organizationId],
      references: [OrganizationTable.id],
    }),
    llmProvider: one(LlmProviderTable, {
      fields: [LlmProviderMemberCredentialTable.llmProviderId],
      references: [LlmProviderTable.id],
    }),
    orgMembership: one(MemberTable, {
      fields: [LlmProviderMemberCredentialTable.orgMembershipId],
      references: [MemberTable.id],
    }),
  }),
)

export const llmProvider = LlmProviderTable
export const llmProviderModel = LlmProviderModelTable
export const llmProviderAccess = LlmProviderAccessTable
export const llmProviderMemberCredential = LlmProviderMemberCredentialTable
