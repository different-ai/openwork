import { z } from "zod"

/** Identity supplied only by the authenticated service caller, never read from a prompt or session owner. */
const headerValue = z.string().min(1).max(512).regex(/^[\x21-\x7e]+$/, "must be printable ASCII without whitespace")
export const modelAttributionSchema = z.object({
  memberId: headerValue,
  userId: headerValue,
  organizationId: headerValue,
  email: headerValue.optional(),
}).strict()
export type ModelAttribution = z.infer<typeof modelAttributionSchema>
export const attributionFormatSchema = z.enum(["member_id", "user_id", "owner", "email"])
export type AttributionPolicy = { name: string; format: z.infer<typeof attributionFormatSchema> }

const reserved = new Set([
  "authorization", "proxy-authorization", "proxy-authenticate", "www-authenticate", "cookie", "set-cookie",
  "host", "connection", "keep-alive", "content-type", "content-length", "content-encoding", "transfer-encoding",
  "te", "trailer", "upgrade", "expect", "accept", "accept-encoding", "user-agent", "origin", "referer",
  "forwarded", "via", "range", "date", "anthropic-version", "anthropic-beta", "openai-organization", "openai-project",
])
export function validAttributionHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && name.length <= 128 && !reserved.has(lower)
    && !/^(proxy-|sec-|access-control-|content-|accept-|if-|x-forwarded-|x-openwork-|x-amz-|cf-)/.test(lower)
    && !/(^|[-_])(auth|authorization|apikey|key|token|secret|cookie|credential|credentials)([-_]|$)/.test(lower)
}

/** A fresh object for each inference call: never mutate provider defaults or share identity across turns. */
export function attributionHeaders(policy?: AttributionPolicy, identity?: ModelAttribution): Record<string, string> {
  if (!policy || !identity) return {}
  if (!validAttributionHeader(policy.name)) throw new Error("Invalid model attribution header name")
  const parsed = modelAttributionSchema.safeParse(identity)
  if (!parsed.success) throw new Error("Invalid model attribution identity")
  const value = policy.format === "member_id" ? parsed.data.memberId
    : policy.format === "user_id" ? parsed.data.userId
      : policy.format === "owner" ? `${parsed.data.organizationId}:${parsed.data.memberId}` : parsed.data.email
  if (!value) return {}
  return { [policy.name]: value }
}
