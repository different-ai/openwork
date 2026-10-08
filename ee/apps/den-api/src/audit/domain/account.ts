import { env } from "../../env.js"
import { recordAuditForUserMemberships, type AuditUserMembership } from "../fanout.js"
import { auditResourceId } from "../request-capture.js"
import { auditChanges, auditText, fieldOf, organizationParent, relatedResource, stringOf, targetResource, type AuditSnapshot } from "./snapshot.js"

// Account security changes of a user, fanned out to EVERY organization where
// the user is an active member (src/audit/fanout.ts): account.profile_updated,
// account.email_changed, account.password_changed, account.identity_linked,
// account.identity_unlinked, account.deleted (change) and
// account.provider_token.accessed (access). Allowlisted values only: the
// display name before/after; image and email changes are opaque markers;
// password, provider tokens, account ids and verification tokens are never read
// into evidence.
// Chokepoints (src/auth.ts): databaseHooks.user.update.before/after (every
// better-auth user update: update-user, change-email + verify-email,
// email-otp change-email), databaseHooks.account.create/delete.after (link-social,
// implicit linking at the social/SSO callback, unlink-account),
// databaseHooks.user.delete.before (delete-user, memberships still active),
// hooks.after for password changes and provider token reads, and the
// PATCH /v1/me/profile handler (direct database update, no hooks).

export type AuditPasswordMethod = "change_password" | "reset_password" | "email_otp_reset" | "other"

const PROVIDER_ID = /^[A-Za-z0-9_.-]{1,64}$/
const PROFILE_FIELDS = ["name", "image", "email"] as const
type ProfileField = typeof PROFILE_FIELDS[number]
type PendingUserUpdate = { fields: Set<ProfileField>; prior: Readonly<{ userId: string; name: string | null; image: string | null; email: string | null }> | null }
/** Fields a user update is about to change, keyed by the better-auth endpoint context of the update. */
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

/** PATCH /v1/me/profile and the user.update hooks: name before/after, image as a marker. */
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

/** databaseHooks.user.update.before: remember which profile fields change (and the session user's prior values). */
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

/** databaseHooks.user.update.after: account.profile_updated / account.email_changed in every membership. */
export async function auditUserUpdateAfter(user: unknown, context: unknown): Promise<void> {
  const key = contextKey(context)
  const pending = key ? pendingUserUpdates.get(key) : undefined
  if (!key || !pending) return
  pendingUserUpdates.delete(key)
  const userId = stringOf(user, "id")
  if (!userId) return
  // Prior values only when they describe this same user (verify-email may run under another session).
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

/** hooks.after on a successful change-password / reset-password / email-otp reset-password. */
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

/** databaseHooks.account.create.after: account.identity_linked (provider id only). */
export async function recordIdentityLinked(account: unknown, context: unknown): Promise<void> {
  const userId = stringOf(account, "userId")
  if (!userId) return
  const providerId = providerIdOf(stringOf(account, "providerId"))
  await fanOutAccountChange({
    userId, action: "account.identity_linked", changes: auditChanges(null, { providerId, method: linkMethod(context) }),
    discriminator: `${auditResourceId(stringOf(account, "id"))}:linked`,
  })
}

/** databaseHooks.account.delete.after: account.identity_unlinked (provider id only). */
export async function recordIdentityUnlinked(account: unknown): Promise<void> {
  const userId = stringOf(account, "userId")
  if (!userId) return
  const providerId = providerIdOf(stringOf(account, "providerId"))
  await fanOutAccountChange({ userId, action: "account.identity_unlinked", changes: auditChanges({ providerId }, null), discriminator: `${auditResourceId(stringOf(account, "id"))}:unlinked` })
}

/**
 * databaseHooks.user.delete.before (delete-user and its token callback; disabled
 * in Den today because user.deleteUser is not enabled): account.deleted while the
 * memberships still exist.
 */
export async function recordAccountDeleted(user: unknown): Promise<void> {
  const userId = stringOf(user, "id")
  if (!userId) return
  await fanOutAccountChange({ userId, action: "account.deleted", changes: auditChanges({ userId }, null) })
}

/** hooks.after on get-access-token / refresh-token: provider id only, never the token. */
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
