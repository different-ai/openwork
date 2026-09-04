import type { Context, Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import { modelPromotionTermsSchema } from "@openwork/types/den/model-promotions"
import { PromotionError } from "@openwork-ee/model-promotions"
import { adminRoute, jsonValidator, orgRoleRoute, publicRoute, userSessionRoute } from "../middleware/index.js"
import { modelPromotions, promotionCheckout, reconcilePromotionRequest, syncPromotionCheckout, validateCampaign } from "../model-promotions.js"
import { env } from "../env.js"
import type { OrgRouteVariables } from "./org/shared.js"
import { hasFreshPrivilegedSession } from "./org/shared.js"

const cookie = "openwork_model_offer"
function identity(c: { get: <K extends "organizationContext" | "user">(key: K) => OrgRouteVariables[K] }) {
  const org = c.get("organizationContext")
  const user = c.get("user")
  if (!org || !user) throw new PromotionError("membership_required", "An active workspace membership is required.", 403)
  return { userId: user.id, organizationId: org.organization.id, memberId: org.currentMember.id }
}
const writeGuard = async (c: Context<{ Variables: OrgRouteVariables }>, next: () => Promise<void>) => {
  if (!hasFreshPrivilegedSession({ session: c.get("session") })) return c.json({ error: "reauth", reason: "fresh_auth_required", message: "Confirm your identity before managing promotions." }, 403)
  await next()
}

export function registerModelPromotionRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.use("/v1/model-offers/*", bodyLimit({ maxSize: 16384 }))
  app.use("/v1/admin/model-promotions/*", bodyLimit({ maxSize: 16384 }))
  app.use("/v1/admin/model-promotions", bodyLimit({ maxSize: 16384 }))
  app.get("/v1/model-offers/public/:slug", publicRoute, async (c) => {
    c.header("Cache-Control", "no-store")
    const offer = await modelPromotions.publicOffer(c.req.param("slug"))
    return c.json({ offer })
  })
  app.post("/v1/model-offers/public/:slug/visit", publicRoute, async (c) => {
    const origin = c.req.header("origin")
    if (!origin || origin !== new URL(env.betterAuthUrl).origin) return c.json({ error: "origin_not_allowed" }, 403)
    const token = await modelPromotions.visit(c.req.param("slug"))
    setCookie(c, cookie, token, { httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", path: "/", maxAge: 86400 })
    return c.json({ recorded: true })
  })
  app.get("/v1/model-offers", orgRoleRoute(["member"]), async (c) => {
    c.header("Cache-Control", "no-store")
    return c.json(await modelPromotions.offers(identity(c)))
  })
  app.post("/v1/model-offers/:id/checkout", orgRoleRoute(["admin"]), userSessionRoute(), jsonValidator(z.object({ version: z.number().int().positive() }).strict()), async (c) => {
    const user = c.get("user")
    return c.json(await promotionCheckout({ campaignId: c.req.param("id"), version: c.req.valid("json").version, identity: identity(c),
      visit: getCookie(c, cookie), email: user.email, name: user.name ?? user.email, origin: new URL(env.betterAuthUrl).origin }))
  })
  app.post("/v1/model-offers/grants/:id/refresh", orgRoleRoute(["member"]), userSessionRoute(), async (c) => {
    const grant = await modelPromotions.findGrant(c.req.param("id"))
    const person = identity(c)
    if (!grant || grant.user_id !== person.userId || grant.organization_id !== person.organizationId || grant.member_id !== person.memberId) return c.json({ error: "grant_not_found" }, 404)
    if (grant.stripe_session_id?.startsWith("cs_")) await syncPromotionCheckout(grant.stripe_session_id)
    return c.json(await modelPromotions.offers(person))
  })
  app.post("/v1/model-offers/grants/:id/activate", orgRoleRoute(["member"]), userSessionRoute(), async (c) => c.json({ grant: await modelPromotions.activate(c.req.param("id"), identity(c)) }))

  app.get("/v1/admin/model-promotions", adminRoute(), async (c) => c.json({ campaigns: await modelPromotions.adminList() }))
  app.get("/v1/admin/model-promotions/:id", adminRoute(), async (c) => c.json(await modelPromotions.adminDetail(c.req.param("id"))))
  app.post("/v1/admin/model-promotions", adminRoute(), userSessionRoute(), writeGuard, jsonValidator(z.object({ slug: z.string(), terms: modelPromotionTermsSchema, key: z.string().trim().min(16).max(1024) }).strict()), async (c) => c.json({ id: await modelPromotions.create(c.req.valid("json"), c.get("user").id) }, 201))
  app.put("/v1/admin/model-promotions/:id", adminRoute(), userSessionRoute(), writeGuard, jsonValidator(z.object({ terms: modelPromotionTermsSchema }).strict()), async (c) => {
    await modelPromotions.update(c.req.param("id"), c.req.valid("json").terms, c.get("user").id)
    return c.json({ updated: true })
  })
  app.post("/v1/admin/model-promotions/:id/status", adminRoute(), userSessionRoute(), writeGuard, jsonValidator(z.object({ status: z.enum(["draft", "active", "paused", "stopped"]) }).strict()), async (c) => {
    await modelPromotions.changeStatus(c.req.param("id"), c.req.valid("json").status, c.get("user").id, validateCampaign)
    return c.json({ updated: true })
  })
  app.post("/v1/admin/model-promotions/grants/:id/revoke", adminRoute(), userSessionRoute(), writeGuard, async (c) => {
    await modelPromotions.revoke(c.req.param("id"), c.get("user").id)
    return c.json({ revoked: true })
  })
  app.post("/v1/admin/model-promotions/requests/:id/reconcile", adminRoute(), userSessionRoute(), writeGuard, async (c) => {
    await reconcilePromotionRequest(c.req.param("id"))
    return c.json({ reconciled: true })
  })
}
