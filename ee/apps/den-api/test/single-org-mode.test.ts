import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP = process.env.DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP ?? "false"
}

let envModule: typeof import("../src/env.js")
let singleOrgPolicy: typeof import("../src/single-org-policy.js")
let signupPolicy: typeof import("../src/single-org-signup-policy.js")

beforeAll(async () => {
  seedRequiredEnv()
  envModule = await import("../src/env.js")
  singleOrgPolicy = await import("../src/single-org-policy.js")
  signupPolicy = await import("../src/single-org-signup-policy.js")
})

test("blank org mode resolves to single_org", () => {
  expect(envModule.parseDenOrgMode(undefined)).toBe("single_org")
  expect(envModule.parseDenOrgMode("")).toBe("single_org")
  expect(envModule.parseDenOrgMode("   ")).toBe("single_org")
})

test("org mode accepts explicit deployment modes and rejects unknown values", () => {
  expect(envModule.parseDenOrgMode("single_org")).toBe("single_org")
  expect(envModule.parseDenOrgMode("multi_org")).toBe("multi_org")
  expect(() => envModule.parseDenOrgMode("single")).toThrow("DEN_ORG_MODE")
})

test("single-org slug normalization keeps Helm-safe slugs strict", () => {
  expect(envModule.normalizeSingleOrgSlug(undefined)).toBe("default")
  expect(envModule.normalizeSingleOrgSlug(" Acme-Internal ")).toBe("acme-internal")
  expect(() => envModule.normalizeSingleOrgSlug("bad slug")).toThrow("DEN_SINGLE_ORG_SLUG")
})

test("single-org public signup defaults private and parses Helm string values", () => {
  expect(envModule.parseSingleOrgAllowPublicSignup(undefined, "single_org")).toBe(false)
  expect(envModule.parseSingleOrgAllowPublicSignup("", "single_org")).toBe(false)
  expect(envModule.parseSingleOrgAllowPublicSignup(" false ", "single_org")).toBe(false)
  expect(envModule.parseSingleOrgAllowPublicSignup("0", "single_org")).toBe(false)
  expect(envModule.parseSingleOrgAllowPublicSignup("true", "single_org")).toBe(true)
  expect(envModule.parseSingleOrgAllowPublicSignup("YES", "single_org")).toBe(true)
  expect(envModule.parseSingleOrgAllowPublicSignup(undefined, "multi_org")).toBe(true)
  expect(() => envModule.parseSingleOrgAllowPublicSignup("sometimes", "single_org")).toThrow("DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP")
})

test("single-org signup policy allows matching domains", async () => {
  const matching = await signupPolicy.resolveSingleOrgEmailSignupPolicyViolation({
    orgMode: "single_org",
    allowPublicSignup: true,
    email: "User@Acme.com",
    getSingletonOrganization: async () => ({ allowedEmailDomains: ["acme.com"] }),
  })
  expect(matching).toBeNull()
})

test("single-org signup policy rejects outside domains", async () => {
  const rejected = await signupPolicy.resolveSingleOrgEmailSignupPolicyViolation({
    orgMode: "single_org",
    allowPublicSignup: true,
    email: "user@outside.com",
    getSingletonOrganization: async () => ({ allowedEmailDomains: ["acme.com"] }),
  })
  expect(rejected).toEqual({
    error: "email_domain_restricted",
    message: "This workspace only allows acme.com email addresses.",
    allowedEmailDomains: ["acme.com"],
  })
})

test("single-org signup policy blocks private email signup and leaves multi-org unchanged", async () => {
  const disabled = await signupPolicy.resolveSingleOrgEmailSignupPolicyViolation({
    orgMode: "single_org",
    allowPublicSignup: false,
    email: "invited@acme.com",
    getSingletonOrganization: async () => {
      throw new Error("private signup should not query the singleton")
    },
  })
  expect(disabled).toEqual({
    error: "single_org_signup_disabled",
    message: "Email signup is disabled for this deployment. Use your organization's SSO or a pre-provisioned account to sign in.",
  })

  const multiOrg = await signupPolicy.resolveSingleOrgEmailSignupPolicyViolation({
    orgMode: "multi_org",
    allowPublicSignup: false,
    email: "user@outside.com",
    getSingletonOrganization: async () => {
      throw new Error("multi-org signup should not query the singleton")
    },
  })
  expect(multiOrg).toBeNull()
})

test("single-org owner bootstrap honors configured owner emails", () => {
  expect(singleOrgPolicy.resolveSingleOrgMembershipRole({
    activeOwnerCount: 0,
    email: "admin@example.com",
    ownerEmails: ["admin@example.com"],
  })).toBe("owner")

  expect(singleOrgPolicy.resolveSingleOrgMembershipRole({
    activeOwnerCount: 0,
    email: "user@example.com",
    ownerEmails: ["admin@example.com"],
  })).toBeNull()

  expect(singleOrgPolicy.resolveSingleOrgMembershipRole({
    activeOwnerCount: 1,
    email: "user@example.com",
    ownerEmails: ["admin@example.com"],
  })).toBe("member")
})
