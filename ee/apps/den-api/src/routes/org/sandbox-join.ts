import { sandboxJoinedSchema, sandboxJoinPreviewSchema } from "@openwork/types/den/sandbox-organizations"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { attributeAuditRequest, auditSessionUserAttribution } from "../../audit/request-capture.js"
import { env } from "../../env.js"
import { jsonValidator, publicRoute, queryValidator, userSessionRoute } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { validateInvitationAcceptVerification } from "../../organization-join-verification.js"
import { requestClientIpKey } from "../../request-client-ip.js"
import { joinSandbox, previewSandboxJoin } from "../../sandbox-organizations.js"
import { getRequiredUserEmail } from "../../user.js"
import { checkRateLimit } from "../../utils/rate-limit.js"
import { setRequestActiveOrganization } from "./core.js"
import type { OrgRouteVariables } from "./shared.js"

const tokenSchema = z.object({ token: z.string().trim().min(1).max(64) }).strict()
const errorSchema = z.object({ error: z.string(), message: z.string() })
const JOIN_RATE_LIMIT_MAX = 20
const JOIN_RATE_LIMIT_WINDOW_MS = 10 * 60_000

const notFound = { error: "sandbox_not_found", message: "This sandbox link is not valid. Ask for a new link." } as const

export function registerOrgSandboxJoinRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/sandbox-join/preview",
    describeRoute({
      tags: ["Sandbox organizations"],
      security: [],
      summary: "Preview a sandbox join link",
      description: "Returns the sandbox organization's name, whether it is still accepting people, when it ends and which workplace apps it connects.",
      responses: {
        200: jsonResponse("Sandbox preview.", sandboxJoinPreviewSchema),
        400: jsonResponse("Invalid link.", invalidRequestSchema),
        404: jsonResponse("Unknown link, or sandbox organizations are unavailable on this deployment.", errorSchema),
        429: jsonResponse("Too many attempts.", errorSchema),
      },
    }),
    publicRoute,
    queryValidator(tokenSchema),
    async (c) => {
      if (env.features.deployment !== "cloud") return c.json(notFound, 404)
      const retryAfter = await checkRateLimit(`sandbox-join-preview:${requestClientIpKey(c.req.raw.headers)}`, JOIN_RATE_LIMIT_MAX * 3, JOIN_RATE_LIMIT_WINDOW_MS, Date.now())
      if (retryAfter !== null) return c.json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." }, 429)
      const preview = await previewSandboxJoin(c.req.valid("query").token)
      if (!preview) return c.json(notFound, 404)
      // The token proves the organization; the read is attributed there with an unknown actor. The token is never recorded.
      await attributeAuditRequest(c, { organizationId: preview.organizationId, actor: { type: "unknown", id: null }, principalKey: "unknown:sandbox_join_token" })
      c.header("Cache-Control", "no-store")
      return c.json({ organizationName: preview.organizationName, state: preview.state, joinRole: preview.joinRole, expiresAt: preview.expiresAt, connectors: preview.connectors })
    },
  )

  app.post(
    "/v1/sandbox-join",
    describeRoute({
      tags: ["Sandbox organizations"],
      security: [{ bearerAuth: [] }],
      summary: "Join a sandbox organization",
      description: "Joins the signed-in person to the sandbox organization with the sandbox's join role (member, or admin when its admin chose that) and makes it their active organization. Joining again is harmless and never changes an existing role.",
      responses: {
        200: jsonResponse("Joined.", sandboxJoinedSchema),
        400: jsonResponse("Invalid request.", invalidRequestSchema),
        401: jsonResponse("Sign in first.", unauthorizedSchema),
        403: jsonResponse("Verify your email first, or this account was removed from the sandbox.", forbiddenSchema),
        404: jsonResponse("Unknown link, or sandbox organizations are unavailable on this deployment.", notFoundSchema),
        409: jsonResponse("The sandbox is closed, ended, full, or limited to other email domains.", errorSchema),
        429: jsonResponse("Too many attempts.", errorSchema),
      },
    }),
    userSessionRoute(),
    jsonValidator(tokenSchema),
    async (c) => {
      if (env.features.deployment !== "cloud") return c.json(notFound, 404)
      const user = c.get("user")
      const retryAfter = await checkRateLimit(`sandbox-join:${user.id}`, JOIN_RATE_LIMIT_MAX, JOIN_RATE_LIMIT_WINDOW_MS, Date.now())
      if (retryAfter !== null) return c.json({ error: "rate_limited", message: "Too many attempts. Try again in a few minutes." }, 429)
      const email = getRequiredUserEmail(user)
      if (!email) return c.json({ error: "user_email_required", message: "Your account needs an email address to join." }, 400)
      const verification = validateInvitationAcceptVerification({ emailVerified: user.emailVerified, emailVerificationRequired: env.requireEmailVerification })
      if (!verification.ok) return c.json({ error: verification.error, message: verification.message }, 403)

      const preview = await previewSandboxJoin(c.req.valid("json").token)
      if (!preview) return c.json(notFound, 404)
      const attribution = auditSessionUserAttribution(user.id)
      if (attribution) {
        const audited = await attributeAuditRequest(c, { organizationId: preview.organizationId, ...attribution })
        if (!audited.ok) return audited.response
      }

      const result = await joinSandbox({ token: c.req.valid("json").token, userId: user.id, email, emailVerified: user.emailVerified === true })
      switch (result.status) {
        case "joined":
          await setRequestActiveOrganization(c, result.organizationId)
          return c.json({ organizationId: result.organizationId, alreadyMember: result.alreadyMember })
        case "not_found":
          return c.json(notFound, 404)
        case "email_verification_required":
          return c.json({ error: "email_verification_required", message: "Verify your email address before joining this sandbox." }, 403)
        case "removed":
          return c.json({ error: "membership_removed", message: "Your access to this sandbox was removed." }, 403)
        case "closed":
          return c.json({ error: "sandbox_closed", message: "This sandbox is closed and is not accepting people." }, 409)
        case "expired":
          return c.json({ error: "sandbox_expired", message: "This sandbox has ended." }, 409)
        case "full":
          return c.json({ error: "sandbox_full", message: "This sandbox is full." }, 409)
        case "domain_not_allowed":
          return c.json({ error: "account_email_domain_not_allowed", message: `This sandbox only allows email addresses from ${result.allowedEmailDomains.join(", ")}.` }, 409)
      }
    },
  )
}
