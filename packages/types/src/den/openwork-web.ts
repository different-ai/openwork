/**
 * OpenWork Web pricing, shared by den-api (the `/v1/billing/web` offer and the
 * Stripe price check) and den-web (which rejects a summary that does not match
 * these values).
 */
export const OPENWORK_WEB_UNIT_AMOUNT = 5000
export const OPENWORK_WEB_CURRENCY = "usd" as const
export const OPENWORK_WEB_INTERVAL = "month" as const
export const OPENWORK_WEB_QUANTITY_DEFINITION = "joined_non_removed_members" as const
