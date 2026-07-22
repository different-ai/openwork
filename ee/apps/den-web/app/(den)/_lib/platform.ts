export function isMobileUserAgent(userAgent?: string | null) {
  const value = userAgent ?? (typeof navigator !== "undefined" ? navigator.userAgent : "")
  return /Android|iPhone|iPad|iPod/i.test(value)
}
