import { MCP_REGISTRATION_OUTCOMES, MCP_REGISTRATION_SOURCES, MCP_REGISTRATION_STATUSES } from "@openwork/types/den/mcp-registration"
import { boolean, index, int, mysqlEnum, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * Whether each MCP OAuth authorization server lets OpenWork sign people in without an admin-created OAuth app, keyed
 * by issuer. Deployment-wide (not per organization): it describes the provider, learned from members' real sign-ins
 * and from the scheduled preset check. Holds no credentials or client secrets.
 */
export const McpRegistrationStatusTable = mysqlTable("mcp_registration_status", {
  id: denTypeIdColumn("mcpRegistrationStatus", "id").notNull().primaryKey(),
  /** Authorization server issuer, e.g. https://api.figma.com. */
  issuer: varchar("issuer", { length: 512 }).notNull(),
  /** A preset this issuer serves, when one is known. */
  presetId: varchar("preset_id", { length: 64 }),
  /** One MCP server URL seen with this issuer, for people reading reports. */
  serverUrl: varchar("server_url", { length: 2048 }),
  status: mysqlEnum("status", MCP_REGISTRATION_STATUSES).notNull().default("unknown"),
  clientMetadataSupported: boolean("client_metadata_supported"),
  dynamicRegistrationSupported: boolean("dynamic_registration_supported"),
  /** Origin and path of the registration endpoint (no query), when advertised. */
  registrationEndpoint: varchar("registration_endpoint", { length: 2048 }),
  lastSource: mysqlEnum("last_source", MCP_REGISTRATION_SOURCES),
  lastHttpStatus: int("last_http_status"),
  lastDiagnosticCode: varchar("last_diagnostic_code", { length: 96 }),
  /** Den request id of the last observation, to find it in logs. */
  lastReference: varchar("last_reference", { length: 96 }),
  acceptedCount: int("accepted_count").notNull().default(0),
  refusedCount: int("refused_count").notNull().default(0),
  lastAcceptedAt: timestamp("last_accepted_at", { fsp: 3 }),
  lastRefusedAt: timestamp("last_refused_at", { fsp: 3 }),
  lastObservedAt: timestamp("last_observed_at", { fsp: 3 }),
  lastProbedAt: timestamp("last_probed_at", { fsp: 3 }),
  /** Claimed by the replica running the scheduled check, so only one probes an issuer at a time. */
  probeLeaseUntil: timestamp("probe_lease_until", { fsp: 3 }),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
}, table => [
  uniqueIndex("mcp_registration_status_issuer").on(table.issuer),
  index("mcp_registration_status_status").on(table.status),
])

/** Every observation, append-only, for reports (who hit a refusal, when, and how often). */
export const McpRegistrationEventTable = mysqlTable("mcp_registration_event", {
  id: denTypeIdColumn("mcpRegistrationEvent", "id").notNull().primaryKey(),
  issuer: varchar("issuer", { length: 512 }).notNull(),
  presetId: varchar("preset_id", { length: 64 }),
  source: mysqlEnum("source", MCP_REGISTRATION_SOURCES).notNull(),
  outcome: mysqlEnum("outcome", MCP_REGISTRATION_OUTCOMES).notNull(),
  /** Null for the scheduled check. */
  organizationId: denTypeIdColumn("organization", "organization_id"),
  connectionId: varchar("connection_id", { length: 64 }),
  httpStatus: int("http_status"),
  diagnosticCode: varchar("diagnostic_code", { length: 96 }),
  reference: varchar("reference", { length: 96 }),
  createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
}, table => [
  index("mcp_registration_event_issuer_created").on(table.issuer, table.createdAt),
  index("mcp_registration_event_created").on(table.createdAt),
])
