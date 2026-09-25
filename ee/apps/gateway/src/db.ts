import { createDenDb } from "@openwork-ee/den-db"
import { env } from "./env.js"

const configuration = { databaseUrl: env.databaseUrl, mode: env.dbMode, planetscale: env.planetscale }
export const { db, client } = createDenDb(configuration)
let usageWrites: ReturnType<typeof createDenDb> | undefined
export function usageWriteDatabase() {
  usageWrites ??= createDenDb(configuration)
  return usageWrites.db
}
let freeAuto: ReturnType<typeof createDenDb> | undefined
/** Free Auto's own client, so public free traffic never shares a connection pool with paid Gateway requests. */
export function freeAutoDatabase() {
  freeAuto ??= createDenDb(configuration)
  return freeAuto.db
}
export async function closeUsageWriteDatabase() {
  if (usageWrites && "end" in usageWrites.client) await usageWrites.client.end()
  usageWrites = undefined
}
