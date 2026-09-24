import { createDenDb } from "@openwork-ee/den-db"
import { env } from "./env.js"

export const { db, client } = createDenDb({
  databaseUrl: env.databaseUrl,
  mode: env.dbMode,
  planetscale: env.planetscale,
})
