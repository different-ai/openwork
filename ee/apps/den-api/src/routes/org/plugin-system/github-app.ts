import { createHmac, createSign, randomUUID, timingSafeEqual } from "node:crypto"

export class GithubConnectorConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GithubConnectorConfigError"
  }
}

export class GithubConnectorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = "GithubConnectorRequestError"
  }
}

export type GithubConnectorAppConfig = {
  appId: string
  clientId?: string
  clientSecret?: string
  privateKey: string
}

type GithubFetch = typeof fetch

export type GithubManifestKind = "marketplace" | "plugin" | null

type GithubRepositorySummary = {
  defaultBranch: string | null
  fullName: string
  hasPluginManifest?: boolean
  id: number
  manifestKind?: GithubManifestKind
  marketplacePluginCount?: number | null
  private: boolean
}

export type GithubRepositoryTreeEntry = {
  id: string
  kind: "blob" | "tree"
  path: string
  sha: string | null
  size: number | null
}

export type GithubRepositoryTreeSnapshot = {
  headSha: string
  truncated: boolean
  treeEntries: GithubRepositoryTreeEntry[]
  treeSha: string
}

export type GithubAppSummary = {
  htmlUrl: string
  name: string
  slug: string
}

export type GithubInstallationSummary = {
  accountLogin: string
  accountType: "Organization" | "User"
  displayName: string
  installationId: number
  repositorySelection: "all" | "selected"
  settingsUrl: string | null
}

export type GithubInstallStatePayload = {
  exp: number
  nonce: string
  orgId: string
  returnPath: string
  userId: string
}

const GITHUB_API_BASE = "https://api.github.com"
const GITHUB_API_VERSION = "2022-11-28"

function base64UrlEncode(value: unknown) {
  const buffer = typeof value === "string"
    ? Buffer.from(value)
    : Buffer.isBuffer(value)
      ? value
      : value instanceof Uint8Array
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : (() => {
            throw new GithubConnectorConfigError("Unsupported value passed to base64UrlEncode.")
          })()

  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

export function normalizeGithubPrivateKey(privateKey: string) {
  return privateKey.includes("\\n") ? privateKey.replace(/\\n/g, "\n") : privateKey
}

export function getGithubConnectorAppConfig(input: { appId?: string; privateKey?: string }) {
  const appId = input.appId?.trim()
  const privateKey = input.privateKey?.trim()

  if (!appId) {
    throw new GithubConnectorConfigError("GITHUB_CONNECTOR_APP_ID is required for live GitHub connector testing.")
  }

  if (!privateKey) {
    throw new GithubConnectorConfigError("GITHUB_CONNECTOR_APP_PRIVATE_KEY is required for live GitHub connector testing.")
  }

  return {
    appId,
    privateKey: normalizeGithubPrivateKey(privateKey),
  } satisfies GithubConnectorAppConfig
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url")
}

function isSafeRelativeReturnPath(value: string) {
  return value.startsWith("/") && !value.startsWith("//")
}

export function createGithubInstallStateToken(input: {
  now?: Date | number
  orgId: string
  returnPath: string
  secret: string
  ttlSeconds?: number
  userId: string
}) {
  const nowMs = input.now instanceof Date ? input.now.getTime() : (typeof input.now === "number" ? input.now : Date.now())
  const returnPath = input.returnPath.trim()
  if (!isSafeRelativeReturnPath(returnPath)) {
    throw new GithubConnectorConfigError("GitHub install return path must be a safe relative path.")
  }

  const payload: GithubInstallStatePayload = {
    exp: Math.floor(nowMs / 1000) + (input.ttlSeconds ?? 10 * 60),
    nonce: randomUUID(),
    orgId: input.orgId,
    returnPath,
    userId: input.userId,
  }
  const encodedPayload = base64UrlEncode(JSON.stringify(payload))
  const signature = base64UrlEncode(createHmac("sha256", input.secret).update(encodedPayload).digest())
  return `${encodedPayload}.${signature}`
}

export function verifyGithubInstallStateToken(input: { now?: Date | number; secret: string; token: string }) {
  const [encodedPayload, encodedSignature] = input.token.split(".")
  if (!encodedPayload || !encodedSignature) {
    return null
  }

  try {
    const expectedSignature = createHmac("sha256", input.secret).update(encodedPayload).digest()
    const providedSignature = base64UrlDecode(encodedSignature)
    const expectedBytes = new Uint8Array(expectedSignature)
    const providedBytes = new Uint8Array(providedSignature)
    if (expectedBytes.length !== providedBytes.length || !timingSafeEqual(expectedBytes, providedBytes)) {
      return null
    }

    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString("utf8")) as Partial<GithubInstallStatePayload>
    const nowSeconds = Math.floor((input.now instanceof Date ? input.now.getTime() : (typeof input.now === "number" ? input.now : Date.now())) / 1000)
    if (
      typeof payload.exp !== "number"
      || typeof payload.nonce !== "string"
      || typeof payload.orgId !== "string"
      || typeof payload.returnPath !== "string"
      || typeof payload.userId !== "string"
      || payload.exp < nowSeconds
      || !isSafeRelativeReturnPath(payload.returnPath)
    ) {
      return null
    }
    return payload as GithubInstallStatePayload
  } catch {
    return null
  }
}

