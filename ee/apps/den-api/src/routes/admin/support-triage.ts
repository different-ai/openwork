import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono, MiddlewareHandler } from "hono"
import { z } from "zod"
import { normalizeHarnessFeedbackWebhook } from "../../harness-feedback/slack.js"
import { adminRoute } from "../../middleware/index.js"
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
const noStore: MiddlewareHandler = async (c, next) => { c.header("cache-control", "no-store"); await next() }

export function registerAdminSupportTriageRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>,
  { plainFetch, slackFetch }: { plainFetch?: typeof fetch; slackFetch?: typeof fetch } = {}) {
  app.get(`${root}/settings`, noStore, adminRoute(), async (c) => c.json(publicTriageSettings(await readTriageSettings())))

  app.put(`${root}/settings`, noStore, adminRoute(), async (c) => {
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

  app.post(`${root}/plain/test`, noStore, adminRoute(), async (c) => {
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

  app.post(`${root}/slack/test`, noStore, adminRoute(), async (c) => {
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

  app.get(`${root}/threads`, noStore, adminRoute(), async (c) => {
    const parsed = listQuery.safeParse(c.req.query())
    if (!parsed.success) return c.json({ error: "invalid_filter", message: "Choose a valid category and page size." }, 400)
    return c.json(await listTriageThreads(parsed.data))
  })
}
