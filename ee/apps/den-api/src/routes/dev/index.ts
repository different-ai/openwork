import type { EmailTemplate } from "@openwork/email"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { publicRoute } from "../../middleware/index.js"
import { htmlResponse, jsonResponse } from "../../openapi.js"
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

const devErrorSchema = z.object({ error: z.enum(["not_found", "invalid_template", "email_not_found"]) })
const devEmailListSchema = z.object({ emails: z.array(z.object({}).passthrough()) })
const devEmailsDescription = "Development-only email outbox used by evals. Answers 404 unless the server runs with OPENWORK_DEV_MODE=1, so production deployments never expose email HTML. Optional `template` query parameter filters by email template."

export function registerDevRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  // Dev/eval-only email outbox. These endpoints intentionally 404 unless
  // OPENWORK_DEV_MODE=1 so production deployments do not expose email HTML.
  app.get(
    "/v1/dev/emails",
    describeRoute({
      tags: ["Internal"],
      security: [],
      summary: "List captured development emails",
      description: devEmailsDescription,
      responses: {
        200: jsonResponse("Captured emails.", devEmailListSchema),
        400: jsonResponse("Unknown email template.", devErrorSchema),
        404: jsonResponse("The server is not running in development mode.", devErrorSchema),
      },
    }),
    publicRoute,
    (c) => {
    if (!env.devMode) {
      return c.json({ error: "not_found" }, 404)
    }

    const template = normalizeEmailTemplate(c.req.query("template") ?? null)
    if (template === null) {
      return c.json({ error: "invalid_template" }, 400)
    }

    return c.json({ emails: listDevEmails(template) })
    },
  )

  app.get(
    "/v1/dev/emails/last",
    describeRoute({
      tags: ["Internal"],
      security: [],
      summary: "Preview the last captured development email",
      description: devEmailsDescription,
      responses: {
        200: htmlResponse("Rendered HTML of the most recent captured email."),
        400: jsonResponse("Unknown email template.", devErrorSchema),
        404: jsonResponse("The server is not running in development mode, or no email has been captured.", devErrorSchema),
      },
    }),
    publicRoute,
    (c) => {
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
    },
  )
}