export function createGithubAppJwt(input: GithubConnectorAppConfig & { now?: Date | number }) {
  const nowMs = input.now instanceof Date ? input.now.getTime() : (typeof input.now === "number" ? input.now : Date.now())
  const issuedAt = Math.floor(nowMs / 1000) - 60
  const expiresAt = issuedAt + (9 * 60)
  const signingInput = [
    base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64UrlEncode(JSON.stringify({ exp: expiresAt, iat: issuedAt, iss: input.appId })),
  ].join(".")

  const signer = createSign("RSA-SHA256")
  signer.update(signingInput)
  signer.end()

  return `${signingInput}.${base64UrlEncode(signer.sign(input.privateKey))}`
}

async function requestGithubJson<TResponse>(input: {
  fetchFn?: GithubFetch
  headers?: Record<string, string>
  method?: "GET" | "POST"
  path: string
  allowStatuses?: number[]
}) {
  const fetchFn = input.fetchFn ?? fetch
  const response = await fetchFn(`${GITHUB_API_BASE}${input.path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "openwork-den-api",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...input.headers,
    },
    method: input.method ?? "GET",
  })

  const text = await response.text()
  const body = text ? JSON.parse(text) as unknown : null
  if (!response.ok && !(input.allowStatuses ?? []).includes(response.status)) {
    const message = body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string"
      ? (body as Record<string, unknown>).message as string
      : `GitHub request failed with status ${response.status}.`
    throw new GithubConnectorRequestError(message, response.status, body)
  }

  return {
    body: body as TResponse,
    ok: response.ok,
    status: response.status,
  }
}

export async function getGithubAppSummary(input: { config: GithubConnectorAppConfig; fetchFn?: GithubFetch }) {
  const jwt = createGithubAppJwt(input.config)
  const response = await requestGithubJson<{ html_url?: string; name?: string; slug?: string }>({
    fetchFn: input.fetchFn,
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    path: "/app",
  })

  const htmlUrl = typeof response.body.html_url === "string" ? response.body.html_url.trim() : ""
  const slug = typeof response.body.slug === "string" ? response.body.slug.trim() : ""
  const name = typeof response.body.name === "string" ? response.body.name.trim() : ""
  if (!htmlUrl || !slug || !name) {
    throw new GithubConnectorRequestError("GitHub app metadata response was incomplete.", 502, response.body)
  }

  return {
    htmlUrl,
    name,
    slug,
  } satisfies GithubAppSummary
}

export function buildGithubAppInstallUrl(input: { app: GithubAppSummary; state: string }) {
  const url = new URL(`${input.app.htmlUrl.replace(/\/+$/, "")}/installations/new`)
  url.searchParams.set("state", input.state)
  return url.toString()
}

export async function getGithubInstallationSummary(input: { config: GithubConnectorAppConfig; fetchFn?: GithubFetch; installationId: number }) {
  const jwt = createGithubAppJwt(input.config)
  const response = await requestGithubJson<{
    account?: {
      login?: string
      type?: string
    }
    html_url?: string
    id?: number
    repository_selection?: string
  }>({
    fetchFn: input.fetchFn,
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    path: `/app/installations/${input.installationId}`,
  })

  const installationId = typeof response.body.id === "number" ? response.body.id : input.installationId
  const accountLogin = typeof response.body.account?.login === "string" ? response.body.account.login.trim() : ""
  const accountType = response.body.account?.type === "Organization" ? "Organization" : "User"
  const repositorySelection = response.body.repository_selection === "selected" ? "selected" : "all"
  if (!accountLogin) {
    throw new GithubConnectorRequestError("GitHub installation response was missing the account login.", 502, response.body)
  }

  return {
    accountLogin,
    accountType,
    displayName: accountLogin,
    installationId,
    repositorySelection,
    settingsUrl: typeof response.body.html_url === "string" ? response.body.html_url.trim() || null : null,
  } satisfies GithubInstallationSummary
}

async function createGithubInstallationAccessToken(input: { config: GithubConnectorAppConfig; fetchFn?: GithubFetch; installationId: number }) {
  const jwt = createGithubAppJwt(input.config)
  const response = await requestGithubJson<{ token?: string }>({
    fetchFn: input.fetchFn,
    headers: {
      Authorization: `Bearer ${jwt}`,
    },
    method: "POST",
    path: `/app/installations/${input.installationId}/access_tokens`,
  })

  const token = typeof response.body?.token === "string" ? response.body.token : null
  if (!token) {
    throw new GithubConnectorRequestError("GitHub did not return an installation access token.", 502, response.body)
  }

  return token
}

export async function getGithubInstallationAccessToken(input: { config: GithubConnectorAppConfig; fetchFn?: GithubFetch; installationId: number }) {
  return createGithubInstallationAccessToken(input)
}

function normalizeGithubRepository(entry: unknown): GithubRepositorySummary | null {
  if (!entry || typeof entry !== "object") {
    return null
  }

  const candidate = entry as Record<string, unknown>
  const id = typeof candidate.id === "number" ? candidate.id : Number(candidate.id)
  const fullName = typeof candidate.full_name === "string"
    ? candidate.full_name
    : typeof candidate.fullName === "string"
      ? candidate.fullName
      : null

  if (!Number.isFinite(id) || !fullName) {
    return null
  }

  return {
    defaultBranch: typeof candidate.default_branch === "string"
      ? candidate.default_branch
      : typeof candidate.defaultBranch === "string"
        ? candidate.defaultBranch
        : null,
    fullName,
    id,
    private: Boolean(candidate.private),
  }
}

export async function listGithubInstallationRepositories(input: { config: GithubConnectorAppConfig; fetchFn?: GithubFetch; installationId: number }) {
  const token = await createGithubInstallationAccessToken(input)
  const response = await requestGithubJson<{ repositories?: unknown[] }>({
    fetchFn: input.fetchFn,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    path: "/installation/repositories",
  })

  if (!Array.isArray(response.body.repositories)) {
    return []
  }

  const repositories: GithubRepositorySummary[] = []
  for (const entry of response.body.repositories) {
    const normalized = normalizeGithubRepository(entry)
    if (!normalized) {
      continue
    }

    const manifest = await detectRepositoryManifest({
      fetchFn: input.fetchFn,
      ownerAndRepo: normalized.fullName,
      token,
    })

    repositories.push({
      ...normalized,
      hasPluginManifest: manifest.manifestKind !== null,
      manifestKind: manifest.manifestKind,
      marketplacePluginCount: manifest.marketplacePluginCount,
    })
  }

  return repositories
}

async function detectRepositoryManifest(input: { fetchFn?: GithubFetch; ownerAndRepo: string; token: string }): Promise<{
  manifestKind: GithubManifestKind
  marketplacePluginCount: number | null
}> {
  const parts = splitRepositoryFullName(input.ownerAndRepo)
  if (!parts) {
    return { manifestKind: null, marketplacePluginCount: null }
  }

  const marketplaceResponse = await requestGithubJson<{ content?: string; encoding?: string }>({
    allowStatuses: [404],
    fetchFn: input.fetchFn,
    headers: {
      Authorization: `Bearer ${input.token}`,
    },
    path: `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/contents/.claude-plugin/marketplace.json`,
  })

  if (marketplaceResponse.ok && typeof marketplaceResponse.body?.content === "string" && marketplaceResponse.body.encoding === "base64") {
    let marketplacePluginCount: number | null = null
    try {
      const decoded = Buffer.from(marketplaceResponse.body.content.replace(/\n/g, ""), "base64").toString("utf8")
      const parsed = JSON.parse(decoded) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Array.isArray((parsed as Record<string, unknown>).plugins)) {
        marketplacePluginCount = ((parsed as Record<string, unknown>).plugins as unknown[]).length
      }
    } catch {
      marketplacePluginCount = null
    }
    return { manifestKind: "marketplace", marketplacePluginCount }
  }

  const pluginResponse = await requestGithubJson<unknown>({
    allowStatuses: [404],
    fetchFn: input.fetchFn,
    headers: {
      Authorization: `Bearer ${input.token}`,
    },
    path: `/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repo)}/contents/.claude-plugin/plugin.json`,
  })

  if (pluginResponse.ok) {
    return { manifestKind: "plugin", marketplacePluginCount: null }
  }

  return { manifestKind: null, marketplacePluginCount: null }
}

function splitRepositoryFullName(repositoryFullName: string) {
  const [owner, repo, ...rest] = repositoryFullName.trim().split("/")
  if (!owner || !repo || rest.length > 0) {
    return null
  }

  return { owner, repo }
}

export async function getGithubRepositoryTextFile(input: {
  config: GithubConnectorAppConfig
  fetchFn?: GithubFetch
  installationId: number
  path: string
  ref: string
  repositoryFullName: string
  token?: string
}) {
  const repositoryParts = splitRepositoryFullName(input.repositoryFullName)
  if (!repositoryParts) {
    throw new GithubConnectorRequestError("GitHub repository full name is invalid.", 400)
  }

  const token = input.token ?? await createGithubInstallationAccessToken(input)
  const response = await requestGithubJson<{ content?: string; encoding?: string }>({
    allowStatuses: [404],
    fetchFn: input.fetchFn,
    headers: {
      Authorization: `Bearer ${token}`,
    },
    path: `/repos/${encodeURIComponent(repositoryParts.owner)}/${encodeURIComponent(repositoryParts.repo)}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(input.ref)}`,
  })

  if (!response.ok) {
    return null
  }

  if (response.body.encoding !== "base64" || typeof response.body.content !== "string") {
    throw new GithubConnectorRequestError("GitHub file response was incomplete.", 502, response.body)
  }

  return Buffer.from(response.body.content.replace(/\n/g, ""), "base64").toString("utf8")
}

export async function getGithubRepositoryTree(input: {
  branch: string
  config: GithubConnectorAppConfig
  fetchFn?: GithubFetch
  installationId: number
  repositoryFullName: string
  token?: string
}) {
  const repositoryParts = splitRepositoryFullName(input.repositoryFullName)
  if (!repositoryParts) {
    throw new GithubConnectorRequestError("GitHub repository full name is invalid.", 400)
  }

  const token = input.token ?? await createGithubInstallationAccessToken(input)
  const authHeaders = {
    Authorization: `Bearer ${token}`,
  }
  const commitResponse = await requestGithubJson<{
    commit?: {
      tree?: {
        sha?: string
      }
    }
    sha?: string
  }>({
    fetchFn: input.fetchFn,
    headers: authHeaders,
    path: `/repos/${encodeURIComponent(repositoryParts.owner)}/${encodeURIComponent(repositoryParts.repo)}/commits/${encodeURIComponent(input.branch.trim())}`,
  })

  const headSha = typeof commitResponse.body.sha === "string" ? commitResponse.body.sha : ""
  const treeSha = typeof commitResponse.body.commit?.tree?.sha === "string" ? commitResponse.body.commit.tree.sha : ""
  if (!headSha || !treeSha) {
    throw new GithubConnectorRequestError("GitHub commit response was missing the head or tree sha.", 502, commitResponse.body)
  }

  const treeResponse = await requestGithubJson<{
    truncated?: boolean
    tree?: Array<{
      path?: string
      sha?: string
      size?: number
      type?: string
    }>
  }>({
    fetchFn: input.fetchFn,
    headers: authHeaders,
    path: `/repos/${encodeURIComponent(repositoryParts.owner)}/${encodeURIComponent(repositoryParts.repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
  })

  const treeEntries = Array.isArray(treeResponse.body.tree)
    ? treeResponse.body.tree.flatMap((entry) => {
        const path = typeof entry.path === "string" ? entry.path.trim() : ""
        const kind = entry.type === "blob" || entry.type === "tree" ? entry.type : null
        if (!path || !kind) {
          return []
        }

        return [{
          id: path,
          kind,
          path,
          sha: typeof entry.sha === "string" ? entry.sha : null,
          size: typeof entry.size === "number" ? entry.size : null,
        } satisfies GithubRepositoryTreeEntry]
      })
    : []

  return {
    headSha,
    truncated: Boolean(treeResponse.body.truncated),
    treeEntries,
    treeSha,
  } satisfies GithubRepositoryTreeSnapshot
}

