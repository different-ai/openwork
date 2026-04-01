import type { Hono } from "hono"
import { env } from "../../env.js"
import { jsonValidator, queryValidator, requireUserMiddleware, resolveUserOrganizationsMiddleware } from "../../middleware/index.js"
import { getRequiredUserEmail } from "../../user.js"
import type { WorkerRouteVariables } from "./shared.js"
import { billingQuerySchema, billingSubscriptionSchema, getWorkerBilling, setWorkerBillingSubscription, queryIncludesFlag } from "./shared.js"

export function registerWorkerBillingRoutes<T extends { Variables: WorkerRouteVariables }>(app: Hono<T>) {
  app.get("/v1/workers/billing", requireUserMiddleware, resolveUserOrganizationsMiddleware, queryValidator(billingQuerySchema), async (c) => {
    const user = c.get("user")
    const orgId = c.get("activeOrganizationId")
    const query = c.req.valid("query")
    const email = getRequiredUserEmail(user)

    if (!email) {
      return c.json({ error: "user_email_required" }, 400)
    }
    if (!orgId) {
      return c.json({ error: "organization_required" }, 409)
    }

    const billing = await getWorkerBilling({
      userId: user.id,
      orgId,
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
        workerProductId: env.polar.workerProductId,
        workerBenefitId: env.polar.workerBenefitId,
      },
    })
  })

  app.post("/v1/workers/billing/subscription", requireUserMiddleware, resolveUserOrganizationsMiddleware, jsonValidator(billingSubscriptionSchema), async (c) => {
    const user = c.get("user")
    const orgId = c.get("activeOrganizationId")
    const input = c.req.valid("json")
    const email = getRequiredUserEmail(user)

    if (!email) {
      return c.json({ error: "user_email_required" }, 400)
    }
    if (!orgId) {
      return c.json({ error: "organization_required" }, 409)
    }

    const billingInput = {
      userId: user.id,
      orgId,
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
        workerProductId: env.polar.workerProductId,
        workerBenefitId: env.polar.workerBenefitId,
      },
    })
  })
}
