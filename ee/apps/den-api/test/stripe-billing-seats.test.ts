import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
}

let stripeBillingModule: typeof import("../src/stripe-billing.js")

beforeAll(async () => {
  seedRequiredEnv()
  stripeBillingModule = await import("../src/stripe-billing.js")
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
