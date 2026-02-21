import { drizzle } from "drizzle-orm/mysql2"
import mysql from "mysql2/promise"
import { env } from "../env.js"
import * as schema from "./schema.js"

const client = mysql.createPool({
  uri: env.databaseUrl,
})

export const db = drizzle(client, { schema, mode: "default" })
