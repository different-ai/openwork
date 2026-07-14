import { Buffer } from "node:buffer"

const GITHUB_API_BASE = "https://api.github.com"

export const PUBLIC_GITHUB_IMPORT_LIMITS = {
  apiCalls: 24,
  declaredMcpServers: 128,
  decodedBytes: 8 * 1024 * 1024,
  files: 20,
  fileBytes: 1024 * 1024,
  jsonResponseBytes: 2 * 1024 * 1024,
  operationTimeoutMs: 15_000,
  refCandidates: 12,
  requestTimeoutMs: 8_000,
  treeEntries: 20_000,
  treeResponseBytes: 8 * 1024 * 1024,
} as const

export class PublicGithubRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 502,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "PublicGithubRequestError"
  }
}

export type PublicGithubRequestBudget = {
  apiCalls: number
  deadlineAt: number
  decodedBytes: number
  files: Set<string>
}

export function createPublicGithubRequestBudget(input?: { operationTimeoutMs?: number }): PublicGithubRequestBudget {
  const operationTimeoutMs = input?.operationTimeoutMs ?? PUBLIC_GITHUB_IMPORT_LIMITS.operationTimeoutMs
  return {
    apiCalls: 0,
    deadlineAt: Date.now() + Math.max(1, operationTimeoutMs),
    decodedBytes: 0,
    files: new Set(),
  }
}

export function assertPublicGithubTreeWithinLimits(input: { entryCount: number; truncated: boolean }) {
  if (input.truncated) {
    throw new PublicGithubRequestError(
      400,
      "github_tree_truncated",
      "GitHub truncated this recursive repository tree. Narrow the GitHub URL to the plugin subdirectory before importing so OpenWork can inspect the complete source.",
    )
  }
  if (input.entryCount > PUBLIC_GITHUB_IMPORT_LIMITS.treeEntries) {
    importLimitExceeded(`GitHub repository trees are limited to ${PUBLIC_GITHUB_IMPORT_LIMITS.treeEntries} entries. Narrow the GitHub URL to the plugin subdirectory.`)
  }
}

export async function resolvePublicGithubRefAndPath<TResolved>(input: {
  defaultRef: string
  refAndPathSegments: string[] | null
  resolveRef: (ref: string) => Promise<TResolved | null>
}): Promise<{ ref: string; resolved: TResolved; rootPath: string }> {
  const candidates = input.refAndPathSegments ?? [input.defaultRef]
  if (candidates.length > PUBLIC_GITHUB_IMPORT_LIMITS.refCandidates) {
    throw new PublicGithubRequestError(
      400,
      "ambiguous_github_tree_ref",
      `GitHub tree URLs are limited to ${PUBLIC_GITHUB_IMPORT_LIMITS.refCandidates} branch/path segments so OpenWork can resolve the branch safely. Use a repository URL or a shallower plugin path.`,
    )
  }

  // GitHub tree URLs do not delimit slash-containing refs from subpaths.
  // Match GitHub's web behavior by resolving the longest valid ref prefix.
  for (let refLength = candidates.length; refLength >= 1; refLength -= 1) {
    const ref = candidates.slice(0, refLength).join("/")
    const resolved = await input.resolveRef(ref)
    if (resolved !== null) {
      return {
        ref,
        resolved,
        rootPath: candidates.slice(refLength).join("/"),
      }
    }
  }

  throw new PublicGithubRequestError(
    404,
    "github_branch_not_found",
    "OpenWork could not resolve the branch or tag in that GitHub tree URL. Use the repository URL or verify the ref and plugin path.",
  )
}

function importLimitExceeded(message: string): never {
  throw new PublicGithubRequestError(400, "github_import_limit_exceeded", message)
}

function contentLength(response: Response) {
  const raw = response.headers.get("content-length")
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

export async function readBoundedGithubResponseText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = contentLength(response)
  if (declaredLength !== null && declaredLength > maxBytes) {
    throw new PublicGithubRequestError(502, "github_response_too_large", "GitHub returned a response larger than OpenWork can safely inspect.")
  }

  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      bytes += result.value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel()
        throw new PublicGithubRequestError(502, "github_response_too_large", "GitHub returned a response larger than OpenWork can safely inspect.")
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }

  const combined = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(combined)
}

