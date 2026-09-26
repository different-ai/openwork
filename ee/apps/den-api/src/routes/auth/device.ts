import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { decideDeviceUserCode, lookupDeviceUserCode } from "../../device-authorization.js"
import { jsonValidator, paramValidator, userSessionRoute } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const userCodeParamsSchema = z.object({
  userCode: z.string().trim().min(4).max(32),
})

const deviceDecisionSchema = z.object({
  userCode: z.string().trim().min(4).max(32),
  decision: z.enum(["approve", "deny"]),
  organizationId: z.string().trim().min(1).max(128).optional(),
})

const deviceLookupResponseSchema = z.object({
  status: z.enum(["pending", "approved", "denied"]),
  clientId: z.string().nullable(),
  expiresAt: z.string(),
})

const deviceDecisionResponseSchema = z.object({
  status: z.enum(["approved", "denied"]),
})

const deviceErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
})

/**
 * Den web's `/device` page reads and decides RFC 8628 user codes through
 * these routes. The protocol endpoints the CLI calls stay on Better Auth
 * (`POST /api/auth/device/code`, `POST /api/auth/device/token`).
 */
export function registerDeviceAuthRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  app.get(
    "/v1/auth/device/:userCode",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      security: [{ bearerAuth: [] }],
      summary: "Look up a device sign-in code",
      description: "Returns whether a command-line sign-in code is still waiting for approval, for the signed-in person reviewing it.",
      responses: {
        200: jsonResponse("The code is known and not expired.", deviceLookupResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("The code is unknown or expired.", notFoundSchema),
      },
    }),
    userSessionRoute(),
    paramValidator(userCodeParamsSchema),
    async (c) => {
      const lookup = await lookupDeviceUserCode(c.req.valid("param").userCode)
      if (!lookup.ok) {
        return c.json({
          error: lookup.error,
          message: lookup.error === "expired_user_code"
            ? "This code has expired. Start sign-in again from your terminal."
            : "This code is not valid. Check it against your terminal.",
        }, 404)
      }
      return c.json({ status: lookup.status, clientId: lookup.clientId, expiresAt: lookup.expiresAt.toISOString() })
    },
  )

  app.post(
    "/v1/auth/device/decision",
    describeRoute({
      hide: true,
      tags: ["Authentication"],
      security: [{ bearerAuth: [] }],
      summary: "Approve or deny a device sign-in code",
      description: "Approves (optionally choosing the organization the new session starts in) or denies a pending command-line sign-in code for the signed-in person.",
      responses: {
        200: jsonResponse("The decision was recorded.", deviceDecisionResponseSchema),
        400: jsonResponse("The request body was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        403: jsonResponse("The caller is not a member of the chosen organization.", forbiddenSchema),
        404: jsonResponse("The code is unknown, expired, or bound to someone else.", deviceErrorSchema),
        409: jsonResponse("The code was already approved or denied.", deviceErrorSchema),
      },
    }),
    userSessionRoute(),
    jsonValidator(deviceDecisionSchema),
    async (c) => {
      const user = c.get("user")
      if (!user?.id) {
        return c.json({ error: "unauthorized" }, 401)
      }
      const input = c.req.valid("json")
      const result = await decideDeviceUserCode({
        userCode: input.userCode,
        userId: user.id,
        decision: input.decision,
        organizationId: input.organizationId ?? null,
      })
      if (!result.ok) {
        return c.json({ error: result.error, message: result.message }, result.status)
      }
      return c.json({ status: result.status })
    },
  )
}
