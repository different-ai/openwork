import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { createInferenceCheckoutSession, createInferencePortalSession, getOrgBillingSummary } from "../../stripe-billing.js"
import { requireUserMiddleware, resolveOrganizationContextMiddleware } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { getRequiredUserEmail } from "../../user.js"
import { env } from "../../env.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOwner } from "./shared.js"

const stripeBillingResponseSchema = z.object({}).passthrough().meta({ ref: "OrgStripeBillingResponse" })
const stripeCheckoutResponseSchema = z.object({ url: z.string() }).meta({ ref: "OrgStripeCheckoutResponse" })
const stripePortalResponseSchema = z.object({ url: z.string() }).meta({ ref: "OrgStripePortalResponse" })

function getRequestOrigin(c: { req: { raw: Request } }) {
  const url = new URL(c.req.raw.url)
  const forwardedProto = c.req.raw.headers.get("x-forwarded-proto")?.split(",")[0]?.trim()
  const forwardedHost = c.req.raw.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  if (forwardedHost) {
    return `${forwardedProto || url.protocol.replace(/:$/, "")}://${forwardedHost}`
  }
  return `${url.protocol}//${url.host}`
}

function billingReturnUrl(c: { req: { raw: Request } }) {
  return `${getRequestOrigin(c)}/dashboard/billing`
}

function checkoutSuccessUrl(c: { req: { raw: Request } }) {
  return env.stripe.billingSuccessUrl ?? `${getRequestOrigin(c)}/dashboard/billing/stripe/checking?session_id={CHECKOUT_SESSION_ID}`
}

function checkoutCancelUrl(c: { req: { raw: Request } }) {
  return env.stripe.billingCancelUrl ?? billingReturnUrl(c)
}

export function registerOrgBillingRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/billing",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Get organization billing status",
      responses: {
        200: jsonResponse("Organization billing status returned successfully.", stripeBillingResponseSchema),
        401: jsonResponse("The caller must be signed in to read billing settings.", unauthorizedSchema),
      },
    }),
    requireUserMiddleware,
    resolveOrganizationContextMiddleware,
    async (c) => {
      const payload = c.get("organizationContext")
      const billing = await getOrgBillingSummary({
        organizationId: payload.organization.id,
        includePortalUrl: true,
        returnUrl: billingReturnUrl(c),
      })
      return c.json({ billing })
    },
  )

  app.post(
    "/v1/billing/stripe/checkout",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Create Stripe Checkout session for OpenWork Models",
      responses: {
        200: jsonResponse("Stripe Checkout session created successfully.", stripeCheckoutResponseSchema),
        401: jsonResponse("The caller must be signed in to start billing.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can start billing.", forbiddenSchema),
      },
    }),
    requireUserMiddleware,
    resolveOrganizationContextMiddleware,
    async (c) => {
      const permission = ensureOwner(c)
      if (!permission.ok) {
        return c.json(permission.response, 403)
      }
      const user = c.get("user")
      const email = getRequiredUserEmail(user)
      if (!email) {
        return c.json({ error: "user_email_required" }, 400)
      }
      const payload = c.get("organizationContext")
      const session = await createInferenceCheckoutSession({
        organizationId: payload.organization.id,
        orgMemberId: payload.currentMember.id,
        email,
        name: user.name ?? email,
        successUrl: checkoutSuccessUrl(c),
        cancelUrl: checkoutCancelUrl(c),
      })
      return c.json({ url: session.url })
    },
  )

  app.post(
    "/v1/billing/stripe/portal",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Create Stripe billing portal session for OpenWork Models",
      responses: {
        200: jsonResponse("Stripe billing portal session created successfully.", stripePortalResponseSchema),
        401: jsonResponse("The caller must be signed in to manage billing.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can manage billing.", forbiddenSchema),
      },
    }),
    requireUserMiddleware,
    resolveOrganizationContextMiddleware,
    async (c) => {
      const permission = ensureOwner(c)
      if (!permission.ok) {
        return c.json(permission.response, 403)
      }
      const payload = c.get("organizationContext")
      const session = await createInferencePortalSession({
        organizationId: payload.organization.id,
        returnUrl: billingReturnUrl(c),
      })
      return c.json({ url: session.url })
    },
  )
}
