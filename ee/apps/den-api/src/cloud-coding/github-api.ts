import { createHmac, sign, timingSafeEqual } from "node:crypto"
import { z } from "zod"
import type { CloudCodingAppConfig } from "./config.js"

export class CloudCodingGithubError extends Error {
  constructor(readonly status: number) {
    super("GitHub could not complete the request.")
  }
}

type Config = { config: CloudCodingAppConfig }
type Auth = Config & { token: string }
type Installation = Config & { installationId: number }
type ApiRequest<T> = Auth & {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  body?: unknown
  allowStatuses?: readonly number[]
  schema: z.ZodType<T>
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) })
  } catch {
    throw new CloudCodingGithubError(502)
  }
}

async function decode<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  try {
    const data: unknown = response.status === 204 ? undefined : await response.json()
    return schema.parse(data)
  } catch {
    throw new CloudCodingGithubError(502)
  }
}

function apiHeaders(authorization: string, hasBody: boolean) {
  return {
    Authorization: authorization,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "openwork-den-api",
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  }
}

async function githubResponse(input: Omit<ApiRequest<unknown>, "schema">) {
  const response = await request(`${input.config.apiBaseUrl}${input.path}`, {
    method: input.method ?? "GET",
    headers: apiHeaders(`Bearer ${input.token}`, input.body !== undefined),
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  })
  if (!response.ok && !input.allowStatuses?.includes(response.status)) throw new CloudCodingGithubError(response.status)
  return response
}

export async function cloudCodingGithubRequest<T>(input: ApiRequest<T>): Promise<{ status: number; ok: boolean; data: T | null }> {
  const response = await githubResponse(input)
  return { status: response.status, ok: response.ok, data: response.ok ? await decode(response, input.schema) : null }
}

export function createCloudCodingAppJwt(config: CloudCodingAppConfig, now = Date.now()): string {
  const seconds = Math.floor(now / 1000)
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: config.appId })}`
  try {
    return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), config.privateKey).toString("base64url")}`
  } catch {
    throw new CloudCodingGithubError(502)
  }
}

const installationSchema = z.object({
  id: z.number().int().positive(),
  account: z.object({ id: z.number().int().positive(), login: z.string(), type: z.enum(["Organization", "User"]) }),
  repository_selection: z.enum(["all", "selected"]),
  suspended_at: z.string().datetime({ offset: true }).nullable(),
  html_url: z.string().url(),
})
const repositorySchema = z.object({
  id: z.number().int().positive(), full_name: z.string(), default_branch: z.string(), private: z.boolean(), archived: z.boolean(),
})
const userSchema = z.object({ id: z.number().int().positive(), login: z.string(), name: z.string().nullable() })
const tokenSchema = z.object({
  access_token: z.string().min(1), expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1), refresh_token_expires_in: z.number().int().positive(),
})
export type CloudCodingGithubInstallation = z.infer<typeof installationSchema>
export type CloudCodingGithubRepository = z.infer<typeof repositorySchema>
export type CloudCodingGithubUser = z.infer<typeof userSchema>
export type CloudCodingOAuthToken = z.infer<typeof tokenSchema>

async function get<T>(input: Auth, path: string, schema: z.ZodType<T>): Promise<T> {
  return decode(await githubResponse({ ...input, path }), schema)
}

export async function createInstallationToken(input: Installation & { repositoryIds?: number[]; permissions?: Record<string, "read" | "write"> }): Promise<{ token: string; expiresAt: string }> {
  const response = await githubResponse({
    ...input, token: createCloudCodingAppJwt(input.config), path: `/app/installations/${input.installationId}/access_tokens`, method: "POST",
    body: { repository_ids: input.repositoryIds, permissions: input.permissions },
  })
  const data = await decode(response, z.object({ token: z.string().min(1), expires_at: z.string().datetime({ offset: true }) }))
  return { token: data.token, expiresAt: data.expires_at }
}

export function getInstallation(input: Installation): Promise<CloudCodingGithubInstallation> {
  return get({ ...input, token: createCloudCodingAppJwt(input.config) }, `/app/installations/${input.installationId}`, installationSchema)
}

async function paginate<T>(input: Auth, path: string, schema: z.ZodType<T[]>): Promise<T[]> {
  const entries: T[] = []
  for (let page = 1; ; page++) {
    const response = await githubResponse({ ...input, path: `${path}?per_page=100&page=${page}` })
    entries.push(...await decode(response, schema))
    if (!response.headers.get("link")?.includes('rel="next"')) return entries
  }
}

export function listInstallationRepositories(input: Auth): Promise<CloudCodingGithubRepository[]> {
  return paginate(input, "/installation/repositories", z.object({ repositories: z.array(repositorySchema) }).transform(x => x.repositories))
}

export function listUserInstallations(input: Auth): Promise<CloudCodingGithubInstallation[]> {
  return paginate(input, "/user/installations", z.object({ installations: z.array(installationSchema) }).transform(x => x.installations))
}

export function getRepositoryById(input: Auth & { repositoryId: number }): Promise<CloudCodingGithubRepository> {
  return get(input, `/repositories/${input.repositoryId}`, repositorySchema)
}

export function getRepository(input: Auth & { owner: string; repo: string }): Promise<CloudCodingGithubRepository> {
  return get(input, `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`, repositorySchema)
}

export function getAuthenticatedUser(input: Auth): Promise<CloudCodingGithubUser> {
  return get(input, "/user", userSchema)
}

export function buildAuthorizeUrl({ config, state, redirectUri }: Config & { state: string; redirectUri: string }): string {
  const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri, state })
  return `${config.webBaseUrl}/login/oauth/authorize?${query}`
}

export function buildInstallUrl({ config, state }: Config & { state: string }): string {
  return `${config.webBaseUrl}/apps/${encodeURIComponent(config.slug)}/installations/new?${new URLSearchParams({ state })}`
}

async function oauth(config: CloudCodingAppConfig, params: Record<string, string>): Promise<CloudCodingOAuthToken> {
  const response = await request(`${config.webBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "User-Agent": "openwork-den-api" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...params }),
  })
  if (!response.ok) throw new CloudCodingGithubError(response.status)
  const data = await decode(response, z.union([z.object({ error: z.string() }), tokenSchema]))
  if ("error" in data) throw new CloudCodingGithubError(400)
  return data
}

export function exchangeOAuthCode({ config, code, redirectUri }: Config & { code: string; redirectUri: string }): Promise<CloudCodingOAuthToken> {
  return oauth(config, { code, redirect_uri: redirectUri })
}

export function refreshUserToken({ config, refreshToken }: Config & { refreshToken: string }): Promise<CloudCodingOAuthToken> {
  return oauth(config, { grant_type: "refresh_token", refresh_token: refreshToken })
}

export async function revokeUserToken({ config, accessToken }: Config & { accessToken: string }): Promise<void> {
  const credentials = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")
  const response = await request(`${config.apiBaseUrl}/applications/${encodeURIComponent(config.clientId)}/token`, {
    method: "DELETE", headers: apiHeaders(`Basic ${credentials}`, true), body: JSON.stringify({ access_token: accessToken }),
  })
  if (!response.ok && response.status !== 404 && response.status !== 422) throw new CloudCodingGithubError(response.status)
}

export function verifyCloudCodingGithubSignature(body: string, signature: string, secret: string): boolean {
  if (!/^sha256=[0-9a-f]{64}$/.test(signature)) return false
  const actual = Buffer.from(signature.slice(7), "hex")
  const expected = createHmac("sha256", secret).update(body).digest()
  return timingSafeEqual(actual, expected)
}
