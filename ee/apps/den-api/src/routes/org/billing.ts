import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { ManagedModelsPolicyError } from "@openwork/types/den/managed-models-policy"
import {
  billingNotConfiguredErrorSchema,
  billingNotConfiguredMessage,
  checkoutStartResponseSchema,
  parseBillingReturnTo,
  planCheckoutRequestSchema,
  type BillingCheckoutReturnKind,
  type BillingNotConfiguredProduct,
  type BillingReturnTo,
} from "@openwork/types/den/billing-plans"
import {
  assertBillingProductConfigured,
  billingNotConfiguredProductForError,
  createInferenceCheckoutSession,
  createInferencePortalSession,
  createOpenWorkWebCheckout,
  createPlanCheckout,
  createSeatCheckoutSession,
  getOpenWorkWebBillingSummary,
  getOrgBillingSummary,
  PlanSubscriptionExistsError,
  syncStripeCheckoutSession,
} from "../../stripe-billing.js"
import { checkoutReturnUrls, defaultCheckoutReturnPageUrl } from "../../billing-plans.js"
import { orgMemberRoute, orgPermissionRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { getRequiredUserEmail } from "../../user.js"
import { env } from "../../env.js"
import { isOpenWorkWebAvailableForOrganization } from "../../openwork-web-availability.js"
import type { OrgRouteVariables } from "./shared.js"
import { orgAccessFailureStatus, permissionFailureHeaders, requirePermission } from "./shared.js"

const INFERENCE_SUBSCRIPTION_EXISTS_PORTAL_REQUIRED_MESSAGE = "OpenWork Models is already subscribed for this organization. Updating its payment method needs the “Open the billing portal” permission, so ask someone who has it, such as the owner."

const stripeBillingResponseSchema = z.object({}).passthrough().meta({ ref: "OrgStripeBillingResponse" })
const stripeCheckoutResponseSchema = checkoutStartResponseSchema.meta({ ref: "OrgStripeCheckoutResponse" })
const billingNotConfiguredSchema = billingNotConfiguredErrorSchema.meta({ ref: "BillingNotConfiguredError" })
const subscriptionExistsSchema = z.object({ error: z.literal("stripe_subscription_exists"), message: z.string() }).meta({ ref: "StripeSubscriptionExistsError" })
const stripeCheckoutSyncRequestSchema = z.object({ sessionId: z.string().trim().min(1) })
const stripeCheckoutSyncResponseSchema = z.object({ synced: z.boolean() }).meta({ ref: "OrgStripeCheckoutSyncResponse" })
const stripePortalResponseSchema = z.object({ url: z.string() }).meta({ ref: "OrgStripePortalResponse" })
const managedModelsPolicyErrorSchema = z.object({
  error: z.enum(["managed_models_disabled_for_dpa", "managed_models_policy_unavailable"]),
  message: z.string(),
})
const openWorkWebUnavailableSchema = z.object({
  error: z.literal("openwork_web_not_available"),
  message: z.string(),
}).meta({ ref: "OpenWorkWebUnavailableError" })

const retiredPolarBillingStatus = {
  featureGateEnabled: false,
  hasActivePlan: true,
  checkoutRequired: false,
  portalUrl: null,
  price: null,
  subscription: null,
  invoices: [],
}

function billingNotConfiguredResponse(product: BillingNotConfiguredProduct) {
  return { error: "billing_not_configured" as const, product, message: billingNotConfiguredMessage(product) }
}

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

/** Den web origin for return pages: the configured billing URL's origin, else the request's. */
function checkoutReturnOrigin(c: { req: { raw: Request } }) {
  const configured = env.stripe.billingSuccessUrl
  if (configured) {
    try {
      return new URL(configured, getRequestOrigin(c)).origin
    } catch {
      // Fall back to the request origin.
    }
  }
  return getRequestOrigin(c)
}

function planCheckoutDefaults(c: { req: { raw: Request } }) {
  return {
    successUrl: defaultCheckoutReturnPageUrl(checkoutReturnOrigin(c), "plan"),
    cancelUrl: `${checkoutReturnOrigin(c)}/dashboard/billing?checkout=canceled`,
  }
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
    orgMemberRoute(),
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
    orgPermissionRoute("billing.view"),
    async (c) => {
      const user = c.get("user")
      const payload = c.get("organizationContext")
      const email = getRequiredUserEmail(user)
      // The portal URL is a live Stripe session that can change billing, so it
      // needs the same check as POST /v1/billing/stripe/portal (billing_portal.use,
      // including the recent sign-in). Without it the URL is omitted; the read still succeeds.
      const portal = await requirePermission(c, "billing_portal.use")
      const billing = await getOrgBillingSummary({
        organizationId: payload.organization.id,
        includePortalUrl: portal.ok,
        returnUrl: billingReturnUrl(c),
      })
      // Den web still reads `billing.polar` as the cloud-worker access summary
      // (den-flow.ts getBillingSummary). Polar billing is retired, so this is
      // the constant "no gate, access allowed" shape it always had in practice.
      const polar = email ? retiredPolarBillingStatus : null

      return c.json({ billing: { ...billing, polar } })
    },
  )

  app.post(
    "/v1/billing/stripe/checkout",
    describeRoute({
      tags: ["Organizations"],
      hide: true,
      summary: "Create a Stripe Checkout session for OpenWork Models, seats, OpenWork Web or a plan",
      description: "type `plan` with `plan` team starts per-person Team billing for every counted person plus `addPeople`. Enterprise is never bought by card: a platform admin sets it in /admin. `returnTo` (`desktop` or a `/dashboard/...` path) chooses where the Den return page sends the buyer; anything else is ignored.",
      responses: {
        200: jsonResponse("Stripe Checkout session created successfully.", stripeCheckoutResponseSchema),
        400: jsonResponse("The checkout request was invalid.", z.object({ error: z.literal("invalid_request") }).passthrough()),
        401: jsonResponse("The caller must be signed in to start billing.", unauthorizedSchema),
        403: jsonResponse("Billing access is denied. When an OpenWork Models subscription already exists, the billing portal URL returned instead of a checkout needs the Open the billing portal permission and a recent sign-in.", z.union([forbiddenSchema, managedModelsPolicyErrorSchema])),
        404: jsonResponse("OpenWork Web is not available for this organization.", openWorkWebUnavailableSchema),
        409: jsonResponse("The organization already pays for this plan or product.", subscriptionExistsSchema),
        503: jsonResponse("This deployment does not sell the product (missing Stripe key or price), or Managed Models policy is unavailable.", z.union([billingNotConfiguredSchema, managedModelsPolicyErrorSchema])),
      },
    }),
    orgPermissionRoute("billing.manage"),
    async (c) => {
      const user = c.get("user")
      const email = getRequiredUserEmail(user)
      if (!email) {
        return c.json({ error: "user_email_required" }, 400)
      }
      const body = await c.req.json().catch(() => ({}))
      const parsed = planCheckoutRequestSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "invalid_request", details: parsed.error }, 400)
      }
      const payload = c.get("organizationContext")
      const subscriptionType = parsed.data.type ?? "inference"
      const returnTo: BillingReturnTo | null = parseBillingReturnTo(parsed.data.returnTo)
      const origin = checkoutReturnOrigin(c)

      if (subscriptionType === "plan") {
        const plan = parsed.data.plan
        if (!plan) {
          return c.json({ error: "invalid_request", message: "Choose the plan to buy: team." }, 400)
        }
        const urls = checkoutReturnUrls({ origin, kind: "plan", returnTo, defaults: planCheckoutDefaults(c) })
        const result = await createPlanCheckout({
          organizationId: payload.organization.id,
          orgMemberId: payload.currentMember.id,
          email,
          name: user.name ?? email,
          plan,
          addPeople: parsed.data.addPeople ?? 0,
          successUrl: urls.successUrl,
          cancelUrl: urls.cancelUrl,
        }).catch((error: unknown) => {
          if (error instanceof PlanSubscriptionExistsError) return error
          const product = billingNotConfiguredProductForError(error, plan)
          if (product) return { notConfigured: product }
          throw error
        })
        if (result instanceof PlanSubscriptionExistsError) {
          return c.json({
            error: "stripe_subscription_exists" as const,
            message: result.reason === "same_plan"
              ? "This organization is already on Team. Manage it from Billing."
              : "Stripe is still collecting this organization's plan payment. Update the payment method from Billing.",
          }, 409)
        }
        if ("notConfigured" in result) {
          return c.json(billingNotConfiguredResponse(result.notConfigured), 503)
        }
        return c.json({ url: result.url })
      }

      if (subscriptionType === "web" && !isOpenWorkWebAvailableForOrganization(payload.organization.metadata)) {
        return c.json(openWorkWebUnavailableResponse(), 404)
      }
      const product: BillingNotConfiguredProduct = subscriptionType
      try {
        assertBillingProductConfigured(product)
      } catch {
        return c.json(billingNotConfiguredResponse(product), 503)
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
      const returnKind: BillingCheckoutReturnKind = subscriptionType === "inference" ? "models" : subscriptionType
      const urls = checkoutReturnUrls({
        origin,
        kind: returnKind,
        returnTo,
        defaults: {
          successUrl: subscriptionType === "seat"
            ? seatCheckoutSuccessUrl(c)
            : subscriptionType === "web"
              ? openWorkWebCheckoutSuccessUrl(c)
              : checkoutSuccessUrl(c),
          cancelUrl: subscriptionType === "web" ? openWorkWebCheckoutCancelUrl(c) : checkoutCancelUrl(c),
        },
      })
      const session = await createCheckoutSession({
        organizationId: payload.organization.id,
        orgMemberId: payload.currentMember.id,
        email,
        name: user.name ?? email,
        successUrl: urls.successUrl,
        cancelUrl: urls.cancelUrl,
      }).catch((error) => {
        if (error instanceof ManagedModelsPolicyError) return error
        if (error instanceof Error && error.message === "stripe_openwork_web_subscription_exists") {
          return "subscription_exists" as const
        }
        if (error instanceof Error && error.message === "stripe_inference_subscription_exists") {
          return "inference_subscription_exists" as const
        }
        const notConfigured = billingNotConfiguredProductForError(error, product)
        if (notConfigured) return { notConfigured }
        throw error
      })
      if (session instanceof ManagedModelsPolicyError) {
        return c.json({ error: session.code, message: session.message }, session.status)
      }
      if (session === "subscription_exists") {
        return c.json({
          error: "stripe_subscription_exists",
          message: "OpenWork Web is already subscribed for this organization. Manage it from Billing.",
        }, 409)
      }
      if (session === "inference_subscription_exists") {
        // The organization already has an OpenWork Models subscription Stripe
        // is still collecting on (typically past due after a failed renewal).
        // A second Checkout would charge them twice, so hand them the billing
        // portal where the payment method can be fixed instead. The portal URL
        // is a live Stripe session that can change billing, so it needs the
        // same check as POST /v1/billing/stripe/portal (billing_portal.use with
        // a recent sign-in); Start a subscription alone never returns it.
        const portalAccess = await requirePermission(c, "billing_portal.use")
        if (!portalAccess.ok) {
          const failure = portalAccess.response.error === "forbidden"
            ? { ...portalAccess.response, message: INFERENCE_SUBSCRIPTION_EXISTS_PORTAL_REQUIRED_MESSAGE }
            : portalAccess.response
          return c.json(failure, orgAccessFailureStatus(failure), permissionFailureHeaders(failure))
        }
        const portal = await createInferencePortalSession({
          organizationId: payload.organization.id,
          returnUrl: billingReturnUrl(c),
        }).catch(() => null)
        if (portal?.url) {
          return c.json({ url: portal.url })
        }
        return c.json({
          error: "stripe_subscription_exists",
          message: "OpenWork Models is already subscribed for this organization. Update the payment method from Billing.",
        }, 409)
      }
      if ("notConfigured" in session) {
        return c.json(billingNotConfiguredResponse(session.notConfigured), 503)
      }
      if (!session.url) {
        throw new Error("stripe_checkout_url_missing")
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
        403: jsonResponse("The caller needs the Open the billing portal permission and a recent sign-in.", forbiddenSchema),
        404: jsonResponse("The organization has no Stripe billing account yet.", notFoundSchema),
        503: jsonResponse("This deployment does not sell anything through Stripe.", billingNotConfiguredSchema),
      },
    }),
    orgPermissionRoute("billing_portal.use"),
    async (c) => {
      const payload = c.get("organizationContext")
      try {
        assertBillingProductConfigured("portal")
      } catch {
        return c.json(billingNotConfiguredResponse("portal"), 503)
      }
      const session = await createInferencePortalSession({
        organizationId: payload.organization.id,
        returnUrl: billingReturnUrl(c),
      }).catch((error: unknown) => {
        if (error instanceof Error && error.message === "stripe_customer_missing") return "customer_missing" as const
        if (billingNotConfiguredProductForError(error, "portal")) return "not_configured" as const
        throw error
      })
      if (session === "customer_missing") {
        return c.json({ error: "stripe_customer_not_found", message: "This organization has no Stripe billing account yet. Start a subscription first." }, 404)
      }
      if (session === "not_configured") {
        return c.json(billingNotConfiguredResponse("portal"), 503)
      }
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
        403: jsonResponse("The caller needs the Start a subscription permission and a recent sign-in.", forbiddenSchema),
        503: jsonResponse("Managed Models policy is unavailable, or this deployment does not sell anything through Stripe (product `checkout`).", z.union([managedModelsPolicyErrorSchema, billingNotConfiguredSchema])),
      },
    }),
    orgPermissionRoute("billing.manage"),
    async (c) => {
      const body = await c.req.json().catch(() => ({}))
      const parsed = stripeCheckoutSyncRequestSchema.safeParse(body)
      if (!parsed.success) {
        return c.json({ error: "invalid_request", details: parsed.error }, 400)
      }
      try {
        assertBillingProductConfigured("checkout")
      } catch {
        return c.json(billingNotConfiguredResponse("checkout"), 503)
      }
      const payload = c.get("organizationContext")
      const row = await syncStripeCheckoutSession({
        organizationId: payload.organization.id,
        sessionId: parsed.data.sessionId,
      }).catch((error) => {
        if (error instanceof ManagedModelsPolicyError) return error
        if (error instanceof Error && (error.message === "stripe_checkout_session_org_mismatch" || error.message.includes("No such checkout.session"))) {
          return "org_mismatch"
        }
        if (billingNotConfiguredProductForError(error, "checkout")) return "not_configured"
        throw error
      })
      if (row instanceof ManagedModelsPolicyError) {
        return c.json({ error: row.code, message: row.message }, row.status)
      }
      if (row === "org_mismatch") {
        return c.json({ error: "stripe_checkout_session_not_found" }, 404)
      }
      if (row === "not_configured") {
        return c.json(billingNotConfiguredResponse("checkout"), 503)
      }
      return c.json({ synced: Boolean(row) })
    },
  )
}
