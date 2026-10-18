import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, randomUUID } from "node:crypto"
import Redis from "ioredis"
import { officeDraftSchema, officeRecoveryUntil, OFFICE_TTL_SECONDS, OFFICE_RECOVERY_SECONDS, type OfficeStore } from "@openwork/documents/office-server"
import { env } from "./env.js"

/** Fail closed without shared storage; Office drafts must survive routing between API replicas. */
export function configuredOfficeStore(): OfficeStore | null {
  return store
}
/** Release this host's connection without deleting another tab's recovery. */
export async function closeOfficeStore(): Promise<void> {
  try { await redis?.quit() }
  finally { redis?.disconnect() }
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
const store: OfficeStore | null = redis ? {
  async get(id) {
    const value = await redis.get(`documents:office:${id}`)
    if (!value) return null
    const draft = officeDraftSchema.parse(JSON.parse(decrypt(value)))
    return officeRecoveryUntil(draft) > Date.now() ? draft : null
  },
  async put(draft) {
    const ttl = Math.floor((officeRecoveryUntil(draft) - Date.now()) / 1000)
    if (ttl <= 0) throw new Error("The editing session expired. Reopen the file before editing again.")
    if (!await redis.exists(`documents:office:${draft.id}`)) {
      const quota = `documents:office:quota:${createHash("sha256").update(`${draft.organizationId}:${draft.memberId}`).digest("hex")}`
      await redis.zremrangebyscore(quota, "-inf", Date.now())
      if (await redis.zcard(quota) >= 5) throw new Error("Five editing or recovery sessions are already open. Close an existing tab or open the file in Drive. Editing expires after four hours, followed by 15 minutes of recovery.")
      await redis.zadd(quota, officeRecoveryUntil(draft), draft.id)
      await redis.expire(quota, OFFICE_TTL_SECONDS + OFFICE_RECOVERY_SECONDS)
    }
    await redis.set(`documents:office:${draft.id}`, encrypt(JSON.stringify(draft)), "EX", ttl)
  },
  async remove(draft) {
    await redis.del(`documents:office:${draft.id}`)
    const quota = `documents:office:quota:${createHash("sha256").update(`${draft.organizationId}:${draft.memberId}`).digest("hex")}`
    await redis.zrem(quota, draft.id)
  },
  async lock(lockKey, action) {
    const name = `documents:office:lock:${createHash("sha256").update(lockKey).digest("hex")}`; const owner = randomUUID()
    if (await redis.set(name, owner, "EX", 90, "NX") !== "OK") throw new Error("This document is being saved. Wait for that save to finish.")
    try { return await action() }
    finally { await redis.eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, name, owner) }
  },
} : null
