import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireUserMiddleware, resolveUserOrganizationsMiddleware, type UserOrganizationsContext } from "../../middleware/index.js"
import { denTypeIdSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const meResponseSchema = z.object({
  user: z.object({}).passthrough(),
  session: z.object({}).passthrough(),
}).meta({ ref: "CurrentUserResponse" })

const meOrganizationsResponseSchema = z.object({
  orgs: z.array(z.object({
    id: denTypeIdSchema("organization"),
    isActive: z.boolean(),
  }).passthrough()),
  activeOrgId: denTypeIdSchema("organization").nullable(),
  activeOrgSlug: z.string().nullable(),
}).meta({ ref: "CurrentUserOrganizationsResponse" })

export function registerMeRoutes<T extends { Variables: AuthContextVariables & Partial<UserOrganizationsContext> }>(app: Hono<T>) {
  app.get(
    "/v1/me",
    describeRoute({
      tags: ["Users"],
      summary: "Get current user",
      description: "Returns the currently authenticated user and active session details for the caller.",
      responses: {
        200: jsonResponse("Current user and session returned successfully.", meResponseSchema),
        401: jsonResponse("The caller must be signed in to read profile data.", unauthorizedSchema),
      },
    }),
    requireUserMiddleware,
    (c) => {
    return c.json({
      user: c.get("user"),
      session: c.get("session"),
    })
    },
  )

  app.get(
    "/v1/me/orgs",
    describeRoute({
      tags: ["Users"],
      summary: "List current user's organizations",
      description: "Lists the organizations visible to the current user and marks which organization is currently active.",
      responses: {
        200: jsonResponse("Current user organizations returned successfully.", meOrganizationsResponseSchema),
      },
    }),
    resolveUserOrganizationsMiddleware,
    (c) => {
    const orgs = (c.get("userOrganizations") ?? []) as NonNullable<UserOrganizationsContext["userOrganizations"]>

    return c.json({
      orgs: orgs.map((org) => ({
        ...org,
        isActive: org.id === c.get("activeOrganizationId"),
      })),
      activeOrgId: c.get("activeOrganizationId") ?? null,
      activeOrgSlug: c.get("activeOrganizationSlug") ?? null,
    })
    },
  )
}
