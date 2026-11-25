export const FREE_ORG_SEAT_COUNT = 5

export const OPENWORK_WEB_QUANTITY_DEFINITION = "members_and_pending_invitations" as const

export type OrganizationBillingQuantities = {
  users: number
  seats: {
    total: number
    free: number
    includedFree: number
    additionalFree: number
    chargeable: number
  }
  models: {
    users: number
    quantity: number
  }
  web: {
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
  webUsers?: number
  metadata?: Record<string, unknown> | null
  additionalFreeSeats?: number
}): OrganizationBillingQuantities {
  const users = normalizeUserCount(input.users)
  const webUsers = input.webUsers === undefined ? users : Math.min(users, normalizeUserCount(input.webUsers))
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
      quantity: webUsers,
    },
  }
}

export function canAddUserWithoutSeatSubscription(seats: { total: number; free: number }) {
  return seats.total < seats.free
}

