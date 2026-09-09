import { relations, sql } from "drizzle-orm"
import {
  check,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import {
  GATEWAY_KEY_STATUSES,
  GATEWAY_PROVIDER_CREDENTIAL_KINDS,
  GATEWAY_PROVIDER_CREDENTIAL_MODES,
  GATEWAY_PROVIDER_CREDENTIAL_STATUSES,
  GATEWAY_PROVIDER_STATUSES,
} from "@openwork/types/den/gateway"
import {
  compatJsonColumn,
  denTypeIdColumn,
  encryptedMediumTextColumn,
  encryptedTextColumn,
  timestamps,
} from "../columns"
import { MemberTable, OrganizationTable } from "./org"
import { TeamTable } from "./teams"

// Gateway providers: config + credential held server-side, calls routed through
// ee/apps/gateway. Distinct from `llm_provider` (credential delivered to device).
export const GatewayProviderTable = mysqlTable(
  "gateway_providers",
  {
    id: denTypeIdColumn("inferenceProvider", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    created_by_org_membership_id: denTypeIdColumn(
      "member",
      "created_by_org_membership_id",
    ).notNull(),
    provider_id: varchar("provider_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    // Empty policy follows all supported catalog models; group membership stays explicit.
    model_ids: compatJsonColumn<string[]>("model_ids").notNull().default(sql`(JSON_ARRAY())`),
    provider_config: compatJsonColumn<Record<string, unknown>>("provider_config").notNull(),
    settings: compatJsonColumn<Record<string, unknown>>("settings").notNull(),
    // Compatibility metadata only. Credential sets own mode and OAuth config.
    credential_mode: mysqlEnum("credential_mode", GATEWAY_PROVIDER_CREDENTIAL_MODES)
      .notNull()
      .default("org"),
    oauth_client_id: varchar("oauth_client_id", { length: 255 }),
    oauth_client_secret: encryptedTextColumn("oauth_client_secret"),
    status: mysqlEnum("status", GATEWAY_PROVIDER_STATUSES).notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    index("gateway_providers_organization_id").on(table.organization_id),
    index("gateway_providers_org_provider_id").on(table.organization_id, table.provider_id),
  ],
)

export const GatewayProviderModelTable = mysqlTable(
  "gateway_provider_models",
  {
    id: denTypeIdColumn("inferenceProviderModel", "id").notNull().primaryKey(),
    gateway_provider_id: denTypeIdColumn(
      "inferenceProvider",
      "gateway_provider_id",
    ).notNull(),
    model_id: varchar("model_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    model_config: compatJsonColumn<Record<string, unknown>>("model_config").notNull(),
    created_at: timestamps.created_at,
  },
  (table) => [
    index("gateway_provider_models_model_id").on(table.model_id),
    uniqueIndex("gateway_provider_models_provider_model").on(
      table.gateway_provider_id,
      table.model_id,
    ),
  ],
)

export const GatewayKeyTable = mysqlTable(
  "gateway_keys",
  {
    id: denTypeIdColumn("gatewayKey", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
    encrypted_key: encryptedTextColumn("encrypted_key").notNull(),
    key_hash: varchar("key_hash", { length: 64 }).notNull(),
    key_prefix: varchar("key_prefix", { length: 32 }).notNull(),
    status: mysqlEnum("status", GATEWAY_KEY_STATUSES).notNull().default("active"),
    revoked_at: timestamp("revoked_at", { fsp: 3 }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("gateway_keys_org_member").on(table.organization_id, table.org_membership_id),
    uniqueIndex("gateway_keys_key_hash").on(table.key_hash),
    index("gateway_keys_org_membership_id").on(table.org_membership_id),
    index("gateway_keys_status").on(table.status),
  ],
)

export const GatewayModelGroupTable = mysqlTable(
  "gateway_model_groups",
  {
    id: denTypeIdColumn("gatewayModelGroup", "id").notNull().primaryKey(),
    gateway_provider_id: denTypeIdColumn("inferenceProvider", "gateway_provider_id").notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    status: mysqlEnum("status", GATEWAY_PROVIDER_STATUSES).notNull().default("active"),
    ...timestamps,
  },
  (table) => [index("gateway_model_groups_provider_id").on(table.gateway_provider_id)],
)

export const GatewayModelGroupModelTable = mysqlTable(
  "gateway_model_group_models",
  {
    id: denTypeIdColumn("gatewayModelGroupModel", "id").notNull().primaryKey(),
    model_group_id: denTypeIdColumn("gatewayModelGroup", "model_group_id").notNull(),
    gateway_provider_model_id: denTypeIdColumn("inferenceProviderModel", "gateway_provider_model_id").notNull(),
    created_at: timestamps.created_at,
  },
  (table) => [
    uniqueIndex("gateway_model_group_models_group_model").on(table.model_group_id, table.gateway_provider_model_id),
    index("gateway_model_group_models_model_id").on(table.gateway_provider_model_id),
  ],
)

export const GatewayCredentialSetTable = mysqlTable(
  "gateway_credential_sets",
  {
    id: denTypeIdColumn("gatewayCredentialSet", "id").notNull().primaryKey(),
    gateway_provider_id: denTypeIdColumn("inferenceProvider", "gateway_provider_id").notNull(),
    created_by_org_membership_id: denTypeIdColumn("member", "created_by_org_membership_id"),
    name: varchar("name", { length: 255 }).notNull(),
    credential_mode: mysqlEnum("credential_mode", GATEWAY_PROVIDER_CREDENTIAL_MODES).notNull(),
    oauth_client_id: varchar("oauth_client_id", { length: 255 }),
    oauth_client_secret: encryptedTextColumn("oauth_client_secret"),
    status: mysqlEnum("status", GATEWAY_PROVIDER_STATUSES).notNull().default("active"),
    ...timestamps,
  },
  (table) => [index("gateway_credential_sets_provider_id").on(table.gateway_provider_id)],
)

export const GatewayProviderCredentialTable = mysqlTable(
  "gateway_provider_credentials",
  {
    id: denTypeIdColumn("inferenceProviderCredential", "id").notNull().primaryKey(),
    gateway_provider_id: denTypeIdColumn(
      "inferenceProvider",
      "gateway_provider_id",
    ).notNull(),
    credential_set_id: denTypeIdColumn("gatewayCredentialSet", "credential_set_id").notNull(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    // "org" for the org-level credential, else the member typeid. Non-null so
    // the unique index below is a real guarantee (MySQL treats NULLs as distinct).
    subject: varchar("subject", { length: 64 }).notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id"),
    kind: mysqlEnum("kind", GATEWAY_PROVIDER_CREDENTIAL_KINDS).notNull(),
    secret: encryptedMediumTextColumn("secret").notNull(),
    expires_at: timestamp("expires_at", { fsp: 3 }),
    refreshing_until: timestamp("refreshing_until", { fsp: 3 }),
    last_refreshed_at: timestamp("last_refreshed_at", { fsp: 3 }),
    scopes: varchar("scopes", { length: 1024 }),
    last_error: text("last_error"),
    status: mysqlEnum("status", GATEWAY_PROVIDER_CREDENTIAL_STATUSES)
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("gateway_provider_credentials_set_subject").on(
      table.credential_set_id,
      table.subject,
    ),
    index("gateway_provider_credentials_provider_id").on(table.gateway_provider_id),
    index("gateway_provider_credentials_org_membership_id").on(table.org_membership_id),
    index("gateway_provider_credentials_organization_id").on(table.organization_id),
  ],
)

export const GatewayProviderAccessTable = mysqlTable(
  "gateway_provider_access",
  {
    id: denTypeIdColumn("inferenceProviderAccess", "id").notNull().primaryKey(),
    gateway_provider_id: denTypeIdColumn(
      "inferenceProvider",
      "gateway_provider_id",
    ).notNull(),
    model_group_id: denTypeIdColumn("gatewayModelGroup", "model_group_id").notNull(),
    credential_set_id: denTypeIdColumn("gatewayCredentialSet", "credential_set_id").notNull(),
    // Canonical organization | team:<id> | member:<id>, checked against the audience.
    audience_key: varchar("audience_key", { length: 80 }).notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id"),
    team_id: denTypeIdColumn("team", "team_id"),
    created_at: timestamps.created_at,
  },
  (table) => [
    index("gateway_provider_access_org_membership_id").on(table.org_membership_id),
    index("gateway_provider_access_team_id").on(table.team_id),
    index("gateway_provider_access_credential_set_id").on(table.credential_set_id),
    index("gateway_provider_access_model_group_id").on(table.model_group_id),
    uniqueIndex("gateway_provider_access_audience_group_set").on(
      table.gateway_provider_id,
      table.audience_key,
      table.model_group_id,
      table.credential_set_id,
    ),
    check("gateway_provider_access_audience", sql`
      (${table.org_membership_id} IS NULL OR ${table.team_id} IS NULL)
      AND ${table.audience_key} = CASE
        WHEN ${table.org_membership_id} IS NOT NULL THEN CONCAT('member:', ${table.org_membership_id})
        WHEN ${table.team_id} IS NOT NULL THEN CONCAT('team:', ${table.team_id})
        ELSE 'organization' END
    `),
  ],
)

export const GatewayProviderOauthStateTable = mysqlTable(
  "gateway_provider_oauth_states",
  {
    id: denTypeIdColumn("inferenceProviderOauthState", "id").notNull().primaryKey(),
    gateway_provider_id: denTypeIdColumn(
      "inferenceProvider",
      "gateway_provider_id",
    ).notNull(),
    credential_set_id: denTypeIdColumn("gatewayCredentialSet", "credential_set_id").notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
    state: varchar("state", { length: 255 }).notNull(),
    code_verifier: encryptedTextColumn("code_verifier").notNull(),
    redirect_to: varchar("redirect_to", { length: 2048 }),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    used_at: timestamp("used_at", { fsp: 3 }),
    created_at: timestamps.created_at,
  },
  (table) => [
    uniqueIndex("gateway_provider_oauth_states_state").on(table.state),
    index("gateway_provider_oauth_states_expires_at").on(table.expires_at),
    index("gateway_provider_oauth_states_set_member").on(table.credential_set_id, table.org_membership_id),
  ],
)

export const gatewayProviderRelations = relations(GatewayProviderTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [GatewayProviderTable.organization_id],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [GatewayProviderTable.created_by_org_membership_id],
    references: [MemberTable.id],
  }),
  models: many(GatewayProviderModelTable),
  modelGroups: many(GatewayModelGroupTable),
  credentialSets: many(GatewayCredentialSetTable),
  credentials: many(GatewayProviderCredentialTable),
  accessGrants: many(GatewayProviderAccessTable),
  oauthStates: many(GatewayProviderOauthStateTable),
}))

export const gatewayProviderModelRelations = relations(
  GatewayProviderModelTable,
  ({ one, many }) => ({
    gatewayProvider: one(GatewayProviderTable, {
      fields: [GatewayProviderModelTable.gateway_provider_id],
      references: [GatewayProviderTable.id],
    }),
    groupModels: many(GatewayModelGroupModelTable),
  }),
)

export const gatewayProviderCredentialRelations = relations(
  GatewayProviderCredentialTable,
  ({ one }) => ({
    gatewayProvider: one(GatewayProviderTable, {
      fields: [GatewayProviderCredentialTable.gateway_provider_id],
      references: [GatewayProviderTable.id],
    }),
    credentialSet: one(GatewayCredentialSetTable, {
      fields: [GatewayProviderCredentialTable.credential_set_id],
      references: [GatewayCredentialSetTable.id],
    }),
    organization: one(OrganizationTable, {
      fields: [GatewayProviderCredentialTable.organization_id],
      references: [OrganizationTable.id],
    }),
    orgMembership: one(MemberTable, {
      fields: [GatewayProviderCredentialTable.org_membership_id],
      references: [MemberTable.id],
    }),
  }),
)

export const gatewayProviderAccessRelations = relations(
  GatewayProviderAccessTable,
  ({ one }) => ({
    gatewayProvider: one(GatewayProviderTable, {
      fields: [GatewayProviderAccessTable.gateway_provider_id],
      references: [GatewayProviderTable.id],
    }),
    modelGroup: one(GatewayModelGroupTable, {
      fields: [GatewayProviderAccessTable.model_group_id],
      references: [GatewayModelGroupTable.id],
    }),
    credentialSet: one(GatewayCredentialSetTable, {
      fields: [GatewayProviderAccessTable.credential_set_id],
      references: [GatewayCredentialSetTable.id],
    }),
    orgMembership: one(MemberTable, {
      fields: [GatewayProviderAccessTable.org_membership_id],
      references: [MemberTable.id],
    }),
    team: one(TeamTable, {
      fields: [GatewayProviderAccessTable.team_id],
      references: [TeamTable.id],
    }),
  }),
)

export const gatewayProviderOauthStateRelations = relations(
  GatewayProviderOauthStateTable,
  ({ one }) => ({
    gatewayProvider: one(GatewayProviderTable, {
      fields: [GatewayProviderOauthStateTable.gateway_provider_id],
      references: [GatewayProviderTable.id],
    }),
    credentialSet: one(GatewayCredentialSetTable, {
      fields: [GatewayProviderOauthStateTable.credential_set_id],
      references: [GatewayCredentialSetTable.id],
    }),
    orgMembership: one(MemberTable, {
      fields: [GatewayProviderOauthStateTable.org_membership_id],
      references: [MemberTable.id],
    }),
  }),
)

export const gatewayKeyRelations = relations(GatewayKeyTable, ({ one }) => ({
  organization: one(OrganizationTable, {
    fields: [GatewayKeyTable.organization_id],
    references: [OrganizationTable.id],
  }),
  orgMembership: one(MemberTable, {
    fields: [GatewayKeyTable.org_membership_id],
    references: [MemberTable.id],
  }),
}))

export const gatewayModelGroupRelations = relations(GatewayModelGroupTable, ({ one, many }) => ({
  gatewayProvider: one(GatewayProviderTable, {
    fields: [GatewayModelGroupTable.gateway_provider_id],
    references: [GatewayProviderTable.id],
  }),
  groupModels: many(GatewayModelGroupModelTable),
  accessGrants: many(GatewayProviderAccessTable),
}))

export const gatewayModelGroupModelRelations = relations(GatewayModelGroupModelTable, ({ one }) => ({
  modelGroup: one(GatewayModelGroupTable, {
    fields: [GatewayModelGroupModelTable.model_group_id],
    references: [GatewayModelGroupTable.id],
  }),
  gatewayProviderModel: one(GatewayProviderModelTable, {
    fields: [GatewayModelGroupModelTable.gateway_provider_model_id],
    references: [GatewayProviderModelTable.id],
  }),
}))

export const gatewayCredentialSetRelations = relations(GatewayCredentialSetTable, ({ one, many }) => ({
  gatewayProvider: one(GatewayProviderTable, {
    fields: [GatewayCredentialSetTable.gateway_provider_id],
    references: [GatewayProviderTable.id],
  }),
  credentials: many(GatewayProviderCredentialTable),
  accessGrants: many(GatewayProviderAccessTable),
  oauthStates: many(GatewayProviderOauthStateTable),
}))

export const gatewayProvider = GatewayProviderTable
export const gatewayProviderModel = GatewayProviderModelTable
export const gatewayKey = GatewayKeyTable
export const gatewayModelGroup = GatewayModelGroupTable
export const gatewayModelGroupModel = GatewayModelGroupModelTable
export const gatewayCredentialSet = GatewayCredentialSetTable
export const gatewayProviderCredential = GatewayProviderCredentialTable
export const gatewayProviderAccess = GatewayProviderAccessTable
export const gatewayProviderOauthState = GatewayProviderOauthStateTable

// Temporary source aliases, not parallel tables or legacy column mappings.
export {
  GatewayProviderTable as InferenceProviderTable,
  GatewayProviderModelTable as InferenceProviderModelTable,
  GatewayProviderCredentialTable as InferenceProviderCredentialTable,
  GatewayProviderAccessTable as InferenceProviderAccessTable,
  GatewayProviderOauthStateTable as InferenceProviderOauthStateTable,
  gatewayProvider as inferenceProvider,
  gatewayProviderModel as inferenceProviderModel,
  gatewayProviderCredential as inferenceProviderCredential,
  gatewayProviderAccess as inferenceProviderAccess,
  gatewayProviderOauthState as inferenceProviderOauthState,
}
