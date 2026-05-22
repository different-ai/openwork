import { createDenDb } from "@openwork-ee/den-db"
import { env } from "./env.js"

export const denDb = createDenDb({
  databaseUrl: env.databaseUrl,
  mode: env.dbMode,
  planetscale: env.planetscale,
})
export const { client: dbClient, db } = denDb
