import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"
import { getRawBetterAuthMutationDenial } from "../../auth.js"
import { rawRefusalAttribution } from "../../audit/better-auth.js"
import { attributeAuditRequest } from "../../audit/request-capture.js"
import { publicRoute } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"

// Better Auth's custom-role endpoints are no longer registered (dynamicAccessControl
// is off), so hooks.before never sees them and Better Auth would answer 404 without
// any tenant evidence. Den shadows them so every attempt is still refused with the
// same 403 and recorded in the caller's own organization like the other raw
// mutations (rawRefusalAttribution: no intent, so audit can never change the 403).
export const RAW_ROLE_MUTATION_PATHS = [
  "/organization/create-role",
  "/organization/update-role",
  "/organization/delete-role",
] as const

const rawRoleMutationForbiddenSchema = z.object({
  error: z.literal("forbidden"),
  message: z.string(),
}).meta({ ref: "RawRoleMutationForbiddenError" })

function readOrganizationId(body: unknown) {
  if (typeof body !== "object" || body === null) return null
  const value = Object.getOwnPropertyDescriptor(body, "organizationId")?.value
  return typeof value === "string" && value.trim() ? value.trim() : null
}

// Every caller is refused (as better-auth's hooks.before refused them), so the route itself is public.
const refusedForEveryone: MiddlewareHandler<{ Variables: AuthContextVariables }> = publicRoute

export function registerRawRoleRefusalRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  for (const path of RAW_ROLE_MUTATION_PATHS) {
    const denial = getRawBetterAuthMutationDenial(path)
    if (!denial) throw new Error(`Raw role mutation ${path} must stay in the refused Better Auth paths.`)
    app.post(
      `/api/auth${path}`,
      describeRoute({
        hide: true,
        tags: ["Authentication"],
        summary: "Block raw organization role management",
        description: "Custom organization roles are not supported; Den refuses the raw Better Auth role endpoints for every caller.",
        responses: {
          403: {
            description: "Forbidden",
            content: { "application/json": { schema: resolver(rawRoleMutationForbiddenSchema) } },
          },
        },
      }),
      refusedForEveryone,
      async (c) => {
        const userId = c.get("user")?.id ?? null
        if (userId) {
          const attribution = await rawRefusalAttribution({
            userId,
            requestedOrganizationId: readOrganizationId(await c.req.json().catch(() => null)),
            activeOrganizationId: c.get("session")?.activeOrganizationId ?? null,
          })
          if (attribution) await attributeAuditRequest(c, attribution)
        }
        return c.json(denial, 403)
      },
    )
  }
}
