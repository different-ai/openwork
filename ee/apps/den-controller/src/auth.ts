import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { emailOTP } from "better-auth/plugins"
import { db } from "./db/index.js"
import * as schema from "./db/schema.js"
import { createDenTypeId, normalizeDenTypeId } from "./db/typeid.js"
import { sendDenVerificationEmail } from "./email.js"
import { env } from "./env.js"
import { syncDenSignupContact } from "./loops.js"
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
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for", "x-real-ip", "cf-connecting-ip"],
      ipv6Subnet: 64,
    },
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
  rateLimit: {
    enabled: true,
    storage: "database",
    window: 60,
    max: 20,
    customRules: {
      "/sign-in/email": {
        window: 300,
        max: 5,
      },
      "/sign-up/email": {
        window: 3600,
        max: 3,
      },
      "/email-otp/send-verification-otp": {
        window: 3600,
        max: 5,
      },
      "/email-otp/verify-email": {
        window: 300,
        max: 10,
      },
      "/request-password-reset": {
        window: 3600,
        max: 5,
      },
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    sendOnSignIn: true,
    afterEmailVerification: async (user) => {
      const name = user.name ?? user.email ?? "Personal"
      const userId = normalizeDenTypeId("user", user.id)
      await Promise.all([
        ensureDefaultOrg(userId, name),
        syncDenSignupContact({
          email: user.email,
          name: user.name,
        }),
      ])
    },
  },
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
  },
  plugins: [
    emailOTP({
      overrideDefaultEmailVerification: true,
      otpLength: 6,
      expiresIn: 600,
      allowedAttempts: 5,
      async sendVerificationOTP({ email, otp, type }) {
        if (type !== "email-verification") {
          return
        }

        void sendDenVerificationEmail({
          email,
          verificationCode: otp,
        })
      },
    }),
  ],
})
