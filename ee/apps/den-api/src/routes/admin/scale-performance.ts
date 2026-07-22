export const ADMIN_DEFAULT_PAGE_LIMIT = 50
export const ADMIN_MAX_PAGE_LIMIT = 100
export const ADMIN_MAX_PAGE_OFFSET = 100000

export type AdminPageRequestInput = {
  limit?: string
  offset?: string
  search?: string
}

export type AdminPageRequest = {
  limit: number
  offset: number
  search: string
}

export type AdminPageInfo = AdminPageRequest & {
  total: number
  returned: number
  hasMore: boolean
  durationMs: number
}

function parseNonNegativeInteger(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback
  }

  return parsed
}

export function normalizeAdminPageRequest(input: AdminPageRequestInput): AdminPageRequest {
  const requestedLimit = parseNonNegativeInteger(input.limit, ADMIN_DEFAULT_PAGE_LIMIT)
  const limit = Math.max(1, Math.min(ADMIN_MAX_PAGE_LIMIT, requestedLimit))

  return {
    limit,
    offset: Math.min(ADMIN_MAX_PAGE_OFFSET, parseNonNegativeInteger(input.offset, 0)),
    search: input.search?.trim().slice(0, 160) ?? "",
  }
}

export function buildAdminPageInfo(request: AdminPageRequest, total: number, returned: number, durationMs: number): AdminPageInfo {
  return {
    ...request,
    total,
    returned,
    durationMs,
    hasMore: request.offset < ADMIN_MAX_PAGE_OFFSET && request.offset + returned < total,
  }
}

export function sanitizeAdminSearchForLike(search: string) {
  return search
    .toLowerCase()
    .replace(/\|/g, "||")
    .replace(/%/g, "|%")
    .replace(/_/g, "|_")
}
