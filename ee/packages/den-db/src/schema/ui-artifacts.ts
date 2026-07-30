import { sql } from "drizzle-orm"
import { boolean, json, mysqlTable, timestamp } from "drizzle-orm/mysql-core"
import type { UiArtifactKind } from "@openwork/types/ui-artifact"
import { denTypeIdColumn } from "../columns"

export const UiArtifactPreferenceTable = mysqlTable(
  "ui_artifact_preference",
  {
    memberId: denTypeIdColumn("member", "member_id").notNull().primaryKey(),
    enabled: boolean("enabled").notNull().default(false),
    enabledArtifactIds: json("enabled_artifact_ids").$type<UiArtifactKind[]>().notNull(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
)
