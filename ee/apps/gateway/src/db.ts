import { createDenDb } from "@openwork-ee/den-db"
import { env } from "./env.js"

const configuration = { databaseUrl: env.databaseUrl, mode: env.dbMode, planetscale: env.planetscale }
export const { db, client } = createDenDb(configuration)
let usageWrites: ReturnType<typeof createDenDb> | undefined
export function usageWriteDatabase() {
  usageWrites ??= createDenDb(configuration)
  return usageWrites.db
}
export async function closeUsageWriteDatabase() {
  if (usageWrites && "end" in usageWrites.client) await usageWrites.client.end()
  usageWrites = undefined
}
