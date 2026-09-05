import { index, int, json, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn, encryptedColumn, encryptedMediumTextColumn } from "../columns"

const encryptedJsonColumn = <TData>(name: string) => encryptedColumn<TData>(name, {
  dataType: "mediumtext",
  serialize: JSON.stringify,
  deserialize: JSON.parse,
})

export const WorkflowRunTable = mysqlTable(
  "workflow_run",
  {
    id: denTypeIdColumn("workflowRun", "id").notNull().primaryKey(),
    organization_id: denTypeIdColumn("organization", "organization_id").notNull(),
    org_membership_id: denTypeIdColumn("member", "org_membership_id"),
    automation_run_id: denTypeIdColumn("automationRun", "automation_run_id"),
    plugin_id: denTypeIdColumn("plugin", "plugin_id"),
    config_object_id: denTypeIdColumn("configObject", "config_object_id"),
    config_object_version_id: denTypeIdColumn("configObjectVersion", "config_object_version_id"),
    source: varchar("source", { length: 255 }).notNull(),
    code_digest: varchar("code_digest", { length: 80 }).notNull(),
    status: mysqlEnum("status", ["succeeded", "failed"]).notNull(),
    error_kind: varchar("error_kind", { length: 64 }),
    error_message: text("error_message"),
    tool_calls: json("tool_calls").$type<Array<{ name: string }>>(),
    tool_call_count: int("tool_call_count").notNull().default(0),
    duration_ms: int("duration_ms").notNull().default(0),
    started_at: timestamp("started_at", { fsp: 3 }).notNull(),
    finished_at: timestamp("finished_at", { fsp: 3 }).notNull(),
    script_input: encryptedJsonColumn<unknown>("script_input"),
    script_input_digest: varchar("script_input_digest", { length: 80 }),
    input_schema_digest: varchar("input_schema_digest", { length: 80 }),
    validated_result: encryptedJsonColumn<unknown>("validated_result"),
    result_markdown: encryptedMediumTextColumn("result_markdown"),
    result_digest: varchar("result_digest", { length: 80 }),
    output_schema_digest: varchar("output_schema_digest", { length: 80 }),
    renderer_version: varchar("renderer_version", { length: 64 }),
    artifact_content_deleted_at: timestamp("artifact_content_deleted_at", { fsp: 3 }),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("workflow_run_org_created").on(table.organization_id, table.created_at),
    index("workflow_run_automation").on(table.automation_run_id),
    index("workflow_run_artifact_history").on(table.config_object_id, table.finished_at),
  ],
)
