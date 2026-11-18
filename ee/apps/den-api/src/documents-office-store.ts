import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, randomUUID } from "node:crypto"
import Redis from "ioredis"
import { officeDraftHasUnsavedEdits, officeDraftSchema, type OfficeDraft, type OfficeFileKey, type OfficeStore } from "@openwork/documents/office-server"
import { env } from "./env.js"

/** Fail closed without shared storage; Office drafts must survive routing between API replicas. */
export function configuredOfficeStore(): OfficeStore | null {
  return store
}
const redis = env.databaseRedisUrl ? new Redis(env.databaseRedisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 2_000, commandTimeout: 5_000 }) : null
redis?.on("error", () => {}) // Route reports unavailable without logging document/capability data.
const key = createSecretKey(new Uint8Array(createHash("sha256").update(`documents-office:${env.dbEncryptionKey}`).digest()))
function encrypt(value: string) {
  const iv = new Uint8Array(randomBytes(12)); const cipher = createCipheriv("aes-256-gcm", key, iv)
  return Buffer.concat([iv, new Uint8Array(cipher.update(value)), new Uint8Array(cipher.final()), new Uint8Array(cipher.getAuthTag())]).toString("base64")
}
function decrypt(value: string) {
  const bytes = new Uint8Array(Buffer.from(value, "base64")); const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([new Uint8Array(cipher.update(bytes.subarray(12, -16))), new Uint8Array(cipher.final())]).toString("utf8")
}
// A Cloud worker that serves an open Office session is busy, so Den's idle stop and
// image updates wait. Editor traffic renews the lease; a closed or abandoned file lets it lapse.
const WORKER_LEASE_MS = 20 * 60 * 1000
const workerKey = (workerId: string) => `documents:office:worker:${workerId}`

export async function holdOfficeWorker(workerId: string, sessionId: string) {
  if (!redis) return
  try {
    await redis.zadd(workerKey(workerId), Date.now() + WORKER_LEASE_MS, sessionId)
    await redis.pexpire(workerKey(workerId), WORKER_LEASE_MS)
  } catch { /* Best effort: editing continues; the worker's own activity still counts. */ }
}

export async function releaseOfficeWorker(workerId: string, sessionId: string) {
  if (!redis) return
  await redis.zrem(workerKey(workerId), sessionId).catch(() => 0)
}

export async function workerHasOpenOfficeSession(workerId: string) {
  if (!redis) return false
  try {
    await redis.zremrangebyscore(workerKey(workerId), "-inf", Date.now())
    return await redis.zcard(workerKey(workerId)) > 0
  } catch { return false }
}

const OFFICE_SESSION_LIMIT = 5
const QUOTA_SECONDS = 4 * 60 * 60
const hashed = (value: string) => createHash("sha256").update(value).digest("hex")
const draftKey = (id: string) => `documents:office:${id}`
const quotaKey = (draft: Pick<OfficeDraft, "organizationId" | "memberId">) => `documents:office:quota:${hashed(`${draft.organizationId}:${draft.memberId}`)}`
const openKey = (file: OfficeFileKey) => `documents:office:open:${hashed(JSON.stringify([file.organizationId, file.memberId, file.connectionId, file.fileId]))}`

async function readDraft(id: string): Promise<OfficeDraft | null> {
  const value = await redis!.get(draftKey(id))
  if (!value) return null
  const draft = officeDraftSchema.parse(JSON.parse(decrypt(value)))
  return draft.expiresAt > Date.now() ? draft : null
}

async function removeDraft(draft: OfficeDraft) {
  await redis!.del(draftKey(draft.id))
  await redis!.zrem(quotaKey(draft), draft.id)
  // Only forget the open-file pointer if it still points at this session.
  await redis!.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, openKey(draft), draft.id)
}

async function withLock<T>(lockKey: string, action: () => Promise<T>): Promise<T> {
  const name = `documents:office:lock:${hashed(lockKey)}`; const owner = randomUUID()
  if (await redis!.set(name, owner, "EX", 90, "NX") !== "OK") throw new Error("This document is being saved. Wait for that save to finish.")
  try { return await action() }
  finally { await redis!.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, name, owner) }
}

/**
 * At the limit, make room by ending the session that expires soonest and has no unsaved
 * edits. Pages that were reloaded or left open in a closed browser hold such sessions.
 * Sessions with unsaved edits are never ended here; they wait for a save, a close or expiry.
 */
async function makeRoom(quota: string) {
  for (const id of await redis!.zrange(quota, "0", "-1")) {
    const freed = await withLock(id, async () => {
      const old = await readDraft(id)
      if (!old) { await redis!.zrem(quota, id); return true }
      if (officeDraftHasUnsavedEdits(old)) return false
      await removeDraft(old)
      if (old.workerId) await releaseOfficeWorker(old.workerId, old.id)
      return true
    }).catch(() => false) // A session busy saving is in use; try the next one.
    if (freed) return
  }
  throw new Error("Five files with unsaved edits are already open in the editor. Save or close one of them, then open this file again.")
}

const store: OfficeStore | null = redis ? {
  get: readDraft,
  async findOpen(file) {
    const id = await redis.get(openKey(file))
    const draft = id ? await readDraft(id) : null
    return draft && draft.organizationId === file.organizationId && draft.memberId === file.memberId && draft.connectionId === file.connectionId && draft.fileId === file.fileId ? draft : null
  },
  async put(draft) {
    const ttl = Math.floor((draft.expiresAt - Date.now()) / 1000)
    if (ttl <= 0) throw new Error("The editing session expired. Reopen the file before editing again.")
    const quota = quotaKey(draft)
    if (!await redis.exists(draftKey(draft.id))) {
      await redis.zremrangebyscore(quota, "-inf", Date.now())
      if (await redis.zcard(quota) >= OFFICE_SESSION_LIMIT) await makeRoom(quota)
    }
    // A reopened session moves its expiry later; the quota follows it.
    await redis.zadd(quota, draft.expiresAt, draft.id)
    await redis.expire(quota, QUOTA_SECONDS)
    await redis.set(draftKey(draft.id), encrypt(JSON.stringify(draft)), "EX", ttl)
    await redis.set(openKey(draft), draft.id, "EX", ttl)
  },
  remove: removeDraft,
  lock: withLock,
} : null
