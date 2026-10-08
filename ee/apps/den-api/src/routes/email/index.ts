import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { recordLifecycleUnsubscribe } from "../../lifecycle-emails/index.js"
import { verifyUnsubscribeToken } from "../../lifecycle-emails/policy.js"
import { publicRoute, queryValidator } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"

const unsubscribeQuerySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(255),
  token: z.string().trim().min(16).max(128),
})

function page(title: string, body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;background:#F0F1F3;color:#1C2024;margin:0;padding:64px 16px"><main style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E1E4E8;border-radius:16px;padding:32px"><h1 style="font-size:20px;margin:0 0 8px">${title}</h1><p style="color:#60646C;font-size:15px;line-height:24px;margin:0">${body}</p></main></body></html>`
}

/**
 * Lifecycle reminder unsubscribe. GET serves the link in the email footer;
 * POST serves RFC 8058 one-click unsubscribe from the mail client. Both
 * verify the HMAC token, so nobody can unsubscribe another address.
 */
export function registerEmailRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  const unsubscribe = async (query: z.infer<typeof unsubscribeQuerySchema>) => {
    if (!verifyUnsubscribeToken(query.email, query.token, env.betterAuthSecret)) return false
    await recordLifecycleUnsubscribe(query.email)
    return true
  }

  const route = describeRoute({
    hide: true,
    tags: ["Email"],
    summary: "Unsubscribe from lifecycle reminder emails",
    description: "Records an opt-out for the signed address. Invitations and sign-in emails are not affected.",
    responses: { 200: { description: "Unsubscribed." }, 400: { description: "Invalid or tampered link." } },
  })

  app.get("/v1/email/unsubscribe", route, publicRoute, queryValidator(unsubscribeQuerySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    if (!(await unsubscribe(c.req.valid("query")))) {
      return c.html(page("This link doesn't work", "The unsubscribe link is incomplete or was changed. Use the link from the most recent email."), 400)
    }
    return c.html(page("You're unsubscribed", "You won't get OpenWork reminder emails anymore. Invitations and sign-in emails still arrive."))
  })
  app.post("/v1/email/unsubscribe", route, publicRoute, queryValidator(unsubscribeQuerySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    if (!(await unsubscribe(c.req.valid("query")))) return c.json({ error: "invalid_unsubscribe_token" }, 400)
    return c.json({ ok: true })
  })
}
