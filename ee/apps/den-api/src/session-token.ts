import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { inArray, type SQL } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable } from "@openwork-ee/den-db/schema"
import type { drizzleAdapter } from "better-auth/adapters/drizzle"

/**
 * Sign-in session tokens at rest.
 *
 * The session table keeps the SHA-256 of each client's token (lowercase hex),
 * not the token, so a copy of the table cannot sign anyone in. Rows written
 * before hashing still hold the token itself: lookups match either form until
 * those rows are rehashed on use or expire (sessions last seven days and renew
 * only on use). A value shaped like a hash is never matched as itself, so a
 * copied hash cannot be presented as a token. New tokens are always hashed;
 * every replica continues to read both forms during the legacy row transition.
 *
 * In memory a session's `token` is the client's token. Better Auth rows read
 * without one (by id or user) carry a sealed reference instead, which only
 * this server can mint; cache invalidation reduces any of these forms to the
 * hash with `storedSessionTokenDigest`.
 *
 * Kept free of the database connection and environment so it can be unit tested.
 */

const DIGEST = /^[0-9a-f]{64}$/
const SEALED = /^([0-9a-f]{64})\.([0-9a-f]{64})$/

/** What the session table stores for a client's token once hashed. */
export function sessionTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** Whether a stored value is a hash rather than a token written before hashing. */
export function isSessionTokenDigest(value: string): boolean {
  return DIGEST.test(value)
}

/** The stored values a client's token may match: its hash, and the token itself until every row is hashed. */
export function sessionTokenLookupValues(token: string): string[] {
  const digest = sessionTokenDigest(token)
  return isSessionTokenDigest(token) ? [digest] : [digest, token]
}

/** The session row a client's token names, in either stored form. */
export function sessionTokenMatches(token: string): SQL {
  return inArray(AuthSessionTable.token, sessionTokenLookupValues(token))
}

/**
 * The hash behind any token form Den handles: a stored hash, a sealed
 * reference, or a client's token (also what pre-hashing rows store). Only for
 * cache invalidation, never to authenticate.
 */
export function storedSessionTokenDigest(value: string): string {
  if (isSessionTokenDigest(value)) return value
  return SEALED.exec(value)?.[1] ?? sessionTokenDigest(value)
}

function referenceMac(secret: string, digest: string): string {
  return createHmac("sha256", secret).update(`openwork-session-token-reference:${digest}`).digest("hex")
}

/** A stand-in for a hashed row's token that can name the row again, mintable only with the server secret. */
export function sealSessionTokenDigest(secret: string, digest: string): string {
  return `${digest}.${referenceMac(secret, digest)}`
}

/** The hash a sealed reference names, or null when it is not one this server minted. */
export function unsealSessionTokenReference(secret: string, value: string): string | null {
  const sealed = SEALED.exec(value)
  if (!sealed?.[1] || !sealed[2]) return null
  const expected = new Uint8Array(Buffer.from(referenceMac(secret, sealed[1]), "hex"))
  const presented = new Uint8Array(Buffer.from(sealed[2], "hex"))
  return timingSafeEqual(expected, presented) ? sealed[1] : null
}

type SessionAdapterFactory = ReturnType<typeof drizzleAdapter>
type SessionAdapter = ReturnType<SessionAdapterFactory>
type AdapterWhere = Parameters<SessionAdapter["findOne"]>[0]["where"][number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function whereStrings(clause: AdapterWhere): string[] {
  const values: unknown[] = Array.isArray(clause.value) ? clause.value : [clause.value]
  return values.filter((value): value is string => typeof value === "string")
}

/**
 * Better Auth's adapter with session tokens hashed at rest. Where clauses on a
 * session token match its stored forms; session rows come back with the
 * client's token when the query named it, else a sealed reference; and new or
 * updated tokens are always written hashed.
 */
export function hashSessionTokens(
  factory: SessionAdapterFactory,
  input: { secret: string },
): SessionAdapterFactory {
  const storedValues = (value: string) => {
    const sealed = unsealSessionTokenReference(input.secret, value)
    return sealed ? [sealed] : sessionTokenLookupValues(value)
  }
  const mapWhere = (model: string, where: AdapterWhere[]) => model !== "session" ? where : where.map((clause) => {
    if (clause.field !== "token") return clause
    const operator = clause.operator ?? "eq"
    if (operator !== "eq" && operator !== "in") throw new Error(`Session tokens cannot be compared with ${operator}.`)
    return { ...clause, operator: "in" as const, value: whereStrings(clause).flatMap(storedValues) }
  })
  // Rows named by a client's token get it back; other hashed rows get a sealed reference.
  const restore = <R>(model: string, where: AdapterWhere[] | undefined, row: R, written?: string): R => {
    if (model !== "session" || !isRecord(row) || typeof row.token !== "string") return row
    const stored = row.token
    const named = written ?? (where ?? []).filter((clause) => clause.field === "token").flatMap(whereStrings)
      .find((value) => storedValues(value).includes(stored))
    if (named !== undefined) Object.assign(row, { token: named })
    else if (isSessionTokenDigest(stored)) Object.assign(row, { token: sealSessionTokenDigest(input.secret, stored) })
    return row
  }
  const writeToken = async (model: string, data: Record<string, unknown>) => {
    if (model !== "session" || typeof data.token !== "string") return data
    return { ...data, token: sessionTokenDigest(data.token) }
  }
  const wrap = <A extends Omit<SessionAdapter, "transaction">>(adapter: A): A => ({
    ...adapter,
    create: async (data) => {
      const token = data.model === "session" && isRecord(data.data) && typeof data.data.token === "string" ? data.data.token : undefined
      const stored = await writeToken(data.model, data.data)
      return restore(data.model, undefined, await adapter.create({ ...data, data: { ...data.data, ...stored } }), token)
    },
    findOne: async (data) => restore(data.model, data.where, await adapter.findOne({ ...data, where: mapWhere(data.model, data.where) })),
    findMany: async (data) => (await adapter.findMany({ ...data, where: data.where && mapWhere(data.model, data.where) }))
      .map((row) => restore(data.model, data.where, row)),
    count: (data) => adapter.count({ ...data, where: data.where && mapWhere(data.model, data.where) }),
    update: async (data) => {
      const token = data.model === "session" && typeof data.update.token === "string" ? data.update.token : undefined
      const updated = await adapter.update({ ...data, where: mapWhere(data.model, data.where), update: await writeToken(data.model, data.update) })
      return restore(data.model, data.where, updated, token)
    },
    updateMany: async (data) => adapter.updateMany({ ...data, where: mapWhere(data.model, data.where), update: await writeToken(data.model, data.update) }),
    delete: (data) => adapter.delete({ ...data, where: mapWhere(data.model, data.where) }),
    deleteMany: (data) => adapter.deleteMany({ ...data, where: mapWhere(data.model, data.where) }),
    consumeOne: async (data) => restore(data.model, data.where, await adapter.consumeOne({ ...data, where: mapWhere(data.model, data.where) })),
    incrementOne: async (data) => restore(data.model, data.where, await adapter.incrementOne({ ...data, where: mapWhere(data.model, data.where) })),
  })
  return (options) => {
    const adapter = factory(options)
    return { ...wrap(adapter), transaction: (callback) => adapter.transaction((trx) => callback(wrap(trx))) }
  }
}
