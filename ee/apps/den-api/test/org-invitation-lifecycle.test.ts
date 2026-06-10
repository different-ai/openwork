import { beforeAll, beforeEach, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"

const entraOrganizationId = createDenTypeId("organization")

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.DEN_ENTRA_TENANT_ID = "00000000-0000-0000-0000-000000000123"
  process.env.DEN_ENTRA_CLIENT_ID = "client-123"
  process.env.DEN_ENTRA_CLIENT_SECRET = "secret-123"
  process.env.DEN_ENTRA_AUTO_JOIN_ENABLED = "true"
  process.env.DEN_ENTRA_AUTO_JOIN_ORG_ID = entraOrganizationId
}

function unsignedJwt(payload: Record<string, unknown>) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  return `eyJhbGciOiJub25lIn0.${encodedPayload}.`
}

let queryRows: unknown[][] = []
let operations: Array<{ type: "insert" | "update"; value: any }> = []
let hookCalls: Array<{ organizationId: string; memberId: string; change: "added" | "removed" }> = []
let whereInputs: unknown[] = []
let seatEligibility = { allowed: true, currentCount: 1, freeSeatCount: 1 }

function queryFor(rows: unknown[]) {
  const chain: any = {
    from: () => chain,
    innerJoin: () => chain,
    where: (input: unknown) => {
      whereInputs.push(input)
      return chain
    },
    orderBy: () => rows,
    limit: () => rows,
    then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
  }
  return chain
}

function conditionReferencesRemovedAt(input: unknown, seen = new Set<unknown>()): boolean {
  if (input === null || input === undefined) return false
  if (typeof input === "string") return input.includes("removedAt") || input.includes("removed_at")
  if (typeof input !== "object" && typeof input !== "function") return false
  if (seen.has(input)) return false
  seen.add(input)

  const record = input as Record<PropertyKey, unknown>
  for (const key of Reflect.ownKeys(input)) {
    const keyText = String(key)
    if (keyText.includes("removedAt") || keyText.includes("removed_at")) return true
    try {
      if (conditionReferencesRemovedAt(record[key], seen)) return true
    } catch {}
  }

  return false
}

function writeResult() {
  return {
    onDuplicateKeyUpdate: () => Promise.resolve(),
    then: (resolve: (value: undefined) => unknown) => Promise.resolve().then(() => resolve(undefined)),
  }
}

mock.module("../src/db.js", () => ({
  db: {
    select: () => queryFor(queryRows.shift() ?? []),
    insert: () => ({
      values: (value: any) => {
        operations.push({ type: "insert", value })
        return writeResult()
      },
    }),
    update: () => ({
      set: (value: any) => ({
        where: () => {
          operations.push({ type: "update", value })
          return Promise.resolve()
        },
      }),
    }),
    transaction: async (callback: (tx: unknown) => Promise<void>) => callback({
      delete: () => ({
        where: () => Promise.resolve(),
      }),
      update: () => ({
        set: (value: any) => ({
          where: () => {
            operations.push({ type: "update", value })
            return Promise.resolve()
          },
        }),
      }),
    }),
  },
}))

mock.module("../src/organization-member-hooks.js", () => ({
  runPostOrganizationMemberChangeHooks: (input: { organizationId: string; memberId: string; change: "added" | "removed" }) => {
    hookCalls.push(input)
    return Promise.resolve()
  },
}))

mock.module("../src/stripe-billing.js", () => ({
  FREE_ORG_SEAT_COUNT: 5,
  billableSeatQuantity: (memberCount: number) => Math.max(0, memberCount - 5),
  createInferenceCheckoutSession: () => Promise.resolve(null),
  createInferencePortalSession: () => Promise.resolve(null),
  createOrgSubscriptionCheckoutSession: () => Promise.resolve(null),
  createSeatCheckoutSession: () => Promise.resolve(null),
  createStripePortalSession: () => Promise.resolve(null),
  findOrCreateStripeCustomer: () => Promise.resolve(null),
  getActiveMemberCountForBilling: () => Promise.resolve(seatEligibility.currentCount),
  getOrgBillingSummary: () => Promise.resolve(null),
  getOrganizationSeatAddEligibility: () => Promise.resolve(seatEligibility),
  handleStripeWebhook: () => Promise.resolve({ received: true }),
  organizationHasActiveInferenceSubscription: () => Promise.resolve(false),
  organizationHasActiveSeatSubscription: () => Promise.resolve(seatEligibility.allowed),
  syncInferenceSubscriptionQuantityAfterMemberChange: () => Promise.resolve(),
  syncSeatCheckoutSession: () => Promise.resolve(null),
  syncSeatSubscriptionQuantityAfterMemberChange: () => Promise.resolve(),
  upsertInferenceSubscriptionFromStripe: () => Promise.resolve(),
  upsertOrgSubscriptionFromStripe: () => Promise.resolve(),
}))

