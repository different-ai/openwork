import { relations } from "drizzle-orm"
import {
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core"
import {
  INFERENCE_PROVIDER_CREDENTIAL_KINDS,
  INFERENCE_PROVIDER_CREDENTIAL_MODES,
  INFERENCE_PROVIDER_CREDENTIAL_STATUSES,
  INFERENCE_PROVIDER_STATUSES,
} from "@openwork/types/den/inference"
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
// ee/apps/inference. Distinct from `llm_provider` (credential delivered to device).
export const InferenceProviderTable = mysqlTable(
  "inference_providers",
  {
    id: denTypeIdColumn("inferenceProvider", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    created_by_org_membership_id: denTypeIdColumn(
      "member",
      "created_by_org_membership_id",
    ).notNull(),
    provider_id: varchar("provider_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    provider_config: compatJsonColumn<Record<string, unknown>>("provider_config").notNull(),
    settings: compatJsonColumn<Record<string, unknown>>("settings").notNull(),
    credential_mode: mysqlEnum("credential_mode", INFERENCE_PROVIDER_CREDENTIAL_MODES)
      .notNull()
      .default("org"),
    oauth_client_id: varchar("oauth_client_id", { length: 255 }),
    oauth_client_secret: encryptedTextColumn("oauth_client_secret"),
    status: mysqlEnum("status", INFERENCE_PROVIDER_STATUSES).notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    index("inference_providers_organization_id").on(table.organization_id),
    index("inference_providers_org_provider_id").on(table.organization_id, table.provider_id),
  ],
)

export const InferenceProviderModelTable = mysqlTable(
  "inference_provider_models",
  {
    id: denTypeIdColumn("inferenceProviderModel", "id").notNull().primaryKey(),
    inference_provider_id: denTypeIdColumn(
      "inferenceProvider",
      "inference_provider_id",
    ).notNull(),
    model_id: varchar("model_id", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    model_config: compatJsonColumn<Record<string, unknown>>("model_config").notNull(),
    created_at: timestamps.created_at,
  },
  (table) => [
    index("inference_provider_models_model_id").on(table.model_id),
    uniqueIndex("inference_provider_models_provider_model").on(
      table.inference_provider_id,
      table.model_id,
    ),
  ],
)

export const InferenceProviderCredentialTable = mysqlTable(
  "inference_provider_credentials",
  {
    id: denTypeIdColumn("inferenceProviderCredential", "id").notNull().primaryKey(),
    inference_provider_id: denTypeIdColumn(
      "inferenceProvider",
      "inference_provider_id",
    ).notNull(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    // "org" for the org-level credential, else the member typeid. Non-null so
    // the unique index below is a real guarantee (MySQL treats NULLs as distinct).
    subject: varchar("subject", { length: 64 }).notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id"),
    kind: mysqlEnum("kind", INFERENCE_PROVIDER_CREDENTIAL_KINDS).notNull(),
    secret: encryptedMediumTextColumn("secret").notNull(),
    expires_at: timestamp("expires_at", { fsp: 3 }),
    refreshing_until: timestamp("refreshing_until", { fsp: 3 }),
    last_refreshed_at: timestamp("last_refreshed_at", { fsp: 3 }),
    scopes: varchar("scopes", { length: 1024 }),
    last_error: text("last_error"),
    status: mysqlEnum("status", INFERENCE_PROVIDER_CREDENTIAL_STATUSES)
      .notNull()
      .default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("inference_provider_credentials_provider_subject").on(
      table.inference_provider_id,
      table.subject,
    ),
    index("inference_provider_credentials_org_membership_id").on(table.org_membership_id),
    index("inference_provider_credentials_organization_id").on(table.organization_id),
  ],
)

export const InferenceProviderAccessTable = mysqlTable(
  "inference_provider_access",
  {
    id: denTypeIdColumn("inferenceProviderAccess", "id").notNull().primaryKey(),
    inference_provider_id: denTypeIdColumn(
      "inferenceProvider",
      "inference_provider_id",
    ).notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id"),
    team_id: denTypeIdColumn("team", "team_id"),
    created_at: timestamps.created_at,
  },
  (table) => [
    index("inference_provider_access_org_membership_id").on(table.org_membership_id),
    index("inference_provider_access_team_id").on(table.team_id),
    uniqueIndex("inference_provider_access_provider_org_membership").on(
      table.inference_provider_id,
      table.org_membership_id,
    ),
    uniqueIndex("inference_provider_access_provider_team").on(
      table.inference_provider_id,
      table.team_id,
    ),
  ],
)

export const InferenceProviderOauthStateTable = mysqlTable(
  "inference_provider_oauth_states",
  {
    id: denTypeIdColumn("inferenceProviderOauthState", "id").notNull().primaryKey(),
    inference_provider_id: denTypeIdColumn(
      "inferenceProvider",
      "inference_provider_id",
    ).notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id").notNull(),
    state: varchar("state", { length: 255 }).notNull(),
    code_verifier: encryptedTextColumn("code_verifier").notNull(),
    redirect_to: varchar("redirect_to", { length: 2048 }),
    expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
    used_at: timestamp("used_at", { fsp: 3 }),
    created_at: timestamps.created_at,
  },
  (table) => [
    uniqueIndex("inference_provider_oauth_states_state").on(table.state),
    index("inference_provider_oauth_states_expires_at").on(table.expires_at),
  ],
)

export const inferenceProviderRelations = relations(InferenceProviderTable, ({ many, one }) => ({
  organization: one(OrganizationTable, {
    fields: [InferenceProviderTable.organization_id],
    references: [OrganizationTable.id],
  }),
  createdByOrgMembership: one(MemberTable, {
    fields: [InferenceProviderTable.created_by_org_membership_id],
    references: [MemberTable.id],
  }),
  models: many(InferenceProviderModelTable),
  credentials: many(InferenceProviderCredentialTable),
  accessLinks: many(InferenceProviderAccessTable),
  oauthStates: many(InferenceProviderOauthStateTable),
}))

export const inferenceProviderModelRelations = relations(
  InferenceProviderModelTable,
  ({ one }) => ({
    inferenceProvider: one(InferenceProviderTable, {
      fields: [InferenceProviderModelTable.inference_provider_id],
      references: [InferenceProviderTable.id],
    }),
  }),
)

export const inferenceProviderCredentialRelations = relations(
  InferenceProviderCredentialTable,
  ({ one }) => ({
    inferenceProvider: one(InferenceProviderTable, {
      fields: [InferenceProviderCredentialTable.inference_provider_id],
      references: [InferenceProviderTable.id],
    }),
    organization: one(OrganizationTable, {
      fields: [InferenceProviderCredentialTable.organization_id],
      references: [OrganizationTable.id],
    }),
    orgMembership: one(MemberTable, {
      fields: [InferenceProviderCredentialTable.org_membership_id],
      references: [MemberTable.id],
    }),
  }),
)

export const inferenceProviderAccessRelations = relations(
  InferenceProviderAccessTable,
  ({ one }) => ({
    inferenceProvider: one(InferenceProviderTable, {
      fields: [InferenceProviderAccessTable.inference_provider_id],
      references: [InferenceProviderTable.id],
    }),
    orgMembership: one(MemberTable, {
      fields: [InferenceProviderAccessTable.org_membership_id],
      references: [MemberTable.id],
    }),
    team: one(TeamTable, {
      fields: [InferenceProviderAccessTable.team_id],
      references: [TeamTable.id],
    }),
  }),
)

export const inferenceProviderOauthStateRelations = relations(
  InferenceProviderOauthStateTable,
  ({ one }) => ({
    inferenceProvider: one(InferenceProviderTable, {
      fields: [InferenceProviderOauthStateTable.inference_provider_id],
      references: [InferenceProviderTable.id],
    }),
    orgMembership: one(MemberTable, {
      fields: [InferenceProviderOauthStateTable.org_membership_id],
      references: [MemberTable.id],
    }),
  }),
)

export const inferenceProvider = InferenceProviderTable
export const inferenceProviderModel = InferenceProviderModelTable
export const inferenceProviderCredential = InferenceProviderCredentialTable
export const inferenceProviderAccess = InferenceProviderAccessTable
export const inferenceProviderOauthState = InferenceProviderOauthStateTable
