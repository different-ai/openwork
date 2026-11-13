import { eq } from "@openwork-ee/den-db/drizzle"
import { AdminAllowlistTable, AuthUserTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { ensureAdminAllowlistSeeded } from "../admin-allowlist.js"
import { beginAuditRequest } from "../audit/request-capture.js"
import { db } from "../db.js"
import { env } from "../env.js"
import { checkFreshPrivilegedSession } from "../privileged-session.js"
import type { AuthContextVariables } from "../session.js"

export const PLATFORM_ADMIN_REAUTH_SECURITY_MESSAGE = "For security, confirm it's you before making admin changes."
const ADMIN_READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? ""
}

/** Whether an email is on the platform-admin allowlist. Shared by the admin routes middleware and the den-admin MCP endpoint. */
export async function isAdminEmailAllowed(email: string | null | undefined): Promise<boolean> {
  const normalized = normalizeEmail(email)
  if (!normalized) {
    return false
  }

  await ensureAdminAllowlistSeeded()

  const allowed = await db
    .select({ id: AdminAllowlistTable.id })
    .from(AdminAllowlistTable)
    .where(eq(AdminAllowlistTable.email, normalized))
    .limit(1)

  return allowed.length > 0
}

/** Whether a Den user id belongs to an allowlisted platform admin. */
export async function isPlatformAdminUserId(value: string): Promise<boolean> {
  let userId: ReturnType<typeof normalizeDenTypeId<"user">>
  try {
    userId = normalizeDenTypeId("user", value)
  } catch {
    return false
  }

  const user = (await db
    .select({ email: AuthUserTable.email })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1))[0]

  return isAdminEmailAllowed(user?.email)
}

/**
 * Whether a Den user passes the same platform-admin check as the /v1/admin
 * routes (`requireAdminMiddleware`): an allowlisted email that is verified
 * where Den verifies emails. For work done in a user's name outside an /admin
 * request, such as a config import turning organization features on.
 */
export async function isAdminRouteUserId(value: string): Promise<boolean> {
  let userId: ReturnType<typeof normalizeDenTypeId<"user">>
  try {
    userId = normalizeDenTypeId("user", value)
  } catch {
    return false
  }

  const user = (await db
    .select({ email: AuthUserTable.email, emailVerified: AuthUserTable.emailVerified })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1))[0]
  if (!user) return false
  if (env.requireEmailVerification && user.emailVerified !== true) return false
  return isAdminEmailAllowed(user.email)
}

/**
 * Deployment diagnostics authority is the local operator allowlist, never an
 * organization role, ownership or permission. Setup writes this same allowlist
 * in completeInitialAdminBootstrapSignup; DEN_BOOTSTRAP_ADMIN_EMAILS is only an
 * additional seeding mechanism. Never consult the allowlist on hosted Den.
 */
export async function isLocalDeploymentOperatorUserId(userId: string): Promise<boolean> {
  if (env.features.deployment !== "self_hosted") return false
  return isPlatformAdminUserId(userId)
}

/** A genuine Better Auth user session: a person signed in, not an API key or an MCP token acting for them. */
function hasUserSession(principal: AuthContextVariables): boolean {
  if (principal.apiKey || !principal.user?.id || !principal.session?.id || !principal.session.token) return false
  try {
    normalizeDenTypeId("session", principal.session.id)
  } catch {
    return false
  }
  return true
}

/** A genuine Better Auth user session (not an API key or MCP token) of an allowlisted local operator. */
export async function hasLocalDeploymentOperatorSessionAuthority(principal: AuthContextVariables): Promise<boolean> {
  if (!hasUserSession(principal) || !principal.user?.id) return false
  return isLocalDeploymentOperatorUserId(principal.user.id)
}

/**
 * Installation operator authority on self-hosted Den: an allowlisted operator's
 * genuine user session, or an API key whose owning user is that operator. An
 * API key acts for the user who created it, so only the owner's allowlist entry
 * counts; organization roles, permissions and ownership never do. Always false
 * on hosted Den, before any lookup.
 */
export async function isLocalDeploymentOperator(principal: AuthContextVariables): Promise<boolean> {
  if (env.features.deployment !== "self_hosted") return false
  const apiKey = principal.apiKey
  if (!apiKey) return hasLocalDeploymentOperatorSessionAuthority(principal)
  const userId = principal.user?.id
  if (!userId) return false
  try {
    if (normalizeDenTypeId("user", apiKey.referenceId) !== normalizeDenTypeId("user", userId)) return false
  } catch {
    return false
  }
  return isLocalDeploymentOperatorUserId(userId)
}

/**
 * Caller-specific hint for GET /v1/org: the same authority the installation
 * diagnostics enforce. Advisory: lookup failures answer false, never block core.
 */
export async function canManageDeploymentServices(principal: AuthContextVariables): Promise<boolean> {
  try {
    return await isLocalDeploymentOperator(principal)
  } catch {
    return false
  }
}

export const requireLocalDeploymentOperatorMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  if (!await isLocalDeploymentOperator({ user: c.get("user"), session: c.get("session"), apiKey: c.get("apiKey") })) {
    return c.json({ error: "forbidden" }, 403)
  }
  await next()
}

/**
 * Platform admin authority reaches every organization, so it belongs to the
 * admin's own sign-in. An API key outlives the session that made it and an MCP
 * token acts for an agent, so neither is accepted, even from an allowlisted
 * user. Changes also need a recent sign-in, with the same `reauth` response as
 * sensitive organization settings; reading does not.
 */
export const requireAdminMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  const user = c.get("user")
  if (!user?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  const session = c.get("session")
  if (!hasUserSession({ user, session, apiKey: c.get("apiKey") })) {
    return c.json({
      error: "forbidden",
      message: "Use a signed-in user session for this operation.",
    }, 403) as never
  }

  const email = normalizeEmail(user.email)
  if (!email) {
    return c.json({ error: "admin_email_required" }, 403) as never
  }

  // The allowlist names emails, so where Den verifies emails only a proven
  // address counts. Deployments without verification have no proof to ask for.
  if (env.requireEmailVerification && user.emailVerified !== true) {
    return c.json({ error: "admin_email_unverified" }, 403) as never
  }

  if (!(await isAdminEmailAllowed(email))) {
    return c.json({ error: "forbidden" }, 403) as never
  }

  if (!ADMIN_READ_METHODS.has(c.req.method.toUpperCase())) {
    const fresh = checkFreshPrivilegedSession({ apiKey: null, session })
    if (!fresh.ok) {
      return c.json({ ...fresh.response, message: PLATFORM_ADMIN_REAUTH_SECURITY_MESSAGE }, 403) as never
    }
  }

  // Routes declared `path:<param>` attribute audit evidence to the validated
  // target organization with this platform admin as actor (origin platform_admin).
  const auditBlocked = await beginAuditRequest(c, { platformAdminUserId: user.id })
  if (auditBlocked) {
    return auditBlocked as never
  }

  await next()
}
