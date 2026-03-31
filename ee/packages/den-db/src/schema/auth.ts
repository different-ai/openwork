import { sql } from "drizzle-orm"
import { boolean, index, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
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

export const user = AuthUserTable
export const session = AuthSessionTable
export const account = AuthAccountTable
export const verification = AuthVerificationTable
