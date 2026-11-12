import { eq } from "@openwork-ee/den-db/drizzle"
import { DenInstanceTable } from "@openwork-ee/den-db/schema"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"

const SINGLETON = "den"
let cached: string | null = null

/**
 * This Den installation's stable id (`dni_…`), exported as a blob's
 * `source.instanceId`. Created on first use and kept in `den_instance`;
 * concurrent first calls agree because only the first insert wins.
 */
export async function getConfigInstanceId(): Promise<string> {
  if (cached) return cached
  await db.$primary
    .insert(DenInstanceTable)
    .values({ singleton: SINGLETON, instanceId: createDenTypeId("denInstance") })
    .onDuplicateKeyUpdate({ set: { singleton: SINGLETON } })
  const [row] = await db.$primary.select({ instanceId: DenInstanceTable.instanceId }).from(DenInstanceTable).where(eq(DenInstanceTable.singleton, SINGLETON)).limit(1)
  if (!row) throw new Error("den_instance_missing")
  cached = row.instanceId
  return cached
}
