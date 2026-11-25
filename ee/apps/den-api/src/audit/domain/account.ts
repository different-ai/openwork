import { env } from "../../env.js"
import { recordAuditForUserMemberships, type AuditUserMembership } from "../fanout.js"
import { auditResourceId } from "../request-capture.js"
import { auditChanges, auditText, fieldOf, organizationParent, relatedResource, stringOf, targetResource, type AuditSnapshot } from "./snapshot.js"

export type AuditPasswordMethod = "change_password" | "reset_password" | "email_otp_reset" | "other"

const PROVIDER_ID = /^[A-Za-z0-9_.-]{1,64}$/
const PROFILE_FIELDS = ["name", "image", "email"] as const
type ProfileField = typeof PROFILE_FIELDS[number]
type PendingUserUpdate = { fields: Set<ProfileField>; prior: Readonly<{ userId: string; name: string | null; image: string | null; email: string | null }> | null }
const pendingUserUpdates = new WeakMap<object, PendingUserUpdate>()

function userResources(userId: string) {
  return (membership: AuditUserMembership) => [targetResource("user", userId), relatedResource("member", membership.memberId), organizationParent(membership.organizationId)]
}

function providerIdOf(value: string | null): string {
  return value && PROVIDER_ID.test(value) ? value : "unknown"
}

async function fanOutAccountChange(input: Readonly<{ userId: string; action: string; changes: ReturnType<typeof auditChanges>; reasonCode?: string; discriminator?: string; extra?: (membership: AuditUserMembership) => ReturnType<typeof relatedResource>[] }>) {
  if (!env.auditCaptureEnabled) return
  await recordAuditForUserMemberships({
    userId: input.userId, action: input.action, kind: "account.security", category: "change", actor: "member",
    resources: (membership) => [...userResources(input.userId)(membership), ...(input.extra?.(membership) ?? [])],
    changes: input.changes, ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
    ...(input.discriminator ? { idempotencyDiscriminator: input.discriminator } : {}),
  })
}

export async function recordProfileUpdated(input: Readonly<{ userId: string; before: string | null | undefined; after: string | null | undefined; imageChanged?: boolean }>): Promise<void> {
  const nameKnown = input.before !== undefined && input.after !== undefined
  const before: AuditSnapshot = nameKnown ? { name: auditText(input.before) } : {}
  const after: AuditSnapshot = nameKnown ? { name: auditText(input.after) } : {}
  const markers = [...(input.imageChanged ? ["image"] : []), ...(nameKnown ? [] : ["name"])]
  const changes = auditChanges(before, after, markers)
  if (changes.changedFields.length === 0) return
  await fanOutAccountChange({ userId: input.userId, action: "account.profile_updated", changes })
}

function contextKey(context: unknown): object | null {
  return typeof context === "object" && context !== null ? context : null
}

export function auditUserUpdateBefore(data: unknown, context: unknown): void {
  if (!env.auditCaptureEnabled) return
  const key = contextKey(context)
  if (!key) return
  const fields = new Set(PROFILE_FIELDS.filter((field) => fieldOf(data, field) !== undefined))
  if (fields.size === 0) return
  const sessionUser = fieldOf(fieldOf(fieldOf(context, "context"), "session"), "user")
  const userId = stringOf(sessionUser, "id")
  const pending = pendingUserUpdates.get(key)
  if (pending) for (const field of fields) pending.fields.add(field)
  else pendingUserUpdates.set(key, {
    fields,
    prior: userId ? { userId, name: stringOf(sessionUser, "name"), image: stringOf(sessionUser, "image"), email: stringOf(sessionUser, "email") } : null,
  })
}

export async function auditUserUpdateAfter(user: unknown, context: unknown): Promise<void> {
  const key = contextKey(context)
  const pending = key ? pendingUserUpdates.get(key) : undefined
  if (!key || !pending) return
  pendingUserUpdates.delete(key)
  const userId = stringOf(user, "id")
  if (!userId) return
  const prior = pending.prior?.userId === userId ? pending.prior : null
  const name = stringOf(user, "name")
  const imageChanged = pending.fields.has("image") && (!prior || prior.image !== stringOf(user, "image"))
  if (pending.fields.has("name") || imageChanged) {
    if (prior) await recordProfileUpdated({ userId, before: prior.name, after: name, imageChanged })
    else await recordProfileUpdated({ userId, before: undefined, after: undefined, imageChanged })
  }
  if (pending.fields.has("email") && (!prior || prior.email?.toLowerCase() !== stringOf(user, "email")?.toLowerCase())) {
    await fanOutAccountChange({ userId, action: "account.email_changed", changes: auditChanges({}, {}, ["email"]) })
  }
}

export async function recordPasswordChanged(userId: string, method: AuditPasswordMethod): Promise<void> {
  await fanOutAccountChange({ userId, action: "account.password_changed", changes: auditChanges(null, { method }, ["password"]), discriminator: `${userId}:${method}` })
}

function linkMethod(context: unknown): string {
  const path = stringOf(context, "path")
  if (path === "/link-social") return "link_social"
  if (path === "/callback/:id" || path === "/sign-in/social") return "social_sign_in"
  if (path?.startsWith("/sso/")) return "sso_sign_in"
  if (path === "/reset-password" || path === "/email-otp/reset-password") return "password_reset"
  return "other"
}

export async function recordIdentityLinked(account: unknown, context: unknown): Promise<void> {
  const userId = stringOf(account, "userId")
  if (!userId) return
  const providerId = providerIdOf(stringOf(account, "providerId"))
  await fanOutAccountChange({
    userId, action: "account.identity_linked", changes: auditChanges(null, { providerId, method: linkMethod(context) }),
    discriminator: `${auditResourceId(stringOf(account, "id"))}:linked`,
  })
}

export async function recordIdentityUnlinked(account: unknown): Promise<void> {
  const userId = stringOf(account, "userId")
  if (!userId) return
  const providerId = providerIdOf(stringOf(account, "providerId"))
  await fanOutAccountChange({ userId, action: "account.identity_unlinked", changes: auditChanges({ providerId }, null), discriminator: `${auditResourceId(stringOf(account, "id"))}:unlinked` })
}

export async function recordAccountDeleted(user: unknown): Promise<void> {
  const userId = stringOf(user, "id")
  if (!userId) return
  await fanOutAccountChange({ userId, action: "account.deleted", changes: auditChanges({ userId }, null) })
}

export async function recordProviderTokenAccessed(input: Readonly<{ userId: string; providerId: string | null; refresh: boolean; error: unknown }>): Promise<void> {
  if (!env.auditCaptureEnabled) return
  const providerId = providerIdOf(input.providerId)
  const status = fieldOf(input.error, "statusCode")
  const failed = input.error !== null && input.error !== undefined
  const denied = failed && (status === 401 || status === 403)
  await recordAuditForUserMemberships({
    userId: input.userId, action: "account.provider_token.accessed", kind: "account.security", category: "access", actor: "member",
    outcome: failed ? denied ? "denied" : "failed" : "succeeded",
    ...(failed ? { reasonCode: denied ? "request_denied" : "request_rejected" } : { reasonCode: input.refresh ? "refreshed" : "read" }),
    resources: (membership) => [...userResources(input.userId)(membership), relatedResource("auth_provider", providerId)],
    idempotencyDiscriminator: `${input.userId}:${providerId}:${input.refresh ? "refresh" : "read"}`,
  })
}
