export const OPENWORK_WEB_ACCESS_REQUIRED_CODE = "openwork_web_access_required" as const
export const OPENWORK_WEB_ACCESS_REQUIRED_MESSAGE =
  "OpenWork Cloud needs OpenWork Web: an active subscription or complimentary access for the organization, turned on for you if an admin chooses who gets Web."

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
