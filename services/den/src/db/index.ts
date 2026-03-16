import { createDenDb, isTransientDbConnectionError } from "../../../../packages/den-db/dist/index.js"
import { env } from "../env.js"

export const { db } = createDenDb(env.databaseUrl, { mode: env.dbMode })
export { isTransientDbConnectionError }