let orgsModule: typeof import("../src/orgs.js")

beforeAll(async () => {
  seedRequiredEnv()
  orgsModule = await import("../src/orgs.js")
})

beforeEach(() => {
  queryRows = []
  operations = []
  hookCalls = []
  whereInputs = []
  seatEligibility = { allowed: true, currentCount: 1, freeSeatCount: 1 }
})

test("invitation preview resolves an invite token", async () => {
  const invitationId = createDenTypeId("invitation")
  const organizationId = createDenTypeId("organization")
  const expiresAt = new Date(Date.now() + 60_000)
  const createdAt = new Date("2026-06-09T00:00:00.000Z")
  queryRows = [[{
    invitation: {
      id: invitationId,
      email: "teammate@example.com",
      role: "member",
      status: "pending",
      expiresAt,
      createdAt,
    },
    organization: {
      id: organizationId,
      name: "Demo Org",
      slug: "demo-org",
      allowedEmailDomains: null,
    },
  }]]

  const preview = await orgsModule.getInvitationPreview("invite-token-123")

  expect(preview?.invitation.id).toBe(invitationId)
  expect(preview?.invitation.status).toBe("pending")
  expect(preview?.organization.id).toBe(organizationId)
})

test("accept by invite token claims placeholder member and emits the acceptance lifecycle hook", async () => {
  const invitationId = createDenTypeId("invitation")
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const placeholderMemberId = createDenTypeId("member")
  const teamId = createDenTypeId("team")
  const teamMemberId = createDenTypeId("teamMember")
  const invitation = {
    id: invitationId,
    email: "teammate@example.com",
    role: "member",
    organizationId,
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
    teamId,
  }
  const claimedMember = {
    id: placeholderMemberId,
    organizationId,
    userId,
    inviteId: invitationId,
    invitedByOrgMember: null,
    role: "member",
    joinedAt: new Date("2026-06-09T00:00:00.000Z"),
    removedAt: null,
    removedByOrgMember: null,
    createdAt: new Date("2026-06-08T00:00:00.000Z"),
  }
  queryRows = [
    [invitation],
    [{ allowedEmailDomains: null }],
    [{ role: "member" }, { role: "admin" }],
    [],
    [{ id: placeholderMemberId }],
    [claimedMember],
    [{ id: teamId }],
    [{ id: teamMemberId }],
  ]

  const accepted = await orgsModule.acceptInvitationForUser({
    userId,
    email: "teammate@example.com",
    invitationId: "invite-token-123",
  })

  expect(accepted?.member.id).toBe(placeholderMemberId)
  expect(accepted?.member.userId).toBe(userId)
  expect(operations.some((operation) => operation.type === "insert" && operation.value?.userId === userId)).toBe(false)
  expect(operations.some((operation) => operation.type === "insert" && operation.value?.orgMembershipId === placeholderMemberId)).toBe(false)
  expect(operations.some((operation) => operation.type === "update" && operation.value?.status === "accepted")).toBe(true)
  expect(operations.some((operation) => operation.type === "update" && operation.value?.userId === userId)).toBe(true)
  expect(hookCalls).toEqual([{ organizationId, memberId: placeholderMemberId, change: "added" }])
})

test("accept by invite token does not emit duplicate member hooks for existing active members", async () => {
  const invitationId = createDenTypeId("invitation")
  const organizationId = createDenTypeId("organization")
  const userId = createDenTypeId("user")
  const existingMemberId = createDenTypeId("member")
  const placeholderMemberId = createDenTypeId("member")
  const invitation = {
    id: invitationId,
    email: "teammate@example.com",
    role: "member",
    organizationId,
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
    teamId: null,
  }
  const existingMember = {
    id: existingMemberId,
    organizationId,
    userId,
    inviteId: null,
    invitedByOrgMember: null,
    role: "member",
    joinedAt: new Date("2026-06-09T00:00:00.000Z"),
    removedAt: null,
    removedByOrgMember: null,
    createdAt: new Date("2026-06-08T00:00:00.000Z"),
  }
  queryRows = [
    [invitation],
    [{ allowedEmailDomains: null }],
    [{ role: "member" }, { role: "admin" }],
    [existingMember],
    [{ id: placeholderMemberId }],
  ]

  const accepted = await orgsModule.acceptInvitationForUser({
    userId,
    email: "teammate@example.com",
    invitationId: "invite-token-123",
  })

  expect(accepted?.member.id).toBe(existingMemberId)
  expect(operations.some((operation) => operation.type === "update" && operation.value?.removedAt instanceof Date)).toBe(true)
  expect(hookCalls).toEqual([])
})

