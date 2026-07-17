/**
 * OAuth discovery documents may advertise the same HTTP(S) root URL with or
 * without its trailing slash. Exact non-root identifiers remain valid, but
 * non-root paths, query strings, and fragments are never normalized.
 *
 * This is only for binding discovery metadata. Authorization-response issuer
 * checks must continue comparing the canonical metadata issuer exactly.
 */
export function isEquivalentOAuthDiscoveryAlias(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false
  if (left === right) return true

  try {
    const leftUrl = new URL(left)
    const rightUrl = new URL(right)
    const supportedProtocol = (protocol: string) => protocol === "http:" || protocol === "https:"
    if (!supportedProtocol(leftUrl.protocol) || !supportedProtocol(rightUrl.protocol)) return false
    if (leftUrl.search || rightUrl.search || leftUrl.hash || rightUrl.hash) return false
    return leftUrl.origin === rightUrl.origin
      && leftUrl.pathname === "/"
      && rightUrl.pathname === "/"
  } catch {
    return false
  }
}
