import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { emailOTP, organization } from "better-auth/plugins"
import { APIError } from "better-call"
import { db } from "./db/index.js"
import * as schema from "./db/schema.js"
import { createDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { sendDenOrganizationInvitationEmail, sendDenVerificationEmail } from "./email.js"
import { env } from "./env.js"
import { syncDenSignupContact } from "./loops.js"
import { seedDefaultOrganizationRoles } from "./orgs.js"
import { denOrganizationAccess, denOrganizationStaticRoles } from "./organization-access.js"

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

function hasRole(roleValue: string, roleName: string) {
  return roleValue
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .includes(roleName)
}

function getInvitationOrigin() {
  return env.betterAuthTrustedOrigins.find((origin) => origin !== "*") ?? env.betterAuthUrl
}

function buildInvitationLink(invitationId: string) {
  return new URL(`/join-org?invite=${encodeURIComponent(invitationId)}`, getInvitationOrigin()).toString()
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
          case "rateLimit":
            return createDenTypeId("rateLimit")
          case "organization":
            return createDenTypeId("organization")
          case "member":
            return createDenTypeId("member")
          case "invitation":
            return createDenTypeId("invitation")
          case "team":
            return createDenTypeId("team")
          case "teamMember":
            return createDenTypeId("teamMember")
          case "organizationRole":
            return createDenTypeId("organizationRole")
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
      await syncDenSignupContact({
        email: user.email,
        name: user.name,
      })
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
    organization({
      ac: denOrganizationAccess,
      roles: denOrganizationStaticRoles,
      creatorRole: "owner",
      requireEmailVerificationOnInvitation: true,
      dynamicAccessControl: {
        enabled: true,
      },
      teams: {
        enabled: true,
        defaultTeam: {
          enabled: false,
        },
      },
      async sendInvitationEmail(data) {
        await sendDenOrganizationInvitationEmail({
          email: data.email,
          inviteLink: buildInvitationLink(data.id),
          invitedByName: data.inviter.user.name ?? data.inviter.user.email,
          invitedByEmail: data.inviter.user.email,
          organizationName: data.organization.name,
          role: data.role,
        })
      },
      organizationHooks: {
        afterCreateOrganization: async ({ organization }) => {
          await seedDefaultOrganizationRoles(normalizeDenTypeId("organization", organization.id))
        },
        beforeRemoveMember: async ({ member }) => {
          if (hasRole(member.role, "owner")) {
            throw new APIError("BAD_REQUEST", {
              message: "The organization owner cannot be removed.",
            })
          }
        },
        beforeUpdateMemberRole: async ({ member, newRole }) => {
          if (hasRole(member.role, "owner")) {
            throw new APIError("BAD_REQUEST", {
              message: "The organization owner role cannot be changed.",
            })
          }

          if (hasRole(newRole, "owner")) {
            throw new APIError("BAD_REQUEST", {
              message: "Owner can only be assigned during organization creation.",
            })
          }
        },
      },
    }),
  ],
})