export async function validateGithubInstallationTarget(input: {
  branch: string
  config: GithubConnectorAppConfig
  fetchFn?: GithubFetch
  installationId: number
  ref: string
  repositoryFullName: string
  repositoryId: number
  token?: string
}) {
  const repositoryParts = splitRepositoryFullName(input.repositoryFullName)
  if (!repositoryParts) {
    return {
      branchExists: false,
      defaultBranch: null,
      repositoryAccessible: false,
    }
  }

  const token = input.token ?? await createGithubInstallationAccessToken(input)
  const authHeaders = {
    Authorization: `Bearer ${token}`,
  }
  const repositoryResponse = await requestGithubJson<{
    default_branch?: string
    full_name?: string
    id?: number
  }>({
    allowStatuses: [404],
    fetchFn: input.fetchFn,
    headers: authHeaders,
    path: `/repos/${encodeURIComponent(repositoryParts.owner)}/${encodeURIComponent(repositoryParts.repo)}`,
  })

  if (!repositoryResponse.ok) {
    return {
      branchExists: false,
      defaultBranch: null,
      repositoryAccessible: false,
    }
  }

  const defaultBranch = typeof repositoryResponse.body.default_branch === "string"
    ? repositoryResponse.body.default_branch
    : null
  const repositoryAccessible = repositoryResponse.body.id === input.repositoryId
    && repositoryResponse.body.full_name === input.repositoryFullName

  if (!repositoryAccessible) {
    return {
      branchExists: false,
      defaultBranch,
      repositoryAccessible: false,
    }
  }

  const expectedRef = `refs/heads/${input.branch.trim()}`
  if (input.ref.trim() !== expectedRef) {
    return {
      branchExists: false,
      defaultBranch,
      repositoryAccessible: true,
    }
  }

  const branchResponse = await requestGithubJson<{ name?: string }>({
    allowStatuses: [404],
    fetchFn: input.fetchFn,
    headers: authHeaders,
    path: `/repos/${encodeURIComponent(repositoryParts.owner)}/${encodeURIComponent(repositoryParts.repo)}/branches/${encodeURIComponent(input.branch.trim())}`,
  })

  return {
    branchExists: branchResponse.ok && branchResponse.body.name === input.branch.trim(),
    defaultBranch,
    repositoryAccessible: true,
  }
}
