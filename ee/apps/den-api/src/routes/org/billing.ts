import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { getCloudWorkerBillingStatus } from "../../billing/polar.js"
import { createInferenceCheckoutSession, createInferencePortalSession, createSeatCheckoutSession, getOrgBillingSummary, syncSeatCheckoutSession } from "../../stripe-billing.js"
import { orgMemberRoute, orgRoleRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { getRequiredUserEmail } from "../../user.js"
import { env } from "../../env.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOwner } from "./shared.js"

const stripeBillingResponseSchema = z.object({}).passthrough().meta({ ref: "OrgStripeBillingResponse" })
const stripeCheckoutRequestSchema = z.object({ type: z.enum(["inference", "seat"]).optional() })
const stripeCheckoutResponseSchema = z.object({ url: z.string() }).meta({ ref: "OrgStripeCheckoutResponse" })
const stripeCheckoutSyncRequestSchema = z.object({ sessionId: z.string().trim().min(1) })
const stripeCheckoutSyncResponseSchema = z.object({ synced: z.boolean() }).meta({ ref: "OrgStripeCheckoutSyncResponse" })
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
  // `return=models` sends the user back to the OpenWork Models page after a
  // successful inference checkout — that's where they subscribed from and
  // where the unlocked value (the model lineup) is visible. The billing page
  // remains the status/portal view.
  return env.stripe.billingSuccessUrl ?? `${getRequestOrigin(c)}/dashboard/billing/stripe/checking?session_id={CHECKOUT_SESSION_ID}&return=models`
}

function appendSeatCheckoutParams(input: string) {
  const separator = input.includes("?") ? "&" : "?"
  const sessionParam = input.includes("session_id=") ? "" : "&session_id={CHECKOUT_SESSION_ID}"
  return `${input}${separator}stripe_checkout=seat${sessionParam}`
}

function seatCheckoutReturnUrl(c: { req: { raw: Request } }) {
  const configured = env.stripe.billingSuccessUrl ?? env.stripe.billingCancelUrl
  if (!configured) {
    return billingReturnUrl(c)
  }

  try {
    const url = new URL(configured, getRequestOrigin(c))
    if (url.pathname.includes("/dashboard/billing")) {
      url.pathname = "/dashboard/billing"
    }
    url.search = ""
    url.hash = ""
    return url.toString()
  } catch {
    return billingReturnUrl(c)
  }
}

function seatCheckoutSuccessUrl(c: { req: { raw: Request } }) {
  return appendSeatCheckoutParams(seatCheckoutReturnUrl(c))
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
    orgMemberRoute(),
    async (c) => {
      const user = c.get("user")
      const payload = c.get("organizationContext")
      const email = getRequiredUserEmail(user)
      const billing = await getOrgBillingSummary({
        organizationId: payload.organization.id,
        includePortalUrl: true,
        returnUrl: billingReturnUrl(c),
      })
      const polar = email
        ? await getCloudWorkerBillingStatus({
            userId: user.id,
            email,
            name: user.name ?? email,
          }, {
            includePortalUrl: true,
            includeInvoices: false,
          }).catch(() => null)
        : null

      return c.json({ billing: { ...billing, polar } })
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
    orgRoleRoute(["owner"]),
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
      const body = await c.req.json().catch(() => ({}))
      const parsed = stripeCheckoutRequestSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "invalid_request", details: parsed.error }, 400)
      }
      const payload = c.get("organizationContext")
      const subscriptionType = parsed.data.type ?? "inference"
      const createCheckoutSession = subscriptionType === "seat" ? createSeatCheckoutSession : createInferenceCheckoutSession
      const session = await createCheckoutSession({
        organizationId: payload.organization.id,
        orgMemberId: payload.currentMember.id,
        email,
        name: user.name ?? email,
        successUrl: subscriptionType === "seat" ? seatCheckoutSuccessUrl(c) : checkoutSuccessUrl(c),
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
    orgRoleRoute(["owner"]),
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

  app.post(
    "/v1/billing/stripe/checkout/sync",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Sync a completed Stripe Checkout session",
      responses: {
        200: jsonResponse("Stripe Checkout session synced successfully.", stripeCheckoutSyncResponseSchema),
        401: jsonResponse("The caller must be signed in to sync billing.", unauthorizedSchema),
        403: jsonResponse("Only workspace owners can sync billing.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["owner"]),
    async (c) => {
      const permission = ensureOwner(c)
      if (!permission.ok) {
        return c.json(permission.response, 403)
      }
      const body = await c.req.json().catch(() => ({}))
      const parsed = stripeCheckoutSyncRequestSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "invalid_request", details: parsed.error }, 400)
      }
      const payload = c.get("organizationContext")
      const row = await syncSeatCheckoutSession({
        organizationId: payload.organization.id,
        sessionId: parsed.data.sessionId,
      }).catch((error) => {
        if (error instanceof Error && (error.message === "stripe_checkout_session_org_mismatch" || error.message.includes("No such checkout.session"))) {
          return "org_mismatch"
        }
        throw error
      })
      if (row === "org_mismatch") {
        return c.json({ error: "stripe_checkout_session_not_found" }, 404)
      }
      return c.json({ synced: Boolean(row) })
    },
  )
}
