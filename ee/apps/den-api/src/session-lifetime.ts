export const DEN_SESSION_EXPIRES_IN_DAYS = 7
export const DEN_SESSION_EXPIRES_IN_SECONDS = DEN_SESSION_EXPIRES_IN_DAYS * 24 * 60 * 60
export const DEN_SESSION_UPDATE_AGE_IN_SECONDS = 24 * 60 * 60

const MILLISECONDS_PER_SECOND = 1_000

export function getDenSessionExpiresAt(now = new Date()) {
  return new Date(now.getTime() + DEN_SESSION_EXPIRES_IN_SECONDS * MILLISECONDS_PER_SECOND)
}

export function getDenSessionRefreshCutoff(now = new Date()) {
  const refreshAfterSeconds = DEN_SESSION_EXPIRES_IN_SECONDS - DEN_SESSION_UPDATE_AGE_IN_SECONDS
  return new Date(now.getTime() + refreshAfterSeconds * MILLISECONDS_PER_SECOND)
}
