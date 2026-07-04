import { installConfigSchema, installConfigUrlFor, INSTALL_SIDECAR_FILENAME, parseInstallerFilenameTag, type InstallConfig } from "@openwork/install-config"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { BUILD_API_URL, BUILD_CLIENT_NAME, BUILD_LOGO_URL, BUILD_REQUIRE_SIGNIN, BUILD_WEB_URL } from "./generated/build-config"
import type { InstallerConfig } from "./config"

export type InstallerConfigSource = "env" | "sidecar" | "filename" | "build" | "install-link"

export type InstallerConfigResolution = {
  config: InstallerConfig
  source: InstallerConfigSource
}

type ConfigSourceOptions = {
  env?: NodeJS.ProcessEnv
  execPath?: string
  fetcher?: typeof fetch
  warn?: (message: string) => void
}

type ResolveOptions = ConfigSourceOptions & {
  installLink?: string | null
}

const INSTALL_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/

export class InstallerConfigMissingError extends Error {
  constructor() {
    super("Installer is not configured. Paste an OpenWork install link, or run with --install-link <url>.")
    this.name = "InstallerConfigMissingError"
  }
}

function warn(options: ConfigSourceOptions | undefined, message: string) {
  const logger = options?.warn ?? console.warn
  logger(`[openwork-installer] ${message}`)
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

function toInstallerConfig(config: InstallConfig): InstallerConfig {
  return {
    clientName: config.clientName.trim(),
    webUrl: normalizeUrl(config.webUrl, "web URL"),
    apiUrl: normalizeUrl(config.apiUrl, "API URL"),
    logoUrl: config.logoUrl ? normalizeUrl(config.logoUrl, "logo URL") : null,
    requireSignin: config.requireSignin,
  }
}

function parseConfigPayload(payload: unknown, label: string, options?: ConfigSourceOptions): InstallerConfig | null {
  const parsed = installConfigSchema.safeParse(payload)
  if (!parsed.success) {
    warn(options, `${label} did not contain a valid OpenWork install config.`)
    return null
  }
  return toInstallerConfig(parsed.data)
}

function readJsonConfigFile(filePath: string, options?: ConfigSourceOptions) {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"))
    return parseConfigPayload(parsed, filePath, options)
  } catch (error) {
    warn(options, `Could not read ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function parseRequireSignin(value: string | undefined, fallback: boolean) {
  if (value === undefined) {
    return fallback
  }
  return value === "1" || value.toLowerCase() === "true"
}

export function envOverrides(env: NodeJS.ProcessEnv = process.env): InstallerConfig | null {
  const clientName = env.OPENWORK_INSTALLER_CLIENT_NAME?.trim() ?? ""
  const webUrl = env.OPENWORK_INSTALLER_WEB_URL?.trim() ?? ""
  const apiUrl = env.OPENWORK_INSTALLER_API_URL?.trim() ?? ""
  const logoUrl = env.OPENWORK_INSTALLER_LOGO_URL?.trim() ?? ""
  const hasEnvOverride = Boolean(clientName || webUrl || apiUrl || logoUrl || env.OPENWORK_INSTALLER_REQUIRE_SIGNIN !== undefined)

  if (!hasEnvOverride) {
    return null
  }
  if (!clientName || !webUrl || !apiUrl) {
    throw new Error("OPENWORK_INSTALLER_CLIENT_NAME, OPENWORK_INSTALLER_WEB_URL, and OPENWORK_INSTALLER_API_URL are required when using installer env overrides")
  }

  return {
    clientName,
    webUrl: normalizeUrl(webUrl, "web URL"),
    apiUrl: normalizeUrl(apiUrl, "API URL"),
    logoUrl: logoUrl ? normalizeUrl(logoUrl, "logo URL") : null,
    requireSignin: parseRequireSignin(env.OPENWORK_INSTALLER_REQUIRE_SIGNIN, BUILD_REQUIRE_SIGNIN),
  }
}

function appBundleSidecarPath(execPath: string) {
  const match = /(.*)\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.exec(execPath)
  return match ? path.join(match[1], INSTALL_SIDECAR_FILENAME) : null
}

export function readSidecarConfig(options: ConfigSourceOptions = {}): InstallerConfig | null {
  const execPath = options.execPath ?? process.execPath
  const sidecarPaths = [
    path.join(path.dirname(execPath), INSTALL_SIDECAR_FILENAME),
    appBundleSidecarPath(execPath),
  ].filter((value): value is string => Boolean(value))

  for (const sidecarPath of sidecarPaths) {
    if (!existsSync(sidecarPath)) {
      continue
    }
    const config = readJsonConfigFile(sidecarPath, options)
    if (config) {
      return config
    }
  }

  return null
}

function localHostAllowsHttp(host: string) {
  const normalized = host.toLowerCase()
  return normalized === "localhost" || normalized.startsWith("localhost:") || normalized === "127.0.0.1" || normalized.startsWith("127.")
}

function configUrlFromUrl(input: URL) {
  const token = input.searchParams.get("token")?.trim() ?? ""
  if (!INSTALL_LINK_TOKEN_PATTERN.test(token)) {
    return null
  }
  if (input.protocol !== "https:" && !(input.protocol === "http:" && localHostAllowsHttp(input.host))) {
    return null
  }

  if (input.pathname.replace(/\/+$/, "") === "/v1/install-config") {
    return { url: input.toString(), token, host: input.host }
  }
  if (input.pathname.replace(/\/+$/, "") === "/install") {
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
    const parsed = configUrlFromUrl(new URL(trimmed))
    if (parsed) {
      return parsed
    }
  } catch {
    // Fall through to the simple "host token" form.
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 2 || !INSTALL_LINK_TOKEN_PATTERN.test(parts[1])) {
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

async function fetchInstallConfig(configUrl: string, options?: ConfigSourceOptions) {
  const fetcher = options?.fetcher ?? fetch
  const response = await fetcher(configUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    warn(options, `Install config request failed (${response.status} ${response.statusText}).`)
    return null
  }
  const payload: unknown = await response.json()
  return parseConfigPayload(payload, configUrl, options)
}

export async function filenameTagConfig(options: ConfigSourceOptions = {}): Promise<InstallerConfig | null> {
  const execPath = options.execPath ?? process.execPath
  const tag = parseInstallerFilenameTag(path.basename(execPath))
  if (!tag) {
    return null
  }

  return fetchInstallConfig(installConfigUrlFor(tag.host, tag.token), options)
}

export async function installLinkConfig(input: string, options: ConfigSourceOptions = {}): Promise<InstallerConfig | null> {
  const parsed = parseInstallLinkInput(input)
  if (!parsed) {
    return null
  }
  return fetchInstallConfig(parsed.url, options)
}

export function buildConstantsConfig(): InstallerConfig | null {
  const clientName = BUILD_CLIENT_NAME.trim()
  const webUrl = BUILD_WEB_URL.trim()
  const apiUrl = BUILD_API_URL.trim()
  const logoUrl = BUILD_LOGO_URL.trim()
  if (!clientName || !webUrl || !apiUrl) {
    return null
  }

  return {
    clientName,
    webUrl: normalizeUrl(webUrl, "web URL"),
    apiUrl: normalizeUrl(apiUrl, "API URL"),
    logoUrl: logoUrl ? normalizeUrl(logoUrl, "logo URL") : null,
    requireSignin: BUILD_REQUIRE_SIGNIN,
  }
}

export function installerConfigSourceLabel(source: InstallerConfigSource) {
  switch (source) {
    case "env":
      return "environment overrides"
    case "build":
      return "built-in deployment config"
    case "sidecar":
    case "filename":
    case "install-link":
      return "install link"
  }
}

export async function resolveInstallerConfig(options: ResolveOptions = {}): Promise<InstallerConfigResolution> {
  const envConfig = envOverrides(options.env ?? process.env)
  if (envConfig) {
    return { config: envConfig, source: "env" }
  }

  const sidecarConfig = readSidecarConfig(options)
  if (sidecarConfig) {
    return { config: sidecarConfig, source: "sidecar" }
  }

  const filenameConfig = await filenameTagConfig(options)
  if (filenameConfig) {
    return { config: filenameConfig, source: "filename" }
  }

  const buildConfig = buildConstantsConfig()
  if (buildConfig) {
    return { config: buildConfig, source: "build" }
  }

  if (options.installLink) {
    const linkConfig = await installLinkConfig(options.installLink, options)
    if (linkConfig) {
      return { config: linkConfig, source: "install-link" }
    }
  }

  throw new InstallerConfigMissingError()
}

export async function resolveOptionalInstallerConfig(options: ResolveOptions = {}): Promise<InstallerConfigResolution | null> {
  try {
    return await resolveInstallerConfig(options)
  } catch (error) {
    if (error instanceof InstallerConfigMissingError) {
      return null
    }
    throw error
  }
}
