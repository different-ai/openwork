import { index, int, json, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, timestamps } from "../columns"

/**
 * An OpenWork installation in a customer's own cloud account. Provider-neutral:
 * cloud-specific target fields (AWS account, Azure subscription, GCP project)
 * live in `target`, validated by @openwork/managed-deployments on every read.
 */
export const ManagedDeploymentTable = mysqlTable("managed_deployment", {
  id: varchar("id", { length: 36 }).notNull().primaryKey(),
  org_id: denTypeIdColumn("org", "org_id").notNull(),
  provider: mysqlEnum("provider", ["aws", "azure", "gcp"]).notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  target: json("target").$type<Record<string, unknown>>().notNull(),
  domain_name: varchar("domain_name", { length: 253 }).notNull(),
  owner_email: varchar("owner_email", { length: 254 }).notNull(),
  size: varchar("size", { length: 20 }).notNull(),
  active_run_id: varchar("active_run_id", { length: 36 }),
  installed_version: varchar("installed_version", { length: 80 }),
  ...timestamps,
}, (table) => [index("managed_deployment_org").on(table.org_id)])

/** One installer execution: initial install, retry, or approved update. */
export const ManagedDeploymentRunTable = mysqlTable("managed_deployment_run", {
  id: varchar("id", { length: 36 }).notNull().primaryKey(),
  deployment_id: varchar("deployment_id", { length: 36 }).notNull(),
  kind: mysqlEnum("kind", ["install", "update", "retry"]).notNull(),
  version: varchar("version", { length: 80 }).notNull(),
  // The exact release approved for this run, frozen when it was prepared.
  template_url: varchar("template_url", { length: 2048 }).notNull(),
  bundle_url: varchar("bundle_url", { length: 2048 }).notNull(),
  bundle_sha256: varchar("bundle_sha256", { length: 64 }).notNull(),
  api_origin: varchar("api_origin", { length: 512 }).notNull(),
  challenge: varchar("challenge", { length: 64 }).notNull(),
  state: mysqlEnum("state", ["awaiting_approval", "provisioning", "ready", "failed"]).notNull(),
  token_hash: varchar("token_hash", { length: 64 }),
  last_sequence: int("last_sequence").notNull().default(0),
  last_seen_at: timestamp("last_seen_at", { fsp: 3 }),
  expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
  ...timestamps,
}, (table) => [index("managed_deployment_run_deployment").on(table.deployment_id)])

export const ManagedDeploymentEventTable = mysqlTable("managed_deployment_event", {
  id: varchar("id", { length: 36 }).notNull().primaryKey(),
  run_id: varchar("run_id", { length: 36 }).notNull(),
  sequence: int("sequence").notNull(),
  step: varchar("step", { length: 40 }).notNull(),
  outcome: mysqlEnum("outcome", ["succeeded", "failed"]).notNull(),
  error_code: varchar("error_code", { length: 64 }),
  received_at: timestamp("received_at", { fsp: 3 }).notNull(),
}, (table) => [uniqueIndex("managed_deployment_event_run_sequence").on(table.run_id, table.sequence)])

/** Latest health report from the installation's own health agent. */
export const ManagedDeploymentHealthTable = mysqlTable("managed_deployment_health", {
  deployment_id: varchar("deployment_id", { length: 36 }).notNull().primaryKey(),
  version: varchar("version", { length: 80 }),
  checks: json("checks").$type<Record<string, unknown>[]>().notNull(),
  reported_at: timestamp("reported_at", { fsp: 3 }).notNull(),
  // Signature time of the accepted report; later reports must be newer.
  signed_at: timestamp("signed_at", { fsp: 3 }).notNull(),
})
