import { generateKeyPairSync, randomUUID, verify } from "node:crypto"
import type { ServerResponse } from "node:http"
import { z } from "zod"
import type { CloudCodingGithubInstallation, CloudCodingGithubRepository, CloudCodingGithubUser } from "../../src/cloud-coding/github-api.js"
import { startFakeHttpServer, type FakeHandler } from "./harness.js"

type FakeInstallation = CloudCodingGithubInstallation & { repositoryIds: number[] }
type FakeUser = CloudCodingGithubUser & { installationIds: number[]; writableRepositoryIds?: number[] }
type Credential = { userId: number; accessToken: string; refreshToken: string; accessExpiresAt: number; refreshExpiresAt: number }
type InstallationCredential = { installationId: number; repositoryIds?: number[]; permissions?: Record<string, "read" | "write">; expiresAt: number }
export type FakeGithubState = {
  installations: Map<number, FakeInstallation>
  users: Map<number, FakeUser>
  repositories: Map<number, CloudCodingGithubRepository>
  codes: Map<string, number>
  userTokens: Map<string, Credential>
  installationTokens: Map<string, InstallationCredential>
  revoked: string[]
  codeExchanges: number
  lastCodeExchangeRedirectUri: string | null
  refreshes: number
  rejectRefresh: boolean
  accessTokenLifetimeSeconds: number
  pageSize: number
}

const tokenRequest = z.object({ repository_ids: z.array(z.number()).optional(), permissions: z.record(z.string(), z.enum(["read", "write"])).optional() })
const revokeRequest = z.object({ access_token: z.string() })
const jwtHeader = z.object({ alg: z.literal("RS256") })
const jwtClaims = z.object({ iss: z.string(), exp: z.number(), iat: z.number() })

function json(response: ServerResponse, status: number, data?: unknown) {
  response.statusCode = status
  response.setHeader("content-type", "application/json")
  response.end(data === undefined ? undefined : JSON.stringify(data))
}

export type FakeGithubExtension = (input: { url: URL; request: Parameters<FakeHandler>[0]; raw: string; response: ServerResponse; user: FakeUser | undefined; installation: InstallationCredential | undefined; allowedIds: number[]; state: FakeGithubState }) => boolean | Promise<boolean>

