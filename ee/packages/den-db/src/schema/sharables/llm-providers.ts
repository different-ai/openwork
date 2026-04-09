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
    source: mysqlEnum("source", ["models_dev", "custom"]).notNull(),
    providerId: varchar("provider_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    providerConfig: json("provider_config")
      .$type<Record<string, unknown>>()
      .notNull(),
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
    index("llm_provider_model_llm_provider_id").on(table.llmProviderId),
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
    index("llm_provider_access_llm_provider_id").on(table.llmProviderId),
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

export const llmProvider = LlmProviderTable
export const llmProviderModel = LlmProviderModelTable
export const llmProviderAccess = LlmProviderAccessTable
