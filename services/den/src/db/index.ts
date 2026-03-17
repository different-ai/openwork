import { createDenDb, isTransientDbConnectionError } from "../../../../packages/den-db/dist/index.js"
import { env } from "../env.js"

export const { db } = createDenDb({
  databaseUrl: env.databaseUrl,
  mode: env.dbMode,
  planetscale: env.planetscale,
})
export { isTransientDbConnectionError }