test("Entra auto-join accepts matching pending invitations and removes placeholders", async () => {
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const invitationId = createDenTypeId("invitation")
  const placeholderMemberId = createDenTypeId("member")
  const member = {
    id: memberId,
    organizationId: entraOrganizationId,
    userId,
    inviteId: null,
    invitedByOrgMember: null,
    role: "member",
    joinedAt: new Date("2026-06-09T00:00:00.000Z"),
    removedAt: null,
    removedByOrgMember: null,
    createdAt: new Date("2026-06-09T00:00:00.000Z"),
  }
  const invitation = {
    id: invitationId,
    email: "teammate@example.com",
    role: "member",
    organizationId: entraOrganizationId,
    status: "pending",
    expiresAt: new Date(Date.now() + 60_000),
    teamId: null,
  }
  queryRows = [
    [{ id: entraOrganizationId }],
    [],
    [],
    [member],
    [{ email: "teammate@example.com" }],
    [invitation],
    [{ id: placeholderMemberId }],
  ]

  const result = await orgsModule.ensureEntraSsoMembershipForAccount({
    userId,
    providerId: "microsoft",
    idToken: unsignedJwt({ groups: [] }),
  })

  expect(result.status).toBe("created")
  expect(operations.some((operation) => operation.type === "update" && operation.value?.status === "accepted")).toBe(true)
  expect(operations.some((operation) => operation.type === "update" && operation.value?.removedAt instanceof Date && operation.value?.userId === null)).toBe(true)
  expect(hookCalls).toEqual([{ organizationId: entraOrganizationId, memberId, change: "added" }])
})

test("Entra auto-join ignores expired pending invitations", async () => {
  const userId = createDenTypeId("user")
  const memberId = createDenTypeId("member")
  const invitationId = createDenTypeId("invitation")
  const placeholderMemberId = createDenTypeId("member")
  const member = {
    id: memberId,
    organizationId: entraOrganizationId,
    userId,
    inviteId: null,
    invitedByOrgMember: null,
    role: "member",
    joinedAt: new Date("2026-06-09T00:00:00.000Z"),
    removedAt: null,
    removedByOrgMember: null,
    createdAt: new Date("2026-06-09T00:00:00.000Z"),
  }
  const invitation = {
    id: invitationId,
    email: "teammate@example.com",
    role: "member",
    organizationId: entraOrganizationId,
    status: "pending",
    expiresAt: new Date(Date.now() - 60_000),
    teamId: null,
  }
  queryRows = [
    [{ id: entraOrganizationId }],
    [],
    [],
    [member],
    [{ email: "teammate@example.com" }],
    [invitation],
    [{ id: placeholderMemberId }],
  ]

  const result = await orgsModule.ensureEntraSsoMembershipForAccount({
    userId,
    providerId: "microsoft",
    idToken: unsignedJwt({ groups: [] }),
  })

  expect(result.status).toBe("created")
  expect(operations.some((operation) => operation.type === "update" && operation.value?.status === "accepted")).toBe(false)
  expect(operations.some((operation) => operation.type === "update" && operation.value?.status === "canceled")).toBe(true)
  expect(operations.some((operation) => operation.type === "update" && operation.value?.removedAt instanceof Date)).toBe(true)
  expect(hookCalls).toEqual([{ organizationId: entraOrganizationId, memberId, change: "added" }])
})

test("Entra auto-join does not bypass seat billing gate", async () => {
  const userId = createDenTypeId("user")
  seatEligibility = { allowed: false, currentCount: 1, freeSeatCount: 1 }
  queryRows = [
    [{ id: entraOrganizationId }],
    [],
  ]

  await expect(orgsModule.ensureEntraSsoMembershipForAccount({
    userId,
    providerId: "microsoft",
    idToken: unsignedJwt({ groups: [] }),
  })).rejects.toThrow("entra_sso_seat_subscription_required")

  expect(operations).toEqual([])
  expect(hookCalls).toEqual([])
})

test("member removal targets active members only and repeated removals emit no hook", async () => {
  const organizationId = createDenTypeId("organization")
  const memberId = createDenTypeId("member")
  queryRows = [[]]

  const removed = await orgsModule.removeOrganizationMember({ organizationId, memberId })

  expect(removed).toBeNull()
  expect(operations).toEqual([])
  expect(hookCalls).toEqual([])
  expect(whereInputs.some((input) => conditionReferencesRemovedAt(input))).toBe(true)
})
