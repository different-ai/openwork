import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { inArray, type SQL } from "@openwork-ee/den-db/drizzle"
import { AuthSessionTable } from "@openwork-ee/den-db/schema"
import type { drizzleAdapter } from "better-auth/adapters/drizzle"

const DIGEST = /^[0-9a-f]{64}$/
const SEALED = /^([0-9a-f]{64})\.([0-9a-f]{64})$/

export function sessionTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

export function isSessionTokenDigest(value: string): boolean {
  return DIGEST.test(value)
}

export function sessionTokenLookupValues(token: string): string[] {
  const digest = sessionTokenDigest(token)
  return isSessionTokenDigest(token) ? [digest] : [digest, token]
}

export function sessionTokenMatches(token: string): SQL {
  return inArray(AuthSessionTable.token, sessionTokenLookupValues(token))
}

export function storedSessionTokenDigest(value: string): string {
  if (isSessionTokenDigest(value)) return value
  return SEALED.exec(value)?.[1] ?? sessionTokenDigest(value)
}

function referenceMac(secret: string, digest: string): string {
  return createHmac("sha256", secret).update(`openwork-session-token-reference:${digest}`).digest("hex")
}

export function sealSessionTokenDigest(secret: string, digest: string): string {
  return `${digest}.${referenceMac(secret, digest)}`
}

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
