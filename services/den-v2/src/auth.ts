import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { db } from "./db/index.js"
import * as schema from "./db/schema.js"
import { createDenTypeId, normalizeDenTypeId } from "./db/typeid.js"
import { env } from "./env.js"
import { ensureDefaultOrg } from "./orgs.js"

const socialProviders = {
  ...(env.github.clientId && env.github.clientSecret
    ? {
        github: {
          clientId: env.github.clientId,
          clientSecret: env.github.clientSecret,
        },
      }
    : {}),
  ...(env.google.clientId && env.google.clientSecret
    ? {
        google: {
          clientId: env.google.clientId,
          clientSecret: env.google.clientSecret,
        },
      }
    : {}),
}

export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  trustedOrigins: env.betterAuthTrustedOrigins.length > 0 ? env.betterAuthTrustedOrigins : undefined,
  socialProviders: Object.keys(socialProviders).length > 0 ? socialProviders : undefined,
  database: drizzleAdapter(db, {
    provider: "mysql",
    schema,
  }),
  advanced: {
    database: {
      generateId: (options) => {
        switch (options.model) {
          case "user":
            return createDenTypeId("user")
          case "session":
            return createDenTypeId("session")
          case "account":
            return createDenTypeId("account")
          case "verification":
            return createDenTypeId("verification")
          default:
            return false
        }
      },
    },
  },
  emailAndPassword: {
    enabled: true,
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const name = user.name ?? user.email ?? "Personal"
          await ensureDefaultOrg(normalizeDenTypeId("user", user.id), name)
        },
      },
    },
  },
})
