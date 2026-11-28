import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { typeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { env } from "../env.js"

const schema = z.object({
  kind: z.enum(["install", "link"]),
  organizationId: typeId.schema("organization"),
  userId: typeId.schema("user"),
  memberId: typeId.schema("member"),
  nonce: z.string().min(1),
  exp: z.number().int(),
})
type CloudCodingState = z.infer<typeof schema>

function signature(payload: string) {
  return createHmac("sha256", env.betterAuthSecret).update(`cloud-coding:${payload}`).digest("base64url")
}

export function createCloudCodingState(input: Omit<CloudCodingState, "nonce" | "exp">, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...input, nonce: randomBytes(24).toString("base64url"), exp: now + 600_000 })).toString("base64url")
  return `${payload}.${signature(payload)}`
}

export function verifyCloudCodingState(state: string, now = Date.now()): CloudCodingState | null {
  if (state.length > 4096) return null
  const [payload, received, ...extra] = state.split(".")
  if (!payload || !received || extra.length) return null
  const expected = Buffer.from(signature(payload))
  const actual = Buffer.from(received)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  try {
    const value = schema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")))
    return value.exp > now ? value : null
  } catch {
    return null
  }
}
