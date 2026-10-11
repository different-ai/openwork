export function calendarDefaultModelQueryKey(baseUrl: string, organizationId: string | null, principalId: string | null) {
  return ["den", "calendar-default-model", baseUrl, organizationId, principalId]
}

/** A denied revalidation must never keep displaying the last permitted response. */
export function visibleCalendarDefaultModelName(input: {
  verified: boolean
  fetching: boolean
  failed: boolean
  name: string | null | undefined
}) {
  return input.verified && !input.fetching && !input.failed ? input.name : undefined
}
