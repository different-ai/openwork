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
const FILENAME_TAG_PATTERN = /^.+--([A-Za-z0-9.-]+(?:_[0-9]+)?)--([A-Za-z0-9_-]{8,})(?:\.exe)?$/

function decodeFilenameHost(value: string) {
  return value.replace(/_(\d+)$/, ":$1")
}

function usesLocalHttp(host: string) {
  const normalized = host.toLowerCase()
  return normalized === "localhost" || normalized.startsWith("localhost:") || normalized === "127.0.0.1" || normalized.startsWith("127.")
}

export function parseInstallerFilenameTag(fileName: string): { host: string; token: string } | null {
  const trimmed = fileName.trim()
  const match = FILENAME_TAG_PATTERN.exec(trimmed)
  if (!match) {
    return null
  }

  const host = decodeFilenameHost(match[1])
  const token = match[2]
  if (!TOKEN_PATTERN.test(token)) {
    return null
  }

  return { host, token }
}

export function installConfigUrlFor(host: string, token: string) {
  const normalizedHost = decodeFilenameHost(host.trim()).replace(/^https?:\/\//, "").replace(/\/+$/, "")
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
