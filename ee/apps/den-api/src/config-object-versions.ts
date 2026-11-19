import { and, desc, eq, inArray, sql } from "@openwork-ee/den-db/drizzle"
import { ConfigObjectVersionTable } from "@openwork-ee/den-db/schema"
import { db } from "./db.js"

type ConfigObjectVersion = typeof ConfigObjectVersionTable.$inferSelect
const VERSION_BATCH_SIZE = 100

/** Select IDs before loading encrypted payloads: old revisions never need decoding. */
export async function latestConfigObjectVersions(
  configObjectIds: ConfigObjectVersion["configObjectId"][],
  organizationId?: ConfigObjectVersion["organizationId"],
): Promise<Map<string, ConfigObjectVersion>> {
  const latest = new Map<string, ConfigObjectVersion>()
  const ids = [...new Set(configObjectIds)]
  for (let offset = 0; offset < ids.length; offset += VERSION_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + VERSION_BATCH_SIZE)
    const ranked = db.select({
      id: ConfigObjectVersionTable.id,
      rank: sql<number>`row_number() over (partition by ${ConfigObjectVersionTable.configObjectId} order by ${ConfigObjectVersionTable.createdAt} desc, ${ConfigObjectVersionTable.id} desc)`.as("version_rank"),
    }).from(ConfigObjectVersionTable).where(and(
      inArray(ConfigObjectVersionTable.configObjectId, batch),
      organizationId ? eq(ConfigObjectVersionTable.organizationId, organizationId) : undefined,
    )).as("ranked_config_object_versions")

    const rows = await db.select({ version: ConfigObjectVersionTable })
      .from(ConfigObjectVersionTable)
      .innerJoin(ranked, and(eq(ConfigObjectVersionTable.id, ranked.id), eq(ranked.rank, 1)))
      .orderBy(desc(ConfigObjectVersionTable.createdAt), desc(ConfigObjectVersionTable.id))
    for (const { version } of rows) latest.set(version.configObjectId, version)
  }
  return latest
}
