import { beforeAll, expect, test } from "bun:test"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.CORS_ORIGINS = process.env.CORS_ORIGINS ?? "http://127.0.0.1:8790"
  process.env.STRIPE_INFERENCE_PRICE_ID = "price_inference_catalog"
  process.env.STRIPE_SEAT_PRICE_ID = "price_seats_catalog"
}

let addons: typeof import("../src/billing/addons.js")
let billingCompat: typeof import("../src/routes/org/billing-compat.js")

beforeAll(async () => {
  seedRequiredEnv()
  const modules = await Promise.all([
    import("../src/billing/addons.js"),
    import("../src/routes/org/billing-compat.js"),
  ])
  addons = modules[0]
  billingCompat = modules[1]
})

test("addon catalog lists and resolves the configured addons", () => {
  expect(addons.listAddons().map((addon) => addon.key)).toEqual(["inference", "seats"])
  expect(addons.getAddon("inference")?.billingModel).toBe("flat")
  expect(addons.getAddon("seats")?.billingModel).toBe("per-seat")
  expect(addons.getAddon("missing")).toBeUndefined()
  expect(addons.getAddonByStripePriceId(addons.getAddon("inference")?.stripePriceId())?.key).toBe("inference")
  expect(addons.getAddonByStripePriceId(addons.getAddon("seats")?.stripePriceId())?.key).toBe("seats")
})

test("checkout maps legacy subscription types to addon keys", () => {
  expect(billingCompat.resolveStripeCheckoutAddonKey({})).toBe("inference")
  expect(billingCompat.resolveStripeCheckoutAddonKey({ type: "inference" })).toBe("inference")
  expect(billingCompat.resolveStripeCheckoutAddonKey({ type: "seat" })).toBe("seats")
  expect(billingCompat.resolveStripeCheckoutAddonKey({ addonKey: "seats" })).toBe("seats")
  expect(billingCompat.resolveStripeCheckoutAddonKey({ addonKey: "missing" })).toBeNull()
})
