import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { getCloudWorkerBillingStatus } from "../../billing/polar.js"
import { createInferenceCheckoutSession, createInferencePortalSession, createOpenWorkWebCheckout, createSeatCheckoutSession, getOpenWorkWebBillingSummary, getOrgBillingSummary, syncStripeCheckoutSession } from "../../stripe-billing.js"
import { orgRoleRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { getRequiredUserEmail } from "../../user.js"
import { env } from "../../env.js"
import { ORGANIZATION_SUPER_ADMIN_ROLE, organizationRoleValueSatisfies } from "../../organization-role-hierarchy.js"
import { isOpenWorkWebAvailableForOrganization } from "../../openwork-web-availability.js"
import type { OrgRouteVariables } from "./shared.js"
import { ensureOrganizationAdmin, ensureOrganizationSuperAdmin, orgAccessFailureStatus } from "./shared.js"

const stripeBillingResponseSchema = z.object({}).passthrough().meta({ ref: "OrgStripeBillingResponse" })
const stripeCheckoutRequestSchema = z.object({ type: z.enum(["inference", "seat", "web"]).optional() })
const stripeCheckoutResponseSchema = z.object({ url: z.string() }).meta({ ref: "OrgStripeCheckoutResponse" })
const stripeCheckoutSyncRequestSchema = z.object({ sessionId: z.string().trim().min(1) })
const stripeCheckoutSyncResponseSchema = z.object({ synced: z.boolean() }).meta({ ref: "OrgStripeCheckoutSyncResponse" })
const stripePortalResponseSchema = z.object({ url: z.string() }).meta({ ref: "OrgStripePortalResponse" })
const openWorkWebUnavailableSchema = z.object({
  error: z.literal("openwork_web_not_available"),
  message: z.string(),
}).meta({ ref: "OpenWorkWebUnavailableError" })

function openWorkWebUnavailableResponse(): { error: "openwork_web_not_available"; message: string } {
  return {
    error: "openwork_web_not_available",
    message: "OpenWork Web is not available for this organization.",
  }
}

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

function openWorkWebCheckoutSuccessUrl(c: { req: { raw: Request } }) {
  const fallback = `${getRequestOrigin(c)}/dashboard/billing/stripe/checking?session_id={CHECKOUT_SESSION_ID}&return=web`
  const configured = env.stripe.billingSuccessUrl
  if (!configured) {
    return fallback
  }
  try {
    const url = new URL(configured, getRequestOrigin(c))
    url.pathname = "/dashboard/billing/stripe/checking"
    url.searchParams.set("session_id", "{CHECKOUT_SESSION_ID}")
    url.searchParams.set("return", "web")
    url.hash = ""
    return url.toString().replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}")
  } catch {
    return fallback
  }
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

function openWorkWebCheckoutCancelUrl(c: { req: { raw: Request } }) {
  const configured = env.stripe.billingCancelUrl
  try {
    const url = new URL(configured ?? getRequestOrigin(c), getRequestOrigin(c))
    url.pathname = "/dashboard/web"
    url.search = ""
    url.searchParams.set("stripe_checkout", "web")
    url.searchParams.set("canceled", "1")
    url.hash = ""
    return url.toString()
  } catch {
    return `${getRequestOrigin(c)}/dashboard/web?stripe_checkout=web&canceled=1`
  }
}

export function registerOrgBillingRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/billing/web",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Get OpenWork Web billing eligibility",
      responses: {
        200: jsonResponse("OpenWork Web billing eligibility returned successfully.", stripeBillingResponseSchema),
        401: jsonResponse("The caller must be an organization member.", unauthorizedSchema),
        404: jsonResponse("OpenWork Web is not available for this organization.", openWorkWebUnavailableSchema),
      },
    }),
    orgRoleRoute(["member"]),
    async (c) => {
      const payload = c.get("organizationContext")
      if (!isOpenWorkWebAvailableForOrganization(payload.organization.metadata)) {
        return c.json(openWorkWebUnavailableResponse(), 404)
      }
      const web = await getOpenWorkWebBillingSummary(payload.organization.id)
      return c.json({ billing: { stripe: { web } } })
    },
  )

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
    orgRoleRoute(["admin"]),
    async (c) => {
      const user = c.get("user")
      const payload = c.get("organizationContext")
      const email = getRequiredUserEmail(user)
      const canManageBilling = organizationRoleValueSatisfies({
        roleValue: payload.currentMember.role,
        requiredRole: ORGANIZATION_SUPER_ADMIN_ROLE,
        isOwner: payload.currentMember.isOwner,
      })
      const billing = await getOrgBillingSummary({
        organizationId: payload.organization.id,
        includePortalUrl: canManageBilling,
        returnUrl: billingReturnUrl(c),
      })
      const polar = email
        ? await getCloudWorkerBillingStatus({
            userId: user.id,
            email,
            name: user.name ?? email,
          }, {
            includePortalUrl: canManageBilling,
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
        403: jsonResponse("Only workspace owners and admins can start billing.", forbiddenSchema),
        404: jsonResponse("OpenWork Web is not available for this organization.", openWorkWebUnavailableSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    async (c) => {
      const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can start billing.")
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
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
      if (subscriptionType === "web" && !isOpenWorkWebAvailableForOrganization(payload.organization.metadata)) {
        return c.json(openWorkWebUnavailableResponse(), 404)
      }
      if (subscriptionType === "web") {
        const webBilling = await getOpenWorkWebBillingSummary(payload.organization.id)
        if (webBilling.complimentaryAccess) {
          return c.json({
            error: "openwork_web_complimentary_access_exists",
            message: "OpenWork Web is already included for this organization without a Stripe subscription.",
          }, 409)
        }
      }
      const createCheckoutSession = subscriptionType === "seat"
        ? createSeatCheckoutSession
        : subscriptionType === "web"
          ? createOpenWorkWebCheckout
          : createInferenceCheckoutSession
      const session = await createCheckoutSession({
        organizationId: payload.organization.id,
        orgMemberId: payload.currentMember.id,
        email,
        name: user.name ?? email,
        successUrl: subscriptionType === "seat"
          ? seatCheckoutSuccessUrl(c)
          : subscriptionType === "web"
            ? openWorkWebCheckoutSuccessUrl(c)
            : checkoutSuccessUrl(c),
        cancelUrl: subscriptionType === "web" ? openWorkWebCheckoutCancelUrl(c) : checkoutCancelUrl(c),
      }).catch((error) => {
        if (error instanceof Error && error.message === "stripe_openwork_web_subscription_exists") {
          return "subscription_exists" as const
        }
        throw error
      })
      if (session === "subscription_exists") {
        return c.json({
          error: "stripe_subscription_exists",
          message: "OpenWork Web is already subscribed for this organization. Manage it from Billing.",
        }, 409)
      }
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
        403: jsonResponse("Only workspace owners and super-admins can manage billing.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["super-admin"]),
    async (c) => {
      const permission = ensureOrganizationSuperAdmin(c, "Only workspace owners and super-admins can manage billing.")
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
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
        403: jsonResponse("Only workspace owners and admins can sync billing.", forbiddenSchema),
      },
    }),
    orgRoleRoute(["admin"]),
    async (c) => {
      const permission = ensureOrganizationAdmin(c, "Only workspace owners and admins can sync billing.")
      if (!permission.ok) {
        return c.json(permission.response, orgAccessFailureStatus(permission.response))
      }
      const body = await c.req.json().catch(() => ({}))
      const parsed = stripeCheckoutSyncRequestSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "invalid_request", details: parsed.error }, 400)
      }
      const payload = c.get("organizationContext")
      const row = await syncStripeCheckoutSession({
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
