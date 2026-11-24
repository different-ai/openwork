import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono, MiddlewareHandler } from "hono"
import { z } from "zod"
import { env } from "../../env.js"
import { harnessFeedbackOrganizationIds, isHarnessFeedbackOrganization, listHarnessFeedbackOrganizations, setHarnessFeedbackOrganization } from "../../harness-feedback/access.js"
import { listHarnessFeedback, readHarnessFeedbackGroup, readUngroupedHarnessFeedbackReport, retryHarnessFeedbackGroup } from "../../harness-feedback/repository.js"
import { clearHarnessFeedbackWebhook, hasHarnessFeedbackWebhook, readHarnessFeedbackWebhook, setHarnessFeedbackWebhook } from "../../harness-feedback/settings.js"
import { normalizeHarnessFeedbackWebhook, sendHarnessFeedbackSlackTest } from "../../harness-feedback/slack.js"
import { adminRoute } from "../../middleware/index.js"
import type { AuthContextVariables } from "../../session.js"

export function registerAdminHarnessFeedbackRoutes<T extends { Variables: AuthContextVariables }>(app: Hono<T>) {
  const path = "/v1/admin/harness-feedback"
  const headers = { "cache-control": "no-store" }

  const noStore: MiddlewareHandler = async (c, next) => {
    c.header("cache-control", "no-store")
    await next()
  }

  const settings = `${path}/settings`
  const organizationSettings = `${settings}/organizations/:organizationId`
  const slackSettings = `${settings}/slack`
  const webhookBody = z.strictObject({ webhookUrl: z.string().max(2048) })

  app.get(settings, noStore, adminRoute(), async (c) => {
    const [organizations, webhookConfigured] = await Promise.all([listHarnessFeedbackOrganizations(), hasHarnessFeedbackWebhook()])
    return c.json({ organizations, webhookConfigured, jevConfigured: Boolean(env.agentEvaluationApiKey) }, 200, headers)
  })

  app.on(["PUT", "DELETE"], organizationSettings, noStore, adminRoute(), async (c) => {
    const { organizationId } = c.req.param()
    if (!isDenTypeId("organization", organizationId) || !(await setHarnessFeedbackOrganization(
      organizationId, c.req.method === "PUT", normalizeDenTypeId("user", c.get("user")?.id ?? ""),
    ))) return c.json({ error: "not_found", message: "Organization not found." }, 404, headers)
    return c.json({ ok: true }, 200, headers)
  })

  app.put(slackSettings, noStore, adminRoute(), async (c) => {
    const body: unknown = await c.req.json().catch(() => null)
    const parsed = webhookBody.safeParse(body)
    const url = parsed.success && normalizeHarnessFeedbackWebhook(parsed.data.webhookUrl)
    if (!url) return c.json({ error: "invalid_webhook", message: "Enter an HTTPS webhook URL from hooks.slack.com." }, 400, headers)
    try {
      await setHarnessFeedbackWebhook(url, normalizeDenTypeId("user", c.get("user")?.id ?? ""))
      return c.json({ ok: true }, 200, headers)
    } catch {
      return c.json({ error: "webhook_unavailable", message: "Couldn’t save the Slack webhook. Try again." }, 503, headers)
    }
  })

  app.delete(slackSettings, noStore, adminRoute(), async (c) => {
    await clearHarnessFeedbackWebhook()
    return c.json({ ok: true }, 200, headers)
  })

  app.post(`${slackSettings}/test`, noStore, adminRoute(), async (c) => {
    const failed = () => c.json({ error: "webhook_test_failed", message: "Couldn’t send the test message. Check the Slack webhook and try again." }, 502, headers)
    try {
      const url = await readHarnessFeedbackWebhook()
      if (!url) return c.json({ error: "webhook_not_configured", message: "Save a Slack webhook before sending a test message." }, 409, headers)
      if (await sendHarnessFeedbackSlackTest(url) === "delivered") return c.json({ ok: true }, 200, headers)
    } catch {
      return failed()
    }
    return failed()
  })

  app.get(path, noStore, adminRoute(), async (c) => {
    const selected = c.req.query("group")
    return c.json(await listHarnessFeedback(await harnessFeedbackOrganizationIds(),
      selected && isDenTypeId("harnessFeedbackGroup", selected) ? selected : undefined), 200, headers)
  })

  app.get(`${path}/reports/:organizationId/:reportId`, noStore, adminRoute(), async (c) => {
    const { organizationId, reportId } = c.req.param()
    const notFound = () => c.json({ error: "not_found", message: "Ungrouped feedback report not found." }, 404, headers)
    if (!isDenTypeId("organization", organizationId) || !(await isHarnessFeedbackOrganization(organizationId, { fresh: true })) || !isDenTypeId("harnessFeedbackReport", reportId)) return notFound()
    const detail = await readUngroupedHarnessFeedbackReport(organizationId, reportId)
    return detail ? c.json(detail, 200, headers) : notFound()
  })

  app.get(`${path}/:organizationId/:groupId`, noStore, adminRoute(), async (c) => {
    const { organizationId, groupId } = c.req.param()
    const notFound = () => c.json({ error: "not_found", message: "Feedback group not found." }, 404, headers)
    if (!isDenTypeId("organization", organizationId) || !(await isHarnessFeedbackOrganization(organizationId, { fresh: true })) || !isDenTypeId("harnessFeedbackGroup", groupId)) return notFound()
    const detail = await readHarnessFeedbackGroup(organizationId, groupId)
    return detail ? c.json(detail, 200, headers) : notFound()
  })

  app.post(`${path}/:organizationId/:groupId/retry`, noStore, adminRoute(), async (c) => {
    const { organizationId, groupId } = c.req.param()
    const unavailable = () => c.json({ error: "not_found", message: "This group is no longer available to retry. Refresh the list." }, 404, headers)
    if (!isDenTypeId("organization", organizationId) || !(await isHarnessFeedbackOrganization(organizationId, { fresh: true })) || !isDenTypeId("harnessFeedbackGroup", groupId)) return unavailable()
    return await retryHarnessFeedbackGroup(organizationId, groupId) ? c.json({ queued: true }, 200, headers) : unavailable()
  })
}
