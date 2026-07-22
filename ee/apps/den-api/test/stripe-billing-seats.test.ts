import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { afterAll, beforeAll, expect, test } from "bun:test"

const organizationId = createDenTypeId("organization")
const organizationSlug = `seat-gate-test-${organizationId}`
const testMembers = Array.from({ length: 6 }, (_, index) => ({
  memberId: createDenTypeId("member"),
  userId: createDenTypeId("user"),
  email: `seat-gate-member-${index}-${organizationId}@seat-gate.test`,
}))
const userIds = testMembers.map((member) => member.userId)

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  delete process.env.STRIPE_SECRET_KEY
  delete process.env.STRIPE_SEAT_PRICE_ID
}

let stripeBillingModule: typeof import("../src/stripe-billing.js")
let db: typeof import("../src/db.js").db | null = null
let schema: typeof import("@openwork-ee/den-db/schema") | null = null
let drizzle: typeof import("@openwork-ee/den-db/drizzle") | null = null

async function cleanup() {
  if (!db || !schema || !drizzle) {
    return
  }

  await db.delete(schema.MemberTable).where(drizzle.eq(schema.MemberTable.organizationId, organizationId))
  await db.delete(schema.OrganizationTable).where(drizzle.eq(schema.OrganizationTable.id, organizationId))
  await db.delete(schema.AuthUserTable).where(drizzle.inArray(schema.AuthUserTable.id, userIds))
}

beforeAll(async () => {
  seedRequiredEnv()
  const [stripeBilling, dbModule, schemaModule, drizzleModule] = await Promise.all([
    import("../src/stripe-billing.js"),
    import("../src/db.js"),
    import("@openwork-ee/den-db/schema"),
    import("@openwork-ee/den-db/drizzle"),
  ])
  stripeBillingModule = stripeBilling
  db = dbModule.db
  schema = schemaModule
  drizzle = drizzleModule

  await cleanup()

  await db.insert(schema.AuthUserTable).values(testMembers.map((member, index) => ({
    id: member.userId,
    name: `Seat Gate Member ${index}`,
    email: member.email,
    emailVerified: true,
  })))
  await db.insert(schema.OrganizationTable).values({
    id: organizationId,
    name: "Seat Gate Test",
    slug: organizationSlug,
  })
  await db.insert(schema.MemberTable).values(testMembers.map((member, index) => ({
    id: member.memberId,
    organizationId,
    userId: member.userId,
    role: index === 0 ? "owner" : "member",
    joinedAt: new Date(),
  })))
})

afterAll(async () => {
  await cleanup()
})

test("organization seat billing counts include organization metadata additional free seats", () => {
  expect(stripeBillingModule.calculateOrganizationSeatBillingCounts({ memberCount: 5 })).toMatchObject({
    total: 5,
    free: 5,
    chargeable: 0,
    additionalFree: 0,
  })
  expect(stripeBillingModule.calculateOrganizationSeatBillingCounts({ memberCount: 6 })).toMatchObject({ chargeable: 1 })
  expect(stripeBillingModule.calculateOrganizationSeatBillingCounts({ memberCount: 7, metadata: { seatsFreeAdditional: 2 } })).toMatchObject({
    total: 7,
    free: 7,
    chargeable: 0,
    additionalFree: 2,
  })
  expect(stripeBillingModule.calculateOrganizationSeatBillingCounts({ memberCount: 8, additionalFreeSeats: 2 })).toMatchObject({ chargeable: 1 })
})

test("seat billing gate is only enabled for multi-org deployments with Stripe seat billing", () => {
  expect(stripeBillingModule.isSeatBillingGateEnabled({
    orgMode: "single_org",
    stripeSecretKey: "sk_test",
    stripeSeatPriceId: "price_seat",
  })).toBe(false)
  expect(stripeBillingModule.isSeatBillingGateEnabled({
    orgMode: "single_org",
    stripeSecretKey: undefined,
    stripeSeatPriceId: undefined,
  })).toBe(false)
  expect(stripeBillingModule.isSeatBillingGateEnabled({
    orgMode: "multi_org",
    stripeSecretKey: undefined,
    stripeSeatPriceId: undefined,
  })).toBe(false)
  expect(stripeBillingModule.isSeatBillingGateEnabled({
    orgMode: "multi_org",
    stripeSecretKey: "sk_test",
    stripeSeatPriceId: undefined,
  })).toBe(false)
  expect(stripeBillingModule.isSeatBillingGateEnabled({
    orgMode: "multi_org",
    stripeSecretKey: "sk_test",
    stripeSeatPriceId: "price_seat",
  })).toBe(true)
})

test("single-org deployments without Stripe allow more than the hosted free seat count", async () => {
  await expect(stripeBillingModule.getOrganizationSeatAddEligibility(organizationId)).resolves.toMatchObject({
    allowed: true,
    currentCount: 6,
    freeSeatCount: 5,
    billableSeatCount: 1,
    hasActiveSeatSubscription: false,
  })
})
