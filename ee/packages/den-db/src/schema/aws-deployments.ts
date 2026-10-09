import { index, int, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, timestamps } from "../columns"

export const AwsDeploymentTable = mysqlTable("aws_deployment", {
  id: varchar("id", { length: 36 }).notNull().primaryKey(),
  org_id: denTypeIdColumn("org", "org_id").notNull(),
  name: varchar("name", { length: 80 }).notNull(),
  account_id: varchar("account_id", { length: 12 }).notNull(),
  region: varchar("region", { length: 32 }).notNull(),
  domain_name: varchar("domain_name", { length: 253 }).notNull(),
  route53_zone_id: varchar("route53_zone_id", { length: 32 }).notNull(),
  owner_email: varchar("owner_email", { length: 254 }).notNull(),
  active_run_id: varchar("active_run_id", { length: 36 }),
  ...timestamps,
}, (table) => [index("aws_deployment_org").on(table.org_id)])

export const AwsDeploymentRunTable = mysqlTable("aws_deployment_run", {
  id: varchar("id", { length: 36 }).notNull().primaryKey(),
  deployment_id: varchar("deployment_id", { length: 36 }).notNull(),
  version: varchar("version", { length: 80 }).notNull(),
  template_url: varchar("template_url", { length: 2048 }).notNull(),
  bundle_url: varchar("bundle_url", { length: 2048 }).notNull(),
  bundle_sha256: varchar("bundle_sha256", { length: 64 }).notNull(),
  api_origin: varchar("api_origin", { length: 512 }).notNull(),
  challenge: varchar("challenge", { length: 64 }).notNull(),
  state: mysqlEnum("state", ["awaiting_aws", "provisioning", "ready", "failed"]).notNull(),
  token_hash: varchar("token_hash", { length: 64 }),
  last_sequence: int("last_sequence").notNull().default(0),
  last_seen_at: timestamp("last_seen_at", { fsp: 3 }),
  expires_at: timestamp("expires_at", { fsp: 3 }).notNull(),
  ...timestamps,
}, (table) => [index("aws_deployment_run_deployment").on(table.deployment_id)])

export const AwsDeploymentEventTable = mysqlTable("aws_deployment_event", {
  id: varchar("id", { length: 36 }).notNull().primaryKey(),
  run_id: varchar("run_id", { length: 36 }).notNull(),
  sequence: int("sequence").notNull(),
  step: varchar("step", { length: 40 }).notNull(),
  outcome: mysqlEnum("outcome", ["succeeded", "failed"]).notNull(),
  error_code: varchar("error_code", { length: 64 }),
  received_at: timestamp("received_at", { fsp: 3 }).notNull(),
}, (table) => [uniqueIndex("aws_deployment_event_run_sequence").on(table.run_id, table.sequence)])
