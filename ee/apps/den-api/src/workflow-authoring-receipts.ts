import { createHash } from "node:crypto"
import { ConfigObjectVersionTable } from "@openwork-ee/den-db/schema"
import Redis from "ioredis"
import ts from "typescript"
import { z } from "zod"
import type { artifactRuntime } from "./artifact-runtime.js"
import { artifactDigest } from "./workflow-artifacts.js"
import { codemodeCodeDigest } from "./workflow-runs.js"

export type WorkflowAuthoringSourceInput = {
  receiptId: string
  organizationId: string
  orgMembershipId: string
  code: string
  mode: "adhoc" | "live"
  inputDigest: string
  inputSchemaDigest: string | null
  outputSchemaDigest: string | null
  runtime?: ReturnType<typeof artifactRuntime>
}

export type WorkflowAuthoringSource = Readonly<Omit<WorkflowAuthoringSourceInput, "runtime"> & {
  codeDigest: string
  source: "adhoc" | "authoring:live"
  runtime?: Readonly<ReturnType<typeof artifactRuntime>>
}>

export type WorkflowAuthoringSourceIdentity = Pick<WorkflowAuthoringSourceInput, "receiptId" | "organizationId" | "orgMembershipId">
export type WorkflowAuthoringRedisBackend = {
  get(key: string): Promise<string | null>
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>
}
export type WorkflowAuthoringRetentionMetadata = {
  scope: "shared" | "process" | "unavailable"
  ttlMs: number
}
export type WorkflowAuthoringSourceStore = {
  retain(input: WorkflowAuthoringSourceInput): Promise<boolean>
  get(input: WorkflowAuthoringSourceIdentity): Promise<WorkflowAuthoringSource | null>
  metadata(): WorkflowAuthoringRetentionMetadata
}

type Entry = { source: WorkflowAuthoringSource; expiresAt: number; bytes: number; timer: ReturnType<typeof setTimeout> }
const TTL_MS = 15 * 60_000
const MAX_ENTRIES = 200
const MAX_BYTES = 16 * 1024 * 1024
const MAX_ENTRY_BYTES = 1024 * 1024
const PURPOSE = "workflow-authoring-source:v1"
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const identitySchema = z.object({
  receiptId: z.string().min(1).max(160),
  organizationId: z.string().min(1).max(160),
  orgMembershipId: z.string().min(1).max(160),
})
const sourceSchema = identitySchema.extend({
  code: z.string().min(1).max(200_000),
  mode: z.enum(["adhoc", "live"]),
  inputDigest: digestSchema,
  inputSchemaDigest: digestSchema.nullable(),
  outputSchemaDigest: digestSchema.nullable(),
  codeDigest: digestSchema,
  source: z.enum(["adhoc", "authoring:live"]),
  runtime: z.object({
    now: z.string().max(100), today: z.string().max(100), timeZone: z.string().max(100),
    dayStart: z.string().max(100), dayEnd: z.string().max(100),
  }).strict().optional(),
}).strict()
const envelopeSchema = z.object({
  purpose: z.literal(PURPOSE),
  expiresAt: z.number().int().positive(),
  source: sourceSchema,
}).strict()

const RETAIN_SCRIPT = `
local clock = redis.call('time')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl = math.min(tonumber(ARGV[2]), tonumber(ARGV[1]) + tonumber(ARGV[2]) - now)
if ttl <= 0 then return 0 end
local limit = tonumber(ARGV[3])
local budget = tonumber(ARGV[4])
local bytes = string.len(ARGV[5])
if bytes > tonumber(ARGV[6]) then return 0 end
local prefix = string.sub(KEYS[3], 1, -65)
local function remove(key)
  local suffix = string.sub(key, #prefix + 1)
  if string.sub(key, 1, #prefix) == prefix and #suffix == 64 and string.match(suffix, '^%x+$') then
    redis.call('del', key)
  end
  redis.call('zrem', KEYS[1], key)
  redis.call('hdel', KEYS[2], key)
end
local expired = redis.call('zrangebyscore', KEYS[1], '-inf', now)
for _, key in ipairs(expired) do remove(key) end
if redis.call('exists', KEYS[3]) == 1 then return 0 end
local members = redis.call('zrange', KEYS[1], 0, -1)
local total = 0
for _, key in ipairs(members) do
  total = total + tonumber(redis.call('hget', KEYS[2], key) or '0')
end
local count = #members
for _, key in ipairs(members) do
  if count < limit and total + bytes <= budget then break end
  total = total - tonumber(redis.call('hget', KEYS[2], key) or '0')
  remove(key)
  count = count - 1
end
if count >= limit or total + bytes > budget then return 0 end
redis.call('set', KEYS[3], ARGV[5], 'PX', ttl)
redis.call('zadd', KEYS[1], now + ttl, KEYS[3])
redis.call('hset', KEYS[2], KEYS[3], bytes)
redis.call('pexpire', KEYS[1], math.max(ttl, redis.call('pttl', KEYS[1])))
redis.call('pexpire', KEYS[2], math.max(ttl, redis.call('pttl', KEYS[2])))
return 1
`

const secretPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-|rk-)[A-Za-z0-9_-]{8,}\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
  /\b(?:[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|credentials?|secret|token|passphrase)|authorization)["'`]?\s*\]?\s*[:=]\s*["'`][^"'`\r\n]+["'`]/i,
  /[?&](?:api[_-]?key|token|access_token|secret|password)=[^\s"'`&#]+/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:"'`]+:[^\s/@"'`]+@/i,
]

const credentialName = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|private[_-]?key|credentials?|secret|token|passphrase|authorization)$/i

function credentialTarget(node: ts.Node): boolean {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return credentialName.test(node.text)
  if (ts.isPropertyAccessExpression(node)) return credentialTarget(node.name)
  if (ts.isElementAccessExpression(node)) return credentialTarget(node.argumentExpression)
  if (ts.isComputedPropertyName(node) || ts.isParenthesizedExpression(node)) return credentialTarget(node.expression)
  return false
}

function credentialLiteral(node: ts.Expression): string | undefined {
  if (ts.isParenthesizedExpression(node)) return credentialLiteral(node.expression)
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = credentialLiteral(node.left)
    const right = credentialLiteral(node.right)
    if (left !== undefined && right !== undefined) return left + right
  }
  return undefined
}

function containsCredentialAssignment(node: ts.Node): boolean {
  if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isPropertyAssignment(node))
    && node.initializer && credentialTarget(node.name) && credentialLiteral(node.initializer)) return true
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && credentialTarget(node.left) && credentialLiteral(node.right)) return true
  return ts.forEachChild(node, containsCredentialAssignment) ?? false
}

export function assertWorkflowSourceSafe(code: string): void {
  const decoded = code.replace(/\\(?:u\{([0-9a-f]{1,6})\}|u([0-9a-f]{4})|x([0-9a-f]{2}))/gi,
    (match, point: string | undefined, unicode: string | undefined, hex: string | undefined) => {
      const value = Number.parseInt(point ?? unicode ?? hex ?? "", 16)
      return value <= 0x10ffff ? String.fromCodePoint(value) : match
    })
  if (secretPatterns.some((pattern) => pattern.test(code) || pattern.test(decoded))
    || containsCredentialAssignment(ts.createSourceFile("workflow.js", code, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS))) {
    throw new Error("workflow_source_contains_secret")
  }
}

function prepareSource(input: WorkflowAuthoringSourceInput): WorkflowAuthoringSource | null {
  if (!input.code || input.code.length > 200_000) return null
  if (input.mode === "live" ? !input.runtime : input.runtime !== undefined) return null
  const runtime = input.runtime === undefined ? undefined : {
    now: input.runtime.now, today: input.runtime.today, timeZone: input.runtime.timeZone,
    dayStart: input.runtime.dayStart, dayEnd: input.runtime.dayEnd,
  }
  const parsed = sourceSchema.safeParse({
    receiptId: input.receiptId, organizationId: input.organizationId, orgMembershipId: input.orgMembershipId,
    code: input.code, mode: input.mode, inputDigest: input.inputDigest,
    inputSchemaDigest: input.inputSchemaDigest, outputSchemaDigest: input.outputSchemaDigest,
    codeDigest: codemodeCodeDigest(input.code), source: input.mode === "live" ? "authoring:live" : "adhoc",
    ...(runtime === undefined ? {} : { runtime }),
  })
  if (!parsed.success) return null
  assertWorkflowSourceSafe(parsed.data.code)
  if (runtime && artifactDigest({ runtime }) !== parsed.data.inputDigest) return null
  if (parsed.data.runtime) Object.freeze(parsed.data.runtime)
  return Object.freeze(parsed.data)
}

function keys(input: WorkflowAuthoringSourceIdentity) {
  const member = createHash("sha256").update(JSON.stringify([input.organizationId, input.orgMembershipId])).digest("hex")
  const receipt = createHash("sha256").update(input.receiptId).digest("hex")
  const prefix = `workflow-authoring:v1:{${member}}`
  return { index: `${prefix}:index`, sizes: `${prefix}:sizes`, entry: `${prefix}:${receipt}` }
}

export function createWorkflowAuthoringSourceStore(options: { redis: WorkflowAuthoringRedisBackend | null }): WorkflowAuthoringSourceStore {
  const redis = options.redis
  const entries = new Map<string, Entry>()
  let retainedBytes = 0
  let scope: WorkflowAuthoringRetentionMetadata["scope"] = redis ? "shared" : "process"
  const remove = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    clearTimeout(entry.timer)
    retainedBytes -= entry.bytes
    entries.delete(key)
  }
  const expire = () => {
    const now = Date.now()
    for (const [key, entry] of entries) if (entry.expiresAt <= now) remove(key)
  }
  return {
    metadata: () => ({ scope, ttlMs: TTL_MS }),
    retain: async (input) => {
      try {
        const source = prepareSource(input)
        if (!source) return false
        const now = Date.now()
        const envelope = JSON.stringify({ purpose: PURPOSE, expiresAt: now + TTL_MS, source })
        if (Buffer.byteLength(envelope) > MAX_ENTRY_BYTES) return false
        const key = keys(source)
        if (redis) {
          const encrypted = ConfigObjectVersionTable.rawSourceText.mapToDriverValue(envelope)
          if (typeof encrypted !== "string") throw new Error("workflow_authoring_encryption_unavailable")
          if (Buffer.byteLength(encrypted) > MAX_ENTRY_BYTES) return false
          const result = await redis.eval(RETAIN_SCRIPT, 3, key.index, key.sizes, key.entry,
            now, TTL_MS, MAX_ENTRIES, MAX_BYTES, encrypted, MAX_ENTRY_BYTES)
          scope = "shared"
          return result === 1
        }
        expire()
        if (entries.has(key.entry)) return false
        const bytes = envelope.length * 2 + 512
        if (bytes > MAX_BYTES) return false
        while (entries.size >= MAX_ENTRIES || retainedBytes + bytes > MAX_BYTES) {
          const oldest = entries.keys().next().value
          if (oldest === undefined) return false
          remove(oldest)
        }
        const timer = setTimeout(() => remove(key.entry), TTL_MS)
        timer.unref()
        entries.set(key.entry, { source, expiresAt: now + TTL_MS, bytes, timer })
        retainedBytes += bytes
        return true
      } catch {
        if (redis) scope = "unavailable"
        return false
      }
    },
    get: async (input) => {
      if (!identitySchema.safeParse(input).success) return null
      const key = keys(input)
      if (!redis) {
        expire()
        return entries.get(key.entry)?.source ?? null
      }
      try {
        const encrypted = await redis.get(key.entry)
        scope = "shared"
        if (encrypted === null) return null
        if (Buffer.byteLength(encrypted) > MAX_ENTRY_BYTES) return null
        const plaintext = ConfigObjectVersionTable.rawSourceText.mapFromDriverValue(encrypted)
        if (typeof plaintext !== "string") return null
        const parsed = envelopeSchema.safeParse(JSON.parse(plaintext))
        if (!parsed.success) return null
        const { source, expiresAt } = parsed.data
        const now = Date.now()
        if (expiresAt <= now || expiresAt > now + TTL_MS
          || source.receiptId !== input.receiptId || source.organizationId !== input.organizationId
          || source.orgMembershipId !== input.orgMembershipId) return null
        const normalized = prepareSource(source)
        if (!normalized || normalized.codeDigest !== source.codeDigest || normalized.source !== source.source) return null
        return normalized
      } catch {
        scope = "unavailable"
        return null
      }
    },
  }
}

let defaultStore: Promise<WorkflowAuthoringSourceStore> | undefined

function configuredStore(): Promise<WorkflowAuthoringSourceStore> {
  defaultStore ??= (async () => {
    try {
      const { env } = await import("./env.js")
      const redis = env.databaseRedisUrl ? new Redis(env.databaseRedisUrl, {
        lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 3_000,
      }) : null
      redis?.on("error", () => {})
      return createWorkflowAuthoringSourceStore({ redis })
    } catch {
      return {
        retain: async () => false,
        get: async () => null,
        metadata: () => ({ scope: "unavailable", ttlMs: TTL_MS }),
      }
    }
  })()
  return defaultStore
}

export async function retainWorkflowAuthoringSource(input: WorkflowAuthoringSourceInput): Promise<boolean> {
  return (await configuredStore()).retain(input)
}

export async function getWorkflowAuthoringSource(input: WorkflowAuthoringSourceIdentity): Promise<WorkflowAuthoringSource | null> {
  return (await configuredStore()).get(input)
}

export async function getWorkflowAuthoringRetentionMetadata(): Promise<WorkflowAuthoringRetentionMetadata> {
  return (await configuredStore()).metadata()
}
