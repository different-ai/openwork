import type { MiddlewareHandler } from "hono"
import type { AuthContextVariables } from "../session.js"
import { findPreclaimWorkspaceForUser, preclaimActionAllowed, requiresClaimError } from "../workspace-preclaim.js"

export const preclaimScopeMiddleware: MiddlewareHandler<{ Variables: AuthContextVariables }> = async (c, next) => {
  const user = c.get("user")
  if (!user?.id) return next()
  const workspace = await findPreclaimWorkspaceForUser({ userId: user.id, email: user.email })
  if (!workspace) return next()
  if (workspace.status !== "provisional") {
    return c.json({ ...requiresClaimError("This action"), message: "This workspace was claimed. Its setup agent can no longer act for it.", code: "requires_claim" }, 403)
  }
  const raw = c.req.raw
  const allowed = await preclaimActionAllowed({
    method: raw.method,
    path: c.req.path,
    readJson: () => raw.clone().json(),
  })
  if (allowed) return next()
  c.header("WWW-Authenticate", 'Bearer error="insufficient_scope", error_description="requires_claim"')
  return c.json(requiresClaimError("This action"), 403)
}
