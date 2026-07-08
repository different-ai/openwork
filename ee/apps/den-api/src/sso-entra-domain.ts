function getMicrosoftTenantId(value: string) {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase()
    if (host !== "sts.windows.net" && host !== "login.microsoftonline.com") {
      return null
    }

    const tenantId = url.pathname.split("/").filter(Boolean)[0]
    return tenantId && /^[0-9a-f-]{36}$/i.test(tenantId) ? tenantId.toLowerCase() : null
  } catch {
    return null
  }
}

export function isMicrosoftEntraManagedDomain(input: { domain: string; issuer: string; entryPoint?: string | null }) {
  return getMicrosoftTenantId(input.issuer) !== null
}
