import { createDenDb } from "@openwork-ee/den-db"
import { env } from "./env.js"
import { dbQueryCounter } from "./observability/db-query-count.js"
import { noteInventoryWrite } from "./inventory-writes.js"
import { forgetRequestReadsOnWrite } from "./request-reads.js"
import { shouldReadFromPrimary } from "./read-routing.js"

export const { db, client, readClient } = createDenDb({
  databaseUrl: env.databaseUrl,
  mode: env.dbMode,
  planetscale: env.planetscale,
  readReplica: env.readReplica,
  // Read-your-writes: once a request has written, its later reads use the primary.
  readFromPrimary: shouldReadFromPrimary,
  logger: {
    logQuery(query: string, params: unknown[]) {
      dbQueryCounter.logQuery(query, params)
      forgetRequestReadsOnWrite(query)
      noteInventoryWrite(query, params)
    },
  },
})
