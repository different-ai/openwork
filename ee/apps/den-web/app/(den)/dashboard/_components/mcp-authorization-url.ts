function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "::1") return true
  const octets = normalized.split(".")
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127
}

export function safeMcpAuthorizationUrl(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error("The MCP provider returned an invalid authorization URL.")
  }
  const allowedProtocol = url.protocol === "https:"
    || (url.protocol === "http:" && isLoopbackHostname(url.hostname))
  if (!allowedProtocol || url.username || url.password) {
    throw new Error("The MCP provider returned an unsafe authorization URL.")
  }
  return url.toString()
}
