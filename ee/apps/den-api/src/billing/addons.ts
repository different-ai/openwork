import type { EntitlementKey } from "../entitlements.js"
import { env } from "../env.js"

export type BillingAddon = {
  key: string
  label: string
  billingModel: "flat" | "per-seat"
  stripePriceId: () => string | undefined
  priceIdMissingError: string
  stripeProduct: string
  unitAmount: number
  currency: string
  interval: "month"
  legacyKeys?: readonly string[]
  entitlements?: readonly EntitlementKey[]
  enablesInference?: boolean
}

const ADDONS: readonly BillingAddon[] = [
  {
    key: "inference",
    label: "OpenWork Models",
    billingModel: "flat",
    stripePriceId: () => env.stripe.inferencePriceId,
    priceIdMissingError: "stripe_inference_price_id_missing",
    stripeProduct: "openwork_models",
    unitAmount: 1000,
    currency: "usd",
    interval: "month",
    enablesInference: true,
  },
  {
    key: "seats",
    label: "Organization seats",
    billingModel: "per-seat",
    stripePriceId: () => env.stripe.seatPriceId,
    priceIdMissingError: "stripe_seat_price_id_missing",
    stripeProduct: "openwork_seats",
    unitAmount: 1000,
    currency: "usd",
    interval: "month",
    legacyKeys: ["seat"],
  },
]

export function listAddons() {
  return ADDONS
}

export function getAddon(key: string) {
  return ADDONS.find((addon) => addon.key === key)
}

export function resolveAddon(key: string | null | undefined) {
  if (!key) {
    return undefined
  }
  return ADDONS.find((addon) => addon.key === key || addon.legacyKeys?.includes(key))
}

export function getAddonByStripePriceId(priceId: string | null | undefined) {
  if (!priceId) {
    return undefined
  }
  return ADDONS.find((addon) => addon.stripePriceId() === priceId)
}
