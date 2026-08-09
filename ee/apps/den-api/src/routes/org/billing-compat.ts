import { resolveAddon } from "../../billing/addons.js"

export function resolveStripeCheckoutAddonKey(input: {
  addonKey?: string
  type?: "inference" | "seat"
}) {
  return resolveAddon(input.addonKey ?? input.type ?? "inference")?.key ?? null
}
