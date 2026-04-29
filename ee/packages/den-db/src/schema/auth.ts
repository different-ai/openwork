import * as crypto from "node:crypto"
import { sql } from "drizzle-orm"
import { bigint, boolean, index, int, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

export const AuthUserTable = mysqlTable(
  "user",
  {
    id: denTypeIdColumn("user", "id").notNull().primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [uniqueIndex("user_email").on(table.email)],
)

export const AuthSessionTable = mysqlTable(
  "session",
  {
    id: denTypeIdColumn("session", "id").notNull().primaryKey(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    activeOrganizationId: denTypeIdColumn("organization", "active_organization_id"),
    activeTeamId: denTypeIdColumn("team", "active_team_id"),
    token: varchar("token", { length: 255 }).notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [uniqueIndex("session_token").on(table.token), index("session_user_id").on(table.userId)],
)

export const AuthAccountTable = mysqlTable(
  "account",
  {
    id: denTypeIdColumn("account", "id").notNull().primaryKey(),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { fsp: 3 }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { fsp: 3 }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [index("account_user_id").on(table.userId)],
)

export const AuthVerificationTable = mysqlTable(
  "verification",
  {
    id: denTypeIdColumn("verification", "id").notNull().primaryKey(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [index("verification_identifier").on(table.identifier)],
)

export const AuthApiKeyTable = mysqlTable(
  "apikey",
  {
    id: varchar("id", { length: 64 }).notNull().primaryKey(),
    configId: varchar("config_id", { length: 255 }).notNull().default("default"),
    name: varchar("name", { length: 255 }),
    start: varchar("start", { length: 32 }),
    prefix: varchar("prefix", { length: 255 }),
    key: varchar("key", { length: 255 }).notNull(),
    referenceId: varchar("reference_id", { length: 64 }).notNull(),
    refillInterval: bigint("refill_interval", { mode: "number" }),
    refillAmount: int("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { fsp: 3 }),
    enabled: boolean("enabled").notNull().default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(true),
    rateLimitTimeWindow: bigint("rate_limit_time_window", { mode: "number" }),
    rateLimitMax: int("rate_limit_max"),
    requestCount: int("request_count").default(0),
    remaining: int("remaining"),
    lastRequest: timestamp("last_request", { fsp: 3 }),
    expiresAt: timestamp("expires_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (table) => [
    index("apikey_config_id").on(table.configId),
    index("apikey_reference_id").on(table.referenceId),
    index("apikey_key").on(table.key),
  ],
)

export const AuthJwksTable = mysqlTable("jwks", {
  id: varchar("id", { length: 64 })
    .notNull()
    .$defaultFn(() => crypto.randomUUID())
    .primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { fsp: 3 }),
  alg: varchar("alg", { length: 32 }),
  crv: varchar("crv", { length: 32 }),
})

export const OAuthClientTable = mysqlTable(
  "oauthClient",
  {
    id: denTypeIdColumn("oauthClient", "id").notNull().primaryKey(),
    clientId: varchar("client_id", { length: 255 }).notNull(),
    clientSecret: text("client_secret"),
    disabled: boolean("disabled").default(false),
    skipConsent: boolean("skip_consent"),
    enableEndSession: boolean("enable_end_session"),
    subjectType: varchar("subject_type", { length: 64 }),
    scopes: text("scopes"),
    userId: denTypeIdColumn("user", "user_id"),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
    name: varchar("name", { length: 255 }),
    uri: text("uri"),
    icon: text("icon"),
    contacts: text("contacts"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: varchar("software_id", { length: 255 }),
    softwareVersion: varchar("software_version", { length: 255 }),
    softwareStatement: text("software_statement"),
    redirectUris: text("redirect_uris").notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris"),
    tokenEndpointAuthMethod: varchar("token_endpoint_auth_method", { length: 128 }),
    grantTypes: text("grant_types"),
    responseTypes: text("response_types"),
    public: boolean("public"),
    type: varchar("type", { length: 64 }),
    requirePKCE: boolean("require_pkce"),
    referenceId: varchar("reference_id", { length: 64 }),
    metadata: text("metadata"),
  },
  (table) => [
    uniqueIndex("oauth_client_client_id").on(table.clientId),
    index("oauth_client_user_id").on(table.userId),
    index("oauth_client_reference_id").on(table.referenceId),
  ],
)

export const OAuthRefreshTokenTable = mysqlTable(
  "oauthRefreshToken",
  {
    id: denTypeIdColumn("oauthRefreshToken", "id").notNull().primaryKey(),
    token: text("token").notNull(),
    clientId: varchar("client_id", { length: 255 }).notNull(),
    sessionId: denTypeIdColumn("session", "session_id"),
    userId: denTypeIdColumn("user", "user_id").notNull(),
    referenceId: varchar("reference_id", { length: 64 }),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    revoked: timestamp("revoked", { fsp: 3 }),
    authTime: timestamp("auth_time", { fsp: 3 }),
    scopes: text("scopes").notNull(),
  },
  (table) => [
    index("oauth_refresh_token_client_id").on(table.clientId),
    index("oauth_refresh_token_session_id").on(table.sessionId),
    index("oauth_refresh_token_user_id").on(table.userId),
    index("oauth_refresh_token_reference_id").on(table.referenceId),
  ],
)

export const OAuthAccessTokenTable = mysqlTable(
  "oauthAccessToken",
  {
    id: denTypeIdColumn("oauthAccessToken", "id").notNull().primaryKey(),
    token: text("token").notNull(),
    clientId: varchar("client_id", { length: 255 }).notNull(),
    sessionId: denTypeIdColumn("session", "session_id"),
    userId: denTypeIdColumn("user", "user_id"),
    referenceId: varchar("reference_id", { length: 64 }),
    refreshId: denTypeIdColumn("oauthRefreshToken", "refresh_id"),
    expiresAt: timestamp("expires_at", { fsp: 3 }).notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    scopes: text("scopes").notNull(),
  },
  (table) => [
    index("oauth_access_token_client_id").on(table.clientId),
    index("oauth_access_token_session_id").on(table.sessionId),
    index("oauth_access_token_user_id").on(table.userId),
    index("oauth_access_token_reference_id").on(table.referenceId),
    index("oauth_access_token_refresh_id").on(table.refreshId),
  ],
)

export const OAuthConsentTable = mysqlTable(
  "oauthConsent",
  {
    id: denTypeIdColumn("oauthConsent", "id").notNull().primaryKey(),
    clientId: varchar("client_id", { length: 255 }).notNull(),
    userId: denTypeIdColumn("user", "user_id"),
    referenceId: varchar("reference_id", { length: 64 }),
    scopes: text("scopes").notNull(),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    index("oauth_consent_client_id").on(table.clientId),
    index("oauth_consent_user_id").on(table.userId),
    index("oauth_consent_reference_id").on(table.referenceId),
  ],
)

export const user = AuthUserTable
export const session = AuthSessionTable
export const account = AuthAccountTable
export const verification = AuthVerificationTable
export const apikey = AuthApiKeyTable
export const jwks = AuthJwksTable
export const oauthClient = OAuthClientTable
export const oauthRefreshToken = OAuthRefreshTokenTable
export const oauthAccessToken = OAuthAccessTokenTable
export const oauthConsent = OAuthConsentTable
