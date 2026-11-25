import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { SUPPORT_TRIAGE_CATEGORIES } from "@openwork-ee/den-db/schema"
import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { normalizeHarnessFeedbackWebhook } from "../../harness-feedback/slack.js"
import { adminRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { supportTriageCategory } from "../../support-triage/classifier.js"
import { createPlainClient } from "../../support-triage/plain.js"
import { listTriageThreads } from "../../support-triage/repository.js"
import { publicTriageSettings, readTriageSettings, updateTriageSettings } from "../../support-triage/settings.js"
import { sendSupportTriageSlackTest } from "../../support-triage/slack.js"

const root = "/v1/admin/support-triage"
const key = z.string().max(2048).trim().regex(/^[\x21-\x7e]+$/u)
const webhook = z.string().max(2048).transform(normalizeHarnessFeedbackWebhook).pipe(z.string())
const settingsBody = z.strictObject({ enabled: z.boolean().optional(), plainApiKey: key.nullable().optional(), slackWebhookUrl: webhook.nullable().optional() })
  .refine((value) => Object.keys(value).length > 0)
const plainTestBody = z.strictObject({ plainApiKey: key.optional() })
const slackTestBody = z.strictObject({ slackWebhookUrl: webhook.optional() })
const listQuery = z.strictObject({
  category: supportTriageCategory.optional(), limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
})
const invalid = { error: "invalid_settings", message: "Check the Plain API key and the HTTPS webhook URL from hooks.slack.com." }
const tags = ["Admin"]
const routeErrors = {
  401: jsonResponse("The caller must be authenticated.", unauthorizedSchema),
  403: jsonResponse("The authenticated user is not an admin.", forbiddenSchema),
}
const errorSchema = (...codes: [string, ...string[]]) => z.object({ error: z.enum(codes), message: z.string() })
const settingsSchema = z.object({
  enabledAt: z.string().datetime().nullable(), plainConfigured: z.boolean(), slackConfigured: z.boolean(), jevConfigured: z.boolean(),
  updatedAt: z.string().datetime().nullable(), updatedBy: z.string().nullable(),
})
const threadsSchema = z.object({
  threads: z.array(z.object({
    id: z.string(), plainThreadId: z.string(), workspaceId: z.string(), title: z.string(), preview: z.string().nullable(),
    category: z.enum(SUPPORT_TRIAGE_CATEGORIES).nullable(), status: z.enum(["pending", "processing", "completed", "failed"]),
    createdAt: z.string().datetime(), attempts: z.number().int(),
  })),
  total: z.number().int(),
})
const invalidResponse = jsonResponse("The request body is not valid.", errorSchema("invalid_settings"))
const noStore: MiddlewareHandler = async (c, next) => { c.header("cache-control", "no-store"); await next() }

export function registerAdminSupportTriageRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>,
  { plainFetch, slackFetch }: { plainFetch?: typeof fetch; slackFetch?: typeof fetch } = {}) {
  app.get(`${root}/settings`, describeRoute({
    tags,
    summary: "Get support triage settings",
    description: "Returns when support triage was turned on and whether the Plain key, the Slack webhook and the evaluation service are configured. Saved credentials are never returned.",
    responses: { 200: jsonResponse("Support triage settings returned.", settingsSchema), ...routeErrors },
  }), noStore, adminRoute(), async (c) => c.json(publicTriageSettings(await readTriageSettings())))

  app.put(`${root}/settings`, describeRoute({
    tags,
    summary: "Update support triage settings",
    description: "Saves the Plain API key or the Slack webhook, or turns support triage on or off. Turning it on starts triage only for threads created after that moment. Clearing the Plain key turns triage off.",
    responses: {
      200: jsonResponse("Support triage settings saved.", settingsSchema),
      400: invalidResponse,
      409: jsonResponse("Plain or the evaluation service is not configured, so triage can't be turned on.", errorSchema("not_configured")),
      503: jsonResponse("The settings could not be saved.", errorSchema("settings_unavailable")),
      ...routeErrors,
    },
  }), noStore, adminRoute(), async (c) => {
    const parsed = settingsBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(invalid, 400)
    try {
      const result = await updateTriageSettings(parsed.data, normalizeDenTypeId("user", c.get("user")?.id ?? ""))
      if (result.kind === "not_configured") return c.json({ error: "not_configured", message: "Connect Plain and configure Jev before turning on support triage." }, 409)
      return c.json(publicTriageSettings(result.settings))
    } catch {
      return c.json({ error: "settings_unavailable", message: "Couldn’t save support triage settings. Try again." }, 503)
    }
  })

  app.post(`${root}/plain/test`, describeRoute({
    tags,
    summary: "Test the Plain connection",
    description: "Checks that the given Plain API key, or the saved one, reaches a Plain workspace. It doesn't check write permissions.",
    responses: {
      200: jsonResponse("The key reached its Plain workspace.", z.object({ workspaceId: z.string() })),
      400: invalidResponse,
      409: jsonResponse("No Plain API key was given or saved.", errorSchema("plain_not_configured")),
      502: jsonResponse("Plain could not be reached with this key.", errorSchema("plain_test_failed")),
      ...routeErrors,
    },
  }), noStore, adminRoute(), async (c) => {
    const parsed = plainTestBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(invalid, 400)
    try {
      const apiKey = parsed.data.plainApiKey ?? (await readTriageSettings())?.plainApiKey
      if (!apiKey) return c.json({ error: "plain_not_configured", message: "Enter a Plain API key to test the connection." }, 409)
      return c.json({ workspaceId: await createPlainClient({ apiKey, fetch: plainFetch }).workspaceId() })
    } catch {
      return c.json({ error: "plain_test_failed", message: "Couldn’t verify the connection to Plain. Check the API key and try again." }, 502)
    }
  })

  app.post(`${root}/slack/test`, describeRoute({
    tags,
    summary: "Send a support triage Slack test message",
    description: "Posts a test message to the given Slack webhook, or the saved one, so an admin can check where triage alerts will appear.",
    responses: {
      200: jsonResponse("The test message was delivered.", z.object({ ok: z.literal(true) })),
      400: invalidResponse,
      409: jsonResponse("No Slack webhook was given or saved.", errorSchema("slack_not_configured")),
      502: jsonResponse("Slack did not accept the test message.", errorSchema("slack_test_failed")),
      ...routeErrors,
    },
  }), noStore, adminRoute(), async (c) => {
    const parsed = slackTestBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(invalid, 400)
    try {
      const webhookUrl = parsed.data.slackWebhookUrl ?? (await readTriageSettings())?.slackWebhookUrl
      if (!webhookUrl) return c.json({ error: "slack_not_configured", message: "Enter a Slack webhook to send a test message." }, 409)
      if (await sendSupportTriageSlackTest({ webhookUrl, fetch: slackFetch }) === "delivered") return c.json({ ok: true })
    } catch {
      return c.json({ error: "slack_test_failed", message: "Couldn’t send the Slack test message. Check the webhook and try again." }, 502)
    }
    return c.json({ error: "slack_test_failed", message: "Couldn’t send the Slack test message. Check the webhook and try again." }, 502)
  })

  app.get(`${root}/threads`, describeRoute({
    tags,
    summary: "List triaged support threads",
    description: "Lists the Plain threads support triage has seen, newest first, with their category and processing status. Filter by category to find threads that need review.",
    responses: {
      200: jsonResponse("Triaged threads returned.", threadsSchema),
      400: jsonResponse("The category or page size is not valid.", errorSchema("invalid_filter")),
      ...routeErrors,
    },
  }), noStore, adminRoute(), async (c) => {
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: "invalid_filter", message: "Choose a valid category and page size." }, 400)
    return c.json(await listTriageThreads(parsed.data))
  })
}
