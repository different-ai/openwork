import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "mysql",
  schema: "./src/schema.ts",
  out: "../../services/den/drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
})
