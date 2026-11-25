import { index, json, mysqlEnum, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import type { ManagedInstallerCoordinates, ManagedInstallerQualification, ManagedInstallerValidation } from "@openwork/types/den/managed-installer-releases"

/** Global, platform-admin settings. Null release explicitly inherits the environment. */
export const ManagedInstallerConfigTable = mysqlTable("managed_installer_config", {
  provider: mysqlEnum("provider", ["aws", "gcp"]).primaryKey().notNull(),
  source_base_url: varchar("source_base_url", { length: 2048 }),
  approval_mode: mysqlEnum("approval_mode", ["platform_admin", "independent_admin"]).notNull().default("independent_admin"),
  release: json("release").$type<ManagedInstallerCoordinates>(),
  revision: varchar("revision", { length: 36 }).notNull(),
  updated_at: timestamp("updated_at", { fsp: 3 }).notNull(),
})

export const ManagedInstallerValidationTable = mysqlTable("managed_installer_validation", {
  id: varchar("id", { length: 36 }).primaryKey().notNull(),
  provider: mysqlEnum("provider", ["aws", "gcp"]).notNull(),
  revision: varchar("revision", { length: 64 }).notNull(),
  validation: json("validation").$type<Omit<ManagedInstallerValidation, "verifiedBy" | "canPin">>().notNull(),
  manifest_url: varchar("manifest_url", { length: 2048 }).notNull(),
  template_sha256: varchar("template_sha256", { length: 64 }).notNull(),
  actor: varchar("actor", { length: 128 }).notNull(),
  expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
}, (table) => [index("managed_installer_validation_expiry").on(table.expires_at)])

/** Append-only canonical change evidence, committed with the setting it describes. */
export const ManagedInstallerChangeTable = mysqlTable("managed_installer_change", {
  id: varchar("id", { length: 36 }).primaryKey().notNull(),
  provider: mysqlEnum("provider", ["aws", "gcp"]).notNull(),
  action: mysqlEnum("action", ["source_saved", "approval_saved", "pinned", "reset"]).notNull(),
  actor: varchar("actor", { length: 128 }).notNull(),
  version: varchar("version", { length: 80 }),
  manifest_sha256: varchar("manifest_sha256", { length: 64 }),
  qualification: json("qualification").$type<ManagedInstallerQualification>(),
  before: json("before").$type<Record<string, unknown>>().notNull(),
  after: json("after").$type<Record<string, unknown>>().notNull(),
  created_at: timestamp("created_at", { fsp: 3 }).notNull(),
}, (table) => [index("managed_installer_change_created").on(table.created_at)])
