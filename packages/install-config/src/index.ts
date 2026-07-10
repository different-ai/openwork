import { z } from "zod"

export const INSTALL_SIDECAR_FILENAME = "openwork-installer.json"

export const installConfigSchema = z.object({
  appName: z.string().trim().min(1).max(64).default("OpenWork"),
  clientName: z.string().trim().min(1),
  webUrl: z.string().trim().url(),
  apiUrl: z.string().trim().url(),
  requireSignin: z.boolean(),
  logoUrl: z.string().trim().url().nullable(),
}).meta({ ref: "InstallConfig" })

export type InstallConfig = z.infer<typeof installConfigSchema>

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
