import { eq } from "@openwork-ee/den-db/drizzle"
import { AdminAllowlistTable, AuthUserTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { MiddlewareHandler } from "hono"
import { ensureAdminAllowlistSeeded } from "../admin-allowlist.js"
import { db } from "../db.js"
import type { AuthContextVariables } from "../session.js"

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

export const requireAdminMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  const user = c.get("user")
  if (!user?.id) {
    return c.json({ error: "unauthorized" }, 401) as never
  }

  const email = normalizeEmail(user.email)
  if (!email) {
    return c.json({ error: "admin_email_required" }, 403) as never
  }

  if (!(await isAdminEmailAllowed(email))) {
    return c.json({ error: "forbidden" }, 403) as never
  }

  await next()
}
