import { env, type DenOrgMode } from "./env.js"

export function openWorkWebDeploymentAvailable(input: {
  orgMode: DenOrgMode
  stripeSecretKey?: string
  openWorkWebPriceId?: string
}) {
  return input.orgMode === "multi_org"
    && Boolean(input.stripeSecretKey && input.openWorkWebPriceId)
}

export function isOpenWorkWebAvailable() {
  return openWorkWebDeploymentAvailable({
    orgMode: env.orgMode,
    stripeSecretKey: env.stripe.secretKey,
    openWorkWebPriceId: env.stripe.openworkWebPriceId,
  })
}
