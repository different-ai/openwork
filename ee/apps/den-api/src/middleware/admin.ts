import { eq } from "@openwork-ee/den-db/drizzle"
import { AdminAllowlistTable, AuthUserTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { ensureAdminAllowlistSeeded } from "../admin-allowlist.js"
import { beginAuditRequest } from "../audit/request-capture.js"
import { db } from "../db.js"
import { env } from "../env.js"
import type { AuthContextVariables } from "../session.js"

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? ""
}

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

export async function isLocalDeploymentOperatorUserId(userId: string): Promise<boolean> {
  if (env.features.deployment !== "self_hosted") return false
  return isPlatformAdminUserId(userId)
}

type DeploymentPrincipal = Pick<AuthContextVariables, "apiKey" | "session" | "user">

export async function hasLocalDeploymentOperatorSessionAuthority(principal: DeploymentPrincipal): Promise<boolean> {
  if (principal.apiKey || !principal.user?.id || !principal.session?.id || !principal.session.token) return false
  try {
    normalizeDenTypeId("session", principal.session.id)
  } catch {
    return false
  }
  return isLocalDeploymentOperatorUserId(principal.user.id)
}

export async function isLocalDeploymentOperator(principal: DeploymentPrincipal): Promise<boolean> {
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

export async function canManageDeploymentServices(principal: DeploymentPrincipal): Promise<boolean> {
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

export const requireAdminMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  const user = c.get("user")
  if (!user?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  if (c.get("session")?.organizationScopeId) {
    return c.json({ error: "forbidden" }, 403)
  }

  const email = normalizeEmail(user.email)
  if (!email) {
    return c.json({ error: "admin_email_required" }, 403) as never
  }

  if (env.requireEmailVerification && user.emailVerified !== true) {
    return c.json({ error: "admin_email_unverified" }, 403) as never
  }

  if (!(await isAdminEmailAllowed(email))) {
    return c.json({ error: "forbidden" }, 403) as never
  }

  const auditBlocked = await beginAuditRequest(c, { platformAdminUserId: user.id })
  if (auditBlocked) {
    return auditBlocked as never
  }

  await next()
}
