import { index, int, mysqlEnum, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core"
import { compatJsonColumn, denTypeIdColumn, encryptedColumn, encryptedMediumTextColumn, timestamps } from "../columns"

const encryptedJsonColumn = <TData>(name: string) => encryptedColumn<TData>(name, {
  dataType: "mediumtext",
  serialize: JSON.stringify,
  deserialize: JSON.parse,
})

export type ArtifactViewBuildDiagnostic = {
  level: "error" | "warning"
  message: string
  line: number | null
  column: number | null
}

export type ArtifactViewCsp = {
  connectDomains: string[]
  resourceDomains: string[]
  frameDomains: string[]
  baseUriDomains: string[]
}

export const ArtifactViewTable = mysqlTable(
  "artifact_view",
  {
    id: denTypeIdColumn("artifactView", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    config_object_id: denTypeIdColumn("configObject", "config_object_id").notNull(),
    owner_member_id: denTypeIdColumn("member", "owner_member_id").notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    description: varchar("description", { length: 2_000 }),
    status: mysqlEnum("status", ["active", "retired"]).notNull().default("active"),
    active_revision_id: denTypeIdColumn("artifactViewRevision", "active_revision_id"),
    ...timestamps,
  },
  (table) => [
    index("artifact_view_org_script").on(table.organization_id, table.config_object_id),
    index("artifact_view_org_owner").on(table.organization_id, table.owner_member_id),
    index("artifact_view_active_revision").on(table.active_revision_id),
  ],
)

export const ArtifactViewRevisionTable = mysqlTable(
  "artifact_view_revision",
  {
    id: denTypeIdColumn("artifactViewRevision", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    artifact_view_id: denTypeIdColumn("artifactView", "artifact_view_id").notNull(),
    created_by_member_id: denTypeIdColumn("member", "created_by_member_id").notNull(),
    react_source: encryptedMediumTextColumn("react_source").notNull(),
    css_source: encryptedMediumTextColumn("css_source").notNull(),
    compiled_html: encryptedMediumTextColumn("compiled_html"),
    build_diagnostics: encryptedJsonColumn<ArtifactViewBuildDiagnostic[]>("build_diagnostics").notNull(),
    build_status: mysqlEnum("build_status", ["ready", "failed"]).notNull(),
    source_digest: varchar("source_digest", { length: 71 }).notNull(),
    resource_digest: varchar("resource_digest", { length: 71 }),
    output_schema_digest: varchar("output_schema_digest", { length: 71 }).notNull(),
    output_schema: encryptedJsonColumn<unknown>("output_schema").notNull(),
    csp: compatJsonColumn<ArtifactViewCsp>("csp").notNull(),
    compiler_name: varchar("compiler_name", { length: 80 }).notNull(),
    compiler_version: varchar("compiler_version", { length: 40 }).notNull(),
    react_version: varchar("react_version", { length: 40 }).notNull(),
    compiled_html_bytes: int("compiled_html_bytes", { unsigned: true }),
    retired_at: timestamp("retired_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("artifact_view_revision_view_created").on(table.artifact_view_id, table.created_at),
    index("artifact_view_revision_org_status").on(table.organization_id, table.build_status),
  ],
)
