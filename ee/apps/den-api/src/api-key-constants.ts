// Kept free of imports on purpose. auth.ts reads these while it loads, and
// api-keys.ts sits in an import cycle with auth.ts (through
// audit/request-capture.ts and session.ts). Whichever of the two Node reaches
// first depends on server.ts import order, so auth.ts must not take these from
// api-keys.ts, or a new import elsewhere can crash startup with
// "Cannot access 'DEN_API_KEY_DEFAULT_PREFIX' before initialization".
export const DEN_API_KEY_HEADER = "x-api-key"
export const DEN_API_KEY_DEFAULT_PREFIX = "den_"
export const DEN_API_KEY_RATE_LIMIT_MAX = 600
export const DEN_API_KEY_RATE_LIMIT_TIME_WINDOW_MS = 60_000
export const DEN_API_KEY_EXPIRES_IN_DAYS = 90
export const DEN_API_KEY_EXPIRES_IN_SECONDS = DEN_API_KEY_EXPIRES_IN_DAYS * 24 * 60 * 60
