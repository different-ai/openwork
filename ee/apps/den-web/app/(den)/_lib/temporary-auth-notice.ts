export const TEMPORARY_AUTH_NOTICE_EXPIRES_AT = Date.parse("2026-09-01T12:00:00.000Z");

export function shouldShowTemporaryAuthNotice(now = Date.now()) {
  return now < TEMPORARY_AUTH_NOTICE_EXPIRES_AT;
}