export async function requestPublicGithubJson(input: {
  allowStatuses?: number[]
  budget: PublicGithubRequestBudget
  fetchImpl?: typeof fetch
  maxResponseBytes?: number
  path: string
  timeoutMs?: number
}) {
  const remainingOperationMs = input.budget.deadlineAt - Date.now()
  if (remainingOperationMs <= 0) {
    throw new PublicGithubRequestError(502, "github_request_timeout", "GitHub plugin inspection exceeded its total time limit.")
  }
  input.budget.apiCalls += 1
  if (input.budget.apiCalls > PUBLIC_GITHUB_IMPORT_LIMITS.apiCalls) {
    importLimitExceeded(`GitHub import needs more than ${PUBLIC_GITHUB_IMPORT_LIMITS.apiCalls} API requests. Narrow the repository URL to a plugin subdirectory.`)
  }

  const controller = new AbortController()
  const requestTimeoutMs = input.timeoutMs ?? PUBLIC_GITHUB_IMPORT_LIMITS.requestTimeoutMs
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(requestTimeoutMs, remainingOperationMs)))
  let response: Response
  let text: string
  try {
    response = await (input.fetchImpl ?? fetch)(`${GITHUB_API_BASE}${input.path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "openwork-den-api",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    })
    text = await readBoundedGithubResponseText(
      response,
      input.maxResponseBytes ?? PUBLIC_GITHUB_IMPORT_LIMITS.jsonResponseBytes,
    )
  } catch (error) {
    if (error instanceof PublicGithubRequestError) throw error
    if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new PublicGithubRequestError(502, "github_request_timeout", "GitHub did not respond before the import inspection timeout.")
    }
    throw new PublicGithubRequestError(502, "github_request_failed", error instanceof Error ? error.message : "GitHub request failed.")
  } finally {
    clearTimeout(timeout)
  }
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text) as unknown
    } catch {
      throw new PublicGithubRequestError(502, "github_response_invalid", "GitHub returned an invalid JSON response.")
    }
  }
  if (!response.ok && !(input.allowStatuses ?? []).includes(response.status)) {
    const message = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
      ? body.message
      : `GitHub request failed with status ${response.status}.`
    throw new PublicGithubRequestError(response.status === 404 ? 404 : 502, "github_request_failed", message)
  }
  return { body, ok: response.ok, status: response.status }
}

export function decodePublicGithubBase64File(input: {
  base64: string
  budget: PublicGithubRequestBudget
  path: string
}) {
  const normalizedPath = input.path.trim()
  if (!input.budget.files.has(normalizedPath)) {
    if (input.budget.files.size >= PUBLIC_GITHUB_IMPORT_LIMITS.files) {
      importLimitExceeded(`GitHub import contains more than ${PUBLIC_GITHUB_IMPORT_LIMITS.files} files. Narrow the repository URL to a plugin subdirectory.`)
    }
    input.budget.files.add(normalizedPath)
  }

  const compact = input.base64.replace(/\s/g, "")
  const maximumDecodedBytes = Math.ceil(compact.length * 3 / 4)
  if (maximumDecodedBytes > PUBLIC_GITHUB_IMPORT_LIMITS.fileBytes + 2) {
    importLimitExceeded(`GitHub file "${normalizedPath}" is larger than ${PUBLIC_GITHUB_IMPORT_LIMITS.fileBytes} bytes.`)
  }
  const decoded = Buffer.from(compact, "base64")
  if (decoded.byteLength > PUBLIC_GITHUB_IMPORT_LIMITS.fileBytes) {
    importLimitExceeded(`GitHub file "${normalizedPath}" is larger than ${PUBLIC_GITHUB_IMPORT_LIMITS.fileBytes} bytes.`)
  }
  input.budget.decodedBytes += decoded.byteLength
  if (input.budget.decodedBytes > PUBLIC_GITHUB_IMPORT_LIMITS.decodedBytes) {
    importLimitExceeded(`GitHub import contains more than ${PUBLIC_GITHUB_IMPORT_LIMITS.decodedBytes} decoded bytes. Narrow the repository URL to a plugin subdirectory.`)
  }
  return decoded.toString("utf8")
}
