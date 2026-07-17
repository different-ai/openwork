/**
 * Protected resources may advertise their HTTP(S) origin as an OAuth discovery
 * alias with or without the otherwise equivalent trailing root slash.
 *
 * This intentionally does not normalize non-root paths, query strings, or
 * fragments, and must not be used for authorization-response issuer checks.
 */
export function isEquivalentOAuthResourceAlias(left: string | undefined, right: string | undefined): boolean {
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