export async function startFakeGithub({ extend }: { extend?: FakeGithubExtension } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString()
  const appId = "42"
  const clientId = "acme-cloud-coding"
  const clientSecret = "acme-fake-client-secret"
  const webhookSecret = "acme-fake-webhook-secret"
  const state: FakeGithubState = {
    installations: new Map(), users: new Map(), repositories: new Map(), codes: new Map(), userTokens: new Map(),
    installationTokens: new Map(), revoked: [], codeExchanges: 0, lastCodeExchangeRedirectUri: null, refreshes: 0, rejectRefresh: false, accessTokenLifetimeSeconds: 28_800, pageSize: 100,
  }

  function validJwt(token: string) {
    const [header, claims, signature, extra] = token.split(".")
    if (!header || !claims || !signature || extra !== undefined) return false
    try {
      jwtHeader.parse(JSON.parse(Buffer.from(header, "base64url").toString("utf8")))
      const data = jwtClaims.parse(JSON.parse(Buffer.from(claims, "base64url").toString("utf8")))
      const now = Math.floor(Date.now() / 1000)
      return data.iss === appId && data.iat <= now && data.exp > now && data.exp <= now + 600
        && verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url"))
    } catch { return false }
  }

  function issue(userId: number) {
    const now = Date.now()
    const credential = { userId, accessToken: `ghu_${randomUUID()}`, refreshToken: `ghr_${randomUUID()}`, accessExpiresAt: now + state.accessTokenLifetimeSeconds * 1000, refreshExpiresAt: now + 90 * 24 * 60 * 60_000 }
    state.userTokens.set(credential.accessToken, credential)
    return { access_token: credential.accessToken, expires_in: state.accessTokenLifetimeSeconds, refresh_token: credential.refreshToken, refresh_token_expires_in: (credential.refreshExpiresAt - now) / 1000 }
  }

  function page<T>(url: URL, response: ServerResponse, values: T[]) {
    const current = Math.max(1, Number(url.searchParams.get("page")) || 1)
    const size = Math.min(Number(url.searchParams.get("per_page")) || 30, state.pageSize)
    if (current * size < values.length) {
      url.searchParams.set("page", String(current + 1))
      response.setHeader("Link", `<${url}>; rel="next"`)
    }
    return values.slice((current - 1) * size, current * size)
  }

  const handle: FakeHandler = async (request, raw, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`)
    const { pathname } = url
    const method = request.method
    const token = request.headers.authorization?.replace(/^Bearer /, "") ?? ""
    const notFound = () => json(response, 404, { message: "Not found" })
    if (pathname === "/login/oauth/access_token" && method === "POST") {
      const params = new URLSearchParams(raw)
      if (params.get("client_id") !== clientId || params.get("client_secret") !== clientSecret) return json(response, 200, { error: "incorrect_client_credentials" })
      if (params.get("grant_type") === "refresh_token") {
        state.refreshes++
        const current = [...state.userTokens.values()].find(row => row.refreshToken === params.get("refresh_token"))
        if (state.rejectRefresh || !current || current.refreshExpiresAt <= Date.now()) return json(response, 200, { error: "bad_refresh_token" })
        state.userTokens.delete(current.accessToken)
        return json(response, 200, issue(current.userId))
      }
      state.codeExchanges++
      state.lastCodeExchangeRedirectUri = params.get("redirect_uri")
      const code = params.get("code") ?? ""
      const userId = state.codes.get(code)
      if (!userId) return json(response, 200, { error: "bad_verification_code" })
      state.codes.delete(code)
      return json(response, 200, issue(userId))
    }
    if (pathname === `/applications/${clientId}/token` && method === "DELETE") {
      if (request.headers.authorization !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`) return json(response, 401)
      const input = revokeRequest.parse(JSON.parse(raw))
      state.revoked.push(input.access_token)
      return json(response, state.userTokens.delete(input.access_token) ? 204 : 404)
    }
    if (pathname.startsWith("/app/")) {
      if (!validJwt(token)) return json(response, 401)
      const route = /^\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(pathname)
      const installationId = Number(route?.[1])
      const installed = state.installations.get(installationId)
      if (!installed) return notFound()
      if (!route?.[2] && method === "GET") return json(response, 200, installed)
      if (route?.[2] && method === "POST") {
        const { repository_ids: repositoryIds, permissions } = tokenRequest.parse(JSON.parse(raw))
        if (installed.suspended_at) return json(response, 403)
        if (repositoryIds?.some(id => !installed.repositoryIds.includes(id))) return notFound()
        const access = `ghs_${randomUUID()}`
        const expiresAt = Date.now() + 3_600_000
        state.installationTokens.set(access, { installationId, repositoryIds, permissions, expiresAt })
        return json(response, 201, { token: access, expires_at: new Date(expiresAt).toISOString() })
      }
      return notFound()
    }
    const userCredential = state.userTokens.get(token)
    const user = userCredential && userCredential.accessExpiresAt > Date.now() ? state.users.get(userCredential.userId) : undefined
    if (method === "GET" && (pathname === "/user" || pathname === "/user/installations")) {
      if (!user) return json(response, 401)
      if (pathname === "/user") return json(response, 200, user)
      const installations = user.installationIds.flatMap(id => { const row = state.installations.get(id); return row ? [row] : [] })
      return json(response, 200, { total_count: installations.length, installations: page(url, response, installations) })
    }
    const installationCredential = state.installationTokens.get(token)
    const installed = installationCredential && installationCredential.expiresAt > Date.now() ? state.installations.get(installationCredential.installationId) : undefined
    const allowedIds = installed && !installed.suspended_at ? installed.repositoryIds.filter(id => installationCredential?.repositoryIds?.includes(id) ?? true)
      : user?.installationIds.flatMap(id => state.installations.get(id)?.repositoryIds ?? []) ?? []
    const repositories = allowedIds.flatMap(id => { const row = state.repositories.get(id); return row ? [row] : [] })
    if (method === "GET" && pathname === "/installation/repositories") {
      if (!installed) return json(response, 401)
      return json(response, 200, { total_count: repositories.length, repositories: page(url, response, repositories) })
    }
    if (method === "GET" && (pathname.startsWith("/repositories/") || pathname.startsWith("/repos/"))) {
      const repo = pathname.startsWith("/repositories/") ? repositories.find(row => row.id === Number(pathname.slice(14)))
        : repositories.find(row => row.full_name.toLowerCase() === decodeURIComponent(pathname.slice(7)).toLowerCase())
      if (repo) return json(response, 200, repo)
    }
    if (extend && await extend({ url, request, raw, response, user, installation: installed ? installationCredential : undefined, allowedIds, state })) return
    return notFound()
  }

  const server = await startFakeHttpServer(handle)
  const env = {
    GITHUB_CLOUD_CODING_APP_ID: appId, GITHUB_CLOUD_CODING_APP_SLUG: "acme-cloud-coding", GITHUB_CLOUD_CODING_APP_CLIENT_ID: clientId,
    GITHUB_CLOUD_CODING_APP_CLIENT_SECRET: clientSecret, GITHUB_CLOUD_CODING_APP_PRIVATE_KEY: privateKeyPem,
    GITHUB_CLOUD_CODING_APP_WEBHOOK_SECRET: webhookSecret, GITHUB_CLOUD_CODING_API_BASE: server.url, GITHUB_CLOUD_CODING_WEB_BASE: server.url,
  }
  return {
    ...server, state, env, privateKeyPem, webhookSecret,
    issueCode(userId: number): string { const code = randomUUID(); state.codes.set(code, userId); return code },
    addUser(user: FakeUser): void { state.users.set(user.id, user) },
    addRepository(repository: CloudCodingGithubRepository): void { state.repositories.set(repository.id, repository) },
    addInstallation(installed: FakeInstallation): void { state.installations.set(installed.id, installed) },
  }
}
