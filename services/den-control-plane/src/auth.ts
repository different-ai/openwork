import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { db } from "./db/index.js"
import * as schema from "./db/schema.js"
import { env } from "./env.js"
import { ensureDefaultOrg } from "./orgs.js"

export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  trustedOrigins: env.corsOrigins.length > 0 ? env.corsOrigins : undefined,
  database: drizzleAdapter(db, {
    provider: "mysql",
    schema,
  }),
  emailAndPassword: {
    enabled: true,
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const name = user.name ?? user.email ?? "Personal"
          await ensureDefaultOrg(user.id, name)
        },
      },
    },
  },
})
