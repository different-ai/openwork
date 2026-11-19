import { sql } from "drizzle-orm"
import { index, int, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * Feature intros (DESIGN.md I1–I10, packages/types/src/den/feature-intros.ts):
 * which intros one member has seen, dismissed or acted on in one organization.
 * Den web owns the intro registry; `intro_version` is the registry version the
 * timestamps belong to, and a newer version resets them.
 */
export const FeatureIntroStateTable = mysqlTable(
  "feature_intro_state",
  {
    id: denTypeIdColumn("featureIntroState", "id").notNull().primaryKey(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    memberId: denTypeIdColumn("member", "member_id").notNull(),
    /** Registry key, e.g. "ai-gateway.limits". */
    introKey: varchar("intro_key", { length: 120 }).notNull(),
    introVersion: int("intro_version").notNull(),
    firstSeenAt: timestamp("first_seen_at", { fsp: 3 }),
    /** Drives the 30-day "not viewed yet" dot. */
    lastSeenAt: timestamp("last_seen_at", { fsp: 3 }),
    /** Banner dismissed (hidden for 30 days). */
    dismissedAt: timestamp("dismissed_at", { fsp: 3 }),
    ctaClickedAt: timestamp("cta_clicked_at", { fsp: 3 }),
    /** Set-up observed, for analytics. */
    completedAt: timestamp("completed_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("feature_intro_state_member_key").on(table.organizationId, table.memberId, table.introKey),
    index("feature_intro_state_member").on(table.organizationId, table.memberId),
  ],
)

export const featureIntroState = FeatureIntroStateTable
