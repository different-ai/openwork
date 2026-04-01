import type { Hono } from "hono"
import { requireUserMiddleware, resolveUserOrganizationsMiddleware, type UserOrganizationsContext } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"

export function registerMeRoutes<T extends { Variables: AuthContextVariables & Partial<UserOrganizationsContext> }>(app: Hono<T>) {
  app.get("/v1/me", requireUserMiddleware, (c) => {
    return c.json({
      user: c.get("user"),
      session: c.get("session"),
    })
  })

  app.get("/v1/me/orgs", resolveUserOrganizationsMiddleware, (c) => {
    const orgs = (c.get("userOrganizations") ?? []) as NonNullable<UserOrganizationsContext["userOrganizations"]>

    return c.json({
      orgs: orgs.map((org) => ({
        ...org,
        isActive: org.id === c.get("activeOrganizationId"),
      })),
      activeOrgId: c.get("activeOrganizationId") ?? null,
      activeOrgSlug: c.get("activeOrganizationSlug") ?? null,
    })
  })
}
