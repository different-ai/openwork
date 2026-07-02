import { BUILD_API_URL, BUILD_CLIENT_NAME, BUILD_LOGO_URL, BUILD_REQUIRE_SIGNIN, BUILD_WEB_URL } from "./generated/build-config"

export type InstallerConfig = {
  clientName: string
  /** Den web origin — becomes `baseUrl` in desktop-bootstrap.json. */
  webUrl: string
  /** Den API origin — becomes `apiBaseUrl` in desktop-bootstrap.json. */
  apiUrl: string
  /** Optional client logo (png/svg URL) shown in the installer UI. */
  logoUrl: string | null
  requireSignin: boolean
}

function normalizeUrl(value: string, label: string): string {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (!trimmed) throw new Error(`${label} is required`)
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    throw new Error(`${label} must start with http:// or https:// (got ${trimmed})`)
  }
  new URL(trimmed)
  return trimmed
}

/**
 * Build-time constants win unless an OPENWORK_INSTALLER_* env override is set;
 * the overrides exist for local development and CI smoke tests.
 */
export function resolveInstallerConfig(env: NodeJS.ProcessEnv = process.env): InstallerConfig {
  const clientName = env.OPENWORK_INSTALLER_CLIENT_NAME?.trim() || BUILD_CLIENT_NAME.trim()
  const webUrl = env.OPENWORK_INSTALLER_WEB_URL?.trim() || BUILD_WEB_URL
  const apiUrl = env.OPENWORK_INSTALLER_API_URL?.trim() || BUILD_API_URL
  const logoUrl = env.OPENWORK_INSTALLER_LOGO_URL?.trim() || BUILD_LOGO_URL.trim()
  const requireSignin = env.OPENWORK_INSTALLER_REQUIRE_SIGNIN !== undefined
    ? env.OPENWORK_INSTALLER_REQUIRE_SIGNIN === "1" || env.OPENWORK_INSTALLER_REQUIRE_SIGNIN === "true"
    : BUILD_REQUIRE_SIGNIN

  if (!clientName) throw new Error("client name is required (build-config or OPENWORK_INSTALLER_CLIENT_NAME)")
  return {
    clientName,
    webUrl: normalizeUrl(webUrl, "web URL"),
    apiUrl: normalizeUrl(apiUrl, "API URL"),
    logoUrl: logoUrl ? normalizeUrl(logoUrl, "logo URL") : null,
    requireSignin,
  }
}
