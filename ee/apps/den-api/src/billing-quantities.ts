/**
 * How many users each OpenWork subscription bills for. Pure: no database or
 * Stripe access, so every caller (member-change hooks, checkout, the billing
 * summary, the admin panel and seeds) computes quantities the same way.
 *
 * Users are the people in an organization: joined members plus pending
 * invitations that have not expired. Removed members, expired invitations and
 * the setup agent never count. See countBillingUsersForOrganizations().
 *
 * Team seats, OpenWork Models and OpenWork Web all bill that same number of
 * users. The Free plan allows up to its free seats (5, or more if a platform
 * admin raised it); past that, the organization must upgrade to the Team plan,
 * which bills every user. An organization may upgrade at any size.
 */

export const FREE_ORG_SEAT_COUNT = 5

/** What the OpenWork Web quantity counts, reported to clients with the billing summary. */
export const OPENWORK_WEB_QUANTITY_DEFINITION = "members_and_pending_invitations" as const

export type OrganizationBillingQuantities = {
  users: number
  seats: {
    total: number
    free: number
    includedFree: number
    additionalFree: number
    /** Quantity on the Stripe seat (Team plan) subscription: every user. */
    chargeable: number
  }
  models: {
    /** Users the OpenWork Models subscription bills for (shown on the billing page). */
    users: number
    /** Quantity on the Stripe OpenWork Models subscription: Stripe needs at least 1. */
    quantity: number
  }
  web: {
    /** Quantity on the Stripe OpenWork Web subscription. */
    quantity: number
  }
}

export function normalizeUserCount(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

export function normalizeAdditionalFreeSeats(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0
}

export function additionalFreeSeatCountFromMetadata(metadata: Record<string, unknown> | null | undefined) {
  return normalizeAdditionalFreeSeats(metadata?.seatsFreeAdditional)
}

export function calculateOrganizationBillingQuantities(input: {
  users: number
  metadata?: Record<string, unknown> | null
  additionalFreeSeats?: number
}): OrganizationBillingQuantities {
  const users = normalizeUserCount(input.users)
  const additionalFree = input.additionalFreeSeats === undefined
    ? additionalFreeSeatCountFromMetadata(input.metadata)
    : normalizeAdditionalFreeSeats(input.additionalFreeSeats)
  const free = FREE_ORG_SEAT_COUNT + additionalFree

  return {
    users,
    seats: {
      total: users,
      free,
      includedFree: FREE_ORG_SEAT_COUNT,
      additionalFree,
      chargeable: users,
    },
    models: {
      users,
      quantity: Math.max(1, users),
    },
    web: {
      quantity: users,
    },
  }
}

/**
 * Whether one more user may be added without a seat subscription: only while
 * the workspace stays within its free seats.
 */
export function canAddUserWithoutSeatSubscription(seats: { total: number; free: number }) {
  return seats.total < seats.free
}

