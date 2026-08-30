import { z } from "zod"

export const DESKTOP_BOOTSTRAP_FILENAME = "desktop-bootstrap.json"

export const installConfigSchema = z.object({
  appName: z.string().trim().min(1).max(64).default("OpenWork"),
  clientName: z.string().trim().min(1),
  webUrl: z.string().trim().url(),
  apiUrl: z.string().trim().url(),
  requireSignin: z.boolean(),
  logoUrl: z.string().trim().url().nullable(),
  iconUrl: z.string().trim().url().nullable().default(null),
}).meta({ ref: "InstallConfig" })

export type InstallConfig = z.infer<typeof installConfigSchema>

export const installExperienceConfigSchema = installConfigSchema.extend({
  connectUrl: z.string().trim().min(1),
  connectExpiresAt: z.string().datetime(),
  activationUrl: z.string().trim().url(),
  activationExpiresAt: z.string().datetime(),
  desktopVersion: z.string().trim().min(1),
  distribution: z.enum(["cloud", "enterprise"]),
}).meta({ ref: "InstallExperienceConfig" })

export type InstallExperienceConfig = z.infer<typeof installExperienceConfigSchema>

export const desktopBootstrapConfigSchema = z.object({
  baseUrl: z.string().trim().url(),
  apiBaseUrl: z.string().trim().url().optional(),
  requireSignin: z.boolean(),
  requireActivation: z.boolean().optional(),
  brandAppName: z.string().trim().min(1).max(64).optional(),
  brandLogoUrl: z.string().trim().url().optional(),
  brandIconUrl: z.string().trim().url().optional(),
  writtenAt: z.string().datetime(),
}).meta({ ref: "DesktopBootstrapConfig" })

export type DesktopBootstrapConfig = z.infer<typeof desktopBootstrapConfigSchema>

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/

function isAsciiLetterOrDigit(code: number) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
}

function isInstallTokenCharacter(code: number) {
  return isAsciiLetterOrDigit(code) || code === 95 || code === 45
}

function isFilenameHost(value: string) {
  const portSeparator = value.indexOf("_")
  const hostnameEnd = portSeparator === -1 ? value.length : portSeparator
  if (hostnameEnd === 0) return false
  for (let index = 0; index < hostnameEnd; index += 1) {
    const code = value.charCodeAt(index)
    if (!isAsciiLetterOrDigit(code) && code !== 46 && code !== 45) return false
  }
  if (portSeparator === -1) return true
  if (portSeparator === value.length - 1) return false
  for (let index = portSeparator + 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 48 || code > 57) return false
  }
  return true
}

function filenameHostPriority(value: string) {
  const normalized = value.toLowerCase()
  return value.includes(".") || value.includes("_") || normalized === "localhost" || normalized.startsWith("xn--")
    ? 1
    : 0
}

function trimTrailingSlashes(value: string) {
  let end = value.length
  while (end > 0 && value[end - 1] === "/") end -= 1
  return end === value.length ? value : value.slice(0, end)
}

function decodeFilenameHost(value: string) {
  return value.replace(/_(\d+)$/, ":$1")
}

function usesLocalHttp(host: string) {
  const normalized = host.toLowerCase()
  return normalized === "localhost" || normalized.startsWith("localhost:") || normalized === "127.0.0.1" || normalized.startsWith("127.")
}

export function parseInstallerFilenameTag(fileName: string): { host: string; token: string } | null {
  const trimmed = fileName.trim()
  const tokenEnd = trimmed.endsWith(".exe") ? trimmed.length - 4 : trimmed.length
  for (let index = 0; index < tokenEnd; index += 1) {
    const code = trimmed.charCodeAt(index)
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) return null
  }

  let tokenCharactersStart = tokenEnd
  while (tokenCharactersStart > 0 && isInstallTokenCharacter(trimmed.charCodeAt(tokenCharactersStart - 1))) {
    tokenCharactersStart -= 1
  }

  let prefixEnd = -1
  let hostLabelStart = 0
  let candidateHost: string | null = null
  let candidateTokenStart = -1
  let candidatePriority = -1
  let ambiguous = false
  for (let hostEnd = 0; hostEnd + 1 < tokenEnd; hostEnd += 1) {
    if (trimmed.charCodeAt(hostEnd) !== 45 || trimmed.charCodeAt(hostEnd + 1) !== 45) {
      if (prefixEnd >= 1 && trimmed.charCodeAt(hostEnd) === 46) hostLabelStart = hostEnd + 1
      continue
    }

    if (
      prefixEnd >= 1 &&
      hostEnd - hostLabelStart === 2 &&
      trimmed.slice(hostLabelStart, hostEnd).toLowerCase() === "xn"
    ) {
      hostEnd += 1
      continue
    }

    const tokenStart = hostEnd + 2
    if (prefixEnd >= 1 && tokenEnd - tokenStart >= 8 && tokenStart >= tokenCharactersStart) {
      const encodedHost = trimmed.slice(prefixEnd + 2, hostEnd)
      if (isFilenameHost(encodedHost)) {
        const priority = filenameHostPriority(encodedHost)
        if (priority > candidatePriority) {
          candidateHost = encodedHost
          candidateTokenStart = tokenStart
          candidatePriority = priority
          ambiguous = false
        } else if (priority === candidatePriority) {
          ambiguous = true
        }
      }
    }

    prefixEnd = hostEnd
    hostLabelStart = hostEnd + 2
    hostEnd += 1
  }

  if (!candidateHost || ambiguous) return null
  return { host: decodeFilenameHost(candidateHost), token: trimmed.slice(candidateTokenStart, tokenEnd) }
}

export function installConfigUrlFor(host: string, token: string) {
  const normalizedHost = trimTrailingSlashes(decodeFilenameHost(host.trim()).replace(/^https?:\/\//, ""))
  const protocol = usesLocalHttp(normalizedHost) ? "http" : "https"
  const url = new URL(`/v1/install-config?token=${encodeURIComponent(token)}`, `${protocol}://${normalizedHost}`)
  return url.toString()
}

function configUrlFromInstallLink(input: URL) {
  const token = input.searchParams.get("token")?.trim() ?? ""
  if (!TOKEN_PATTERN.test(token)) {
    return null
  }
  if (input.protocol !== "https:" && !(input.protocol === "http:" && usesLocalHttp(input.host))) {
    return null
  }

  const pathname = input.pathname.replace(/\/+$/, "")
  if (pathname === "/v1/install-config") {
    return { url: input.toString(), token, host: input.host }
  }
  if (pathname === "/install") {
    const url = new URL(`/api/den/v1/install-config?token=${encodeURIComponent(token)}`, input.origin)
    return { url: url.toString(), token, host: input.host }
  }

  return null
}

export function parseInstallLinkInput(input: string): { url: string; host: string; token: string } | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = configUrlFromInstallLink(new URL(trimmed))
    if (parsed) {
      return parsed
    }
  } catch {
    // Fall through to the simple "host token" form.
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 2 || !TOKEN_PATTERN.test(parts[1])) {
    return null
  }

  const hostInput = parts[0]
  try {
    const url = hostInput.startsWith("http://") || hostInput.startsWith("https://")
      ? new URL(hostInput)
      : new URL(`https://${hostInput}`)
    return { url: installConfigUrlFor(url.host, parts[1]), host: url.host, token: parts[1] }
  } catch {
    return null
  }
}
