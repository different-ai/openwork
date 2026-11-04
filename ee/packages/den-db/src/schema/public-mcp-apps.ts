import { sql } from "drizzle-orm"
import { index, mysqlTable, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core"
import { denTypeIdColumn } from "../columns"

/**
 * An App built in OpenWork served at a public MCP URL that needs no sign-in,
 * `/mcp/public/apps/<slug>`. One row per App: publishing again pins a newer
 * revision and keeps the slug unless a new one is chosen. A slug stays with its
 * App while unpublished, so an old public URL never starts serving another App. Unpublishing sets `unpublishedAt`; the
 * public server refuses the id from then on, until the App is published again.
 * The row holds no credentials and nothing a visitor sent.
 */
export const PublicMcpAppTable = mysqlTable(
  "public_mcp_app",
  {
    id: denTypeIdColumn("publicMcpApp", "id").notNull().primaryKey(),
    /** The URL name, unique across the deployment: lowercase letters, digits and hyphens. */
    slug: varchar("slug", { length: 64 }).notNull(),
    organizationId: denTypeIdColumn("organization", "organization_id").notNull(),
    /** The App (config object of type app). */
    configObjectId: denTypeIdColumn("configObject", "config_object_id").notNull(),
    /** The pinned revision visitors see. Later App updates stay private until it is published again. */
    configObjectVersionId: denTypeIdColumn("configObjectVersion", "config_object_version_id").notNull(),
    /** Who last published it. Publication stops when they are no longer an owner or admin. */
    publishedByOrgMembershipId: denTypeIdColumn("member", "published_by_org_membership_id").notNull(),
    publishedAt: timestamp("published_at", { fsp: 3 }).notNull().defaultNow(),
    unpublishedAt: timestamp("unpublished_at", { fsp: 3 }),
    createdAt: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
  },
  (table) => [
    uniqueIndex("public_mcp_app_config_object_id").on(table.configObjectId),
    uniqueIndex("public_mcp_app_slug").on(table.slug),
    index("public_mcp_app_organization_id").on(table.organizationId),
  ],
)
