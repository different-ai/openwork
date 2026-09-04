import { env } from "./env.js"

export type SelfServeProduct = "team" | "enterprise" | "sso"

// Only server-configured prices can grant paid features. Never accept a price
// ID, amount, entitlement, or seat quantity from a browser or Stripe metadata.
export function selfServeCatalog() {
  return [
    { id: "team", name: "Team", unitAmount: 1000, quantityType: "member", priceId: env.stripe.teamPriceId },
    { id: "enterprise", name: "Enterprise", unitAmount: 4000, quantityType: "member", priceId: env.stripe.enterprisePriceId },
    { id: "sso", name: "SSO / SAML", unitAmount: 30000, quantityType: "organization", priceId: env.stripe.ssoPriceId },
  ] as const
}

export function selfServeProductForPrice(priceId: string | null | undefined) {
  return selfServeCatalog().find((product) => product.priceId && product.priceId === priceId)
}
