export const OPENWORK_WEB_ACCESS_REQUIRED_CODE = "openwork_web_access_required" as const
export const OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE =
  "An active OpenWork Web subscription or complimentary access is required to use OpenWork Cloud."

export class OpenWorkWebAccessRequiredError extends Error {
  readonly code = OPENWORK_WEB_ACCESS_REQUIRED_CODE

  constructor() {
    super(OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE)
    this.name = "OpenWorkWebAccessRequiredError"
  }
}

export function openWorkWebAccessRequiredPayload() {
  return {
    error: OPENWORK_WEB_ACCESS_REQUIRED_CODE,
    message: OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE,
  }
}
