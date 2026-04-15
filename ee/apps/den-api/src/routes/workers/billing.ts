import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { jsonValidator, queryValidator, requireUserMiddleware } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { getRequiredUserEmail } from "../../user.js"
import type { WorkerRouteVariables } from "./shared.js"
import { billingQuerySchema, billingSubscriptionSchema, getWorkerBilling, setWorkerBillingSubscription, queryIncludesFlag } from "./shared.js"

const workerBillingPayloadSchema = z.object({
  status: z.string(),
  featureGateEnabled: z.boolean(),
  productId: z.string().nullable().optional(),
  benefitId: z.string().nullable().optional(),
}).passthrough()

const workerBillingResponseSchema = z.object({
  billing: workerBillingPayloadSchema,
}).meta({ ref: "WorkerBillingResponse" })

const workerBillingSubscriptionResponseSchema = z.object({
  subscription: z.object({}).passthrough(),
  billing: workerBillingPayloadSchema,
}).meta({ ref: "WorkerBillingSubscriptionResponse" })

const userEmailRequiredSchema = z.object({
  error: z.literal("user_email_required"),
}).meta({ ref: "UserEmailRequiredError" })

export function registerWorkerBillingRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/workers/billing",
    describeRoute({
      tags: ["Workers"],
      hide: true,
      summary: "Get worker billing status",
      description: "Returns billing and subscription status for the signed-in user's cloud worker access.",
      responses: {
        200: jsonResponse("Worker billing status returned successfully.", workerBillingResponseSchema),
        400: jsonResponse("The billing query parameters were invalid or the user is missing an email.", z.union([invalidRequestSchema, userEmailRequiredSchema])),
        401: jsonResponse("The caller must be signed in to read billing status.", unauthorizedSchema),
      },
    }),
    requireUserMiddleware,
    queryValidator(billingQuerySchema),
    async (c) => {
    const user = c.get("user")
    const query = c.req.valid("query")
    const email = getRequiredUserEmail(user)

    if (!email) {
      return c.json({ error: "user_email_required" }, 400)
    }

    const billing = await getWorkerBilling({
      userId: user.id,
      email,
      name: user.name ?? user.email ?? "OpenWork User",
      includeCheckoutUrl: queryIncludesFlag(query.includeCheckout),
      includePortalUrl: !queryIncludesFlag(query.excludePortal),
      includeInvoices: !queryIncludesFlag(query.excludeInvoices),
    })

    return c.json({
      billing: {
        ...billing,
        productId: env.polar.productId,
        benefitId: env.polar.benefitId,
      },
    })
    },
  )

  app.post(
    "/v1/workers/billing/subscription",
    describeRoute({
      tags: ["Workers"],
      hide: true,
      summary: "Update worker subscription settings",
      description: "Updates whether the user's cloud worker subscription should cancel at the end of the current billing period.",
      responses: {
        200: jsonResponse("Worker subscription settings updated successfully.", workerBillingSubscriptionResponseSchema),
        400: jsonResponse("The subscription update payload was invalid or the user is missing an email.", z.union([invalidRequestSchema, userEmailRequiredSchema])),
        401: jsonResponse("The caller must be signed in to update billing settings.", unauthorizedSchema),
      },
    }),
    requireUserMiddleware,
    jsonValidator(billingSubscriptionSchema),
    async (c) => {
    const user = c.get("user")
    const input = c.req.valid("json")
    const email = getRequiredUserEmail(user)

    if (!email) {
      return c.json({ error: "user_email_required" }, 400)
    }

    const billingInput = {
      userId: user.id,
      email,
      name: user.name ?? user.email ?? "OpenWork User",
    }

    const subscription = await setWorkerBillingSubscription({
      ...billingInput,
      cancelAtPeriodEnd: input.cancelAtPeriodEnd,
    })
    const billing = await getWorkerBilling({
      ...billingInput,
      includeCheckoutUrl: false,
      includePortalUrl: true,
      includeInvoices: true,
    })

    return c.json({
      subscription,
      billing: {
        ...billing,
        productId: env.polar.productId,
        benefitId: env.polar.benefitId,
      },
    })
    },
  )
}
