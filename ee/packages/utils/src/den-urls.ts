export type DenUrlSet = {
  base: string
  web: string
  api: string
  auth: string
  inference: string
  mcp: string
  mcpAgent: string
}

type DenUrlEnvironment = {
  [key: string]: string | undefined
  DEN_BASE_URL?: string
}

const DEFAULT_PROTOCOL = "https:"

function readDenBaseUrl(env: DenUrlEnvironment): string {
  const value = env.DEN_BASE_URL?.trim()
  if (!value) {
    throw new Error("DEN_BASE_URL must be configured.")
  }
  return value
}

function parseDenBaseUrl(value: string): URL {
  const candidate = value.includes("://") ? value : `${DEFAULT_PROTOCOL}//${value}`
  const url = new URL(candidate)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("DEN_BASE_URL must use http or https.")
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("DEN_BASE_URL must be an origin without a path, query, or hash.")
  }
  return url
}

function originFromUrl(url: URL): string {
  return url.origin.replace(/\/+$/, "")
}

function apiUrlFor(baseUrl: URL): URL {
  const apiUrl = new URL(baseUrl.href)
  apiUrl.hostname = `api.${baseUrl.hostname}`
  return apiUrl
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`
}

export function denUrls(env: DenUrlEnvironment = process.env): DenUrlSet {
  const baseUrl = parseDenBaseUrl(readDenBaseUrl(env))
  const web = originFromUrl(baseUrl)
  const api = originFromUrl(apiUrlFor(baseUrl))

  return {
    base: web,
    web,
    api,
    auth: joinUrl(web, "/api/auth"),
    inference: joinUrl(web, "/dashboard/inference"),
    mcp: joinUrl(api, "/mcp"),
    mcpAgent: joinUrl(api, "/mcp/agent"),
  }
}
