import type { EmailTemplate } from "@openwork/email"
import type { Hono } from "hono"
import { env } from "../../env.js"
import { publicRoute } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"
import { getLastDevEmail, listDevEmails } from "../../utils/email/send-email.js"

function normalizeEmailTemplate(value: string | null): EmailTemplate | null | undefined {
  if (!value) {
    return undefined
  }

  switch (value) {
    case "verification":
    case "passwordReset":
    case "organizationInvite":
    case "downloadLink":
    case "feedback":
      return value
    default:
      return null
  }
}

export function registerDevRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  // Dev/eval-only email outbox. These endpoints intentionally 404 unless
  // OPENWORK_DEV_MODE=1 so production deployments do not expose email HTML.
  app.get("/v1/dev/emails", publicRoute, (c) => {
    if (!env.devMode) {
      return c.json({ error: "not_found" }, 404)
    }

    const template = normalizeEmailTemplate(c.req.query("template") ?? null)
    if (template === null) {
      return c.json({ error: "invalid_template" }, 400)
    }

    return c.json({ emails: listDevEmails(template) })
  })

  app.get("/v1/dev/emails/last", publicRoute, (c) => {
    if (!env.devMode) {
      return c.json({ error: "not_found" }, 404)
    }

    const template = normalizeEmailTemplate(c.req.query("template") ?? null)
    if (template === null) {
      return c.json({ error: "invalid_template" }, 400)
    }

    const email = getLastDevEmail(template)
    if (!email) {
      return c.json({ error: "email_not_found" }, 404)
    }

    return c.html(email.html)
  })
}
