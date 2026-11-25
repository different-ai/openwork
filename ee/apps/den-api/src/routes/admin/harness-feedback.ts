import { HARNESS_FEEDBACK_NOTIFY_STATES, HARNESS_FEEDBACK_STATES, HARNESS_FEEDBACK_SURFACES } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { env } from "../../env.js"
import { harnessFeedbackOrganizationIds, isHarnessFeedbackOrganization, listHarnessFeedbackOrganizations, setHarnessFeedbackOrganization } from "../../harness-feedback/access.js"
import { listHarnessFeedback, readHarnessFeedbackGroup, readUngroupedHarnessFeedbackReport, requeueHarnessFeedbackReports, retryHarnessFeedbackGroup } from "../../harness-feedback/repository.js"
import { clearHarnessFeedbackWebhook, hasHarnessFeedbackWebhook, readHarnessFeedbackWebhook, setHarnessFeedbackWebhook } from "../../harness-feedback/settings.js"
import { normalizeHarnessFeedbackWebhook, sendHarnessFeedbackSlackTest } from "../../harness-feedback/slack.js"
import { adminRoute } from "../../middleware/index.js"
import { forbiddenSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

const tags = ["Admin"]
const routeErrors = {
  401: jsonResponse("The caller must be authenticated.", unauthorizedSchema),
  403: jsonResponse("The authenticated user is not an admin.", forbiddenSchema),
}
const errorSchema = (...codes: [string, ...string[]]) => z.object({ error: z.enum(codes), message: z.string() })
const okSchema = z.object({ ok: z.literal(true) })
const reportSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  state: z.enum(HARNESS_FEEDBACK_STATES),
  surface: z.enum(HARNESS_FEEDBACK_SURFACES),
  tool: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string().datetime(),
})
const reportDetailsSchema = z.object({
  reports: z.array(reportSchema.extend({ symptom: z.string(), workaround: z.string().nullable() })),
})
const settingsSchema = z.object({
  organizations: z.array(z.object({ id: z.string(), name: z.string() })),
  webhookConfigured: z.boolean(),
  jevConfigured: z.boolean(),
})
const feedbackSchema = z.object({
  summary: z.object({ groups: z.number().int(), reports: z.number().int(), ungrouped: z.number().int(), pending: z.number().int() }),
  groups: z.array(z.object({
    id: z.string(),
    organizationId: z.string(),
    title: z.string(),
    category: z.string().nullable(),
    categoryLabel: z.string().nullable(),
    surface: z.enum(HARNESS_FEEDBACK_SURFACES),
    tool: z.string().nullable(),
    reportCount: z.number().int(),
    firstSeenAt: z.string().datetime(),
    lastSeenAt: z.string().datetime(),
    notifyState: z.enum(HARNESS_FEEDBACK_NOTIFY_STATES),
  })),
  ungroupedReports: z.array(reportSchema),
})

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

  app.get(settings, describeRoute({
    tags,
    summary: "Get harness feedback settings",
    description: "Returns the organizations whose agents may send harness feedback, whether a Slack webhook is saved for new feedback groups, and whether the evaluation service that classifies reports is configured.",
    responses: { 200: jsonResponse("Harness feedback settings returned.", settingsSchema), ...routeErrors },
  }), noStore, adminRoute(), async (c) => {
    const [organizations, webhookConfigured] = await Promise.all([listHarnessFeedbackOrganizations(), hasHarnessFeedbackWebhook()])
    return c.json({ organizations, webhookConfigured, jevConfigured: Boolean(env.agentEvaluationApiKey) }, 200, headers)
  })

  const organizationSwitches = [
    {
      method: "PUT",
      enabled: true,
      summary: "Turn on harness feedback for an organization",
      description: "Lets agents in the organization send harness feedback. Turning it on again for an organization that already has it changes nothing.",
      done: "Harness feedback is on for the organization.",
    },
    {
      method: "DELETE",
      enabled: false,
      summary: "Turn off harness feedback for an organization",
      description: "Stops accepting harness feedback from agents in the organization and hides its groups and reports from the admin list. Stored reports are kept.",
      done: "Harness feedback is off for the organization.",
    },
  ]
  for (const { method, enabled, summary, description, done } of organizationSwitches) {
    app.on(method, organizationSettings, describeRoute({
      tags,
      summary,
      description,
      responses: {
        200: jsonResponse(done, okSchema),
        ...routeErrors,
        404: jsonResponse("The organization does not exist.", errorSchema("not_found")),
      },
    }), noStore, adminRoute(), async (c) => {
      const { organizationId } = c.req.param()
      if (!isDenTypeId("organization", organizationId) || !(await setHarnessFeedbackOrganization(
        organizationId, enabled, normalizeDenTypeId("user", c.get("user")?.id ?? ""),
      ))) return c.json({ error: "not_found", message: "Organization not found." }, 404, headers)
      return c.json({ ok: true }, 200, headers)
    })
  }

  app.put(slackSettings, describeRoute({
    tags,
    summary: "Save the harness feedback Slack webhook",
    description: "Saves the Slack incoming webhook that receives a message for each new harness feedback group, replacing any saved one. Body: { webhookUrl: string }, an HTTPS URL on hooks.slack.com. The URL is stored encrypted and never returned.",
    responses: {
      200: jsonResponse("The webhook was saved.", okSchema),
      400: jsonResponse("The body was not a Slack webhook URL.", errorSchema("invalid_webhook")),
      ...routeErrors,
      503: jsonResponse("The webhook could not be saved.", errorSchema("webhook_unavailable")),
    },
  }), noStore, adminRoute(), async (c) => {
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

  app.delete(slackSettings, describeRoute({
    tags,
    summary: "Remove the harness feedback Slack webhook",
    description: "Deletes the saved Slack webhook, so new harness feedback groups stop being posted to Slack. Succeeds when no webhook is saved.",
    responses: { 200: jsonResponse("No webhook is saved.", okSchema), ...routeErrors },
  }), noStore, adminRoute(), async (c) => {
    await clearHarnessFeedbackWebhook()
    return c.json({ ok: true }, 200, headers)
  })

  app.post(`${slackSettings}/test`, describeRoute({
    tags,
    summary: "Send a harness feedback test message to Slack",
    description: "Posts a test message to the saved Slack webhook so an admin can confirm it reaches the right channel.",
    responses: {
      200: jsonResponse("Slack accepted the test message.", okSchema),
      ...routeErrors,
      409: jsonResponse("No Slack webhook is saved.", errorSchema("webhook_not_configured")),
      502: jsonResponse("Slack did not accept the test message.", errorSchema("webhook_test_failed")),
    },
  }), noStore, adminRoute(), async (c) => {
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

  app.get(path, describeRoute({
    tags,
    summary: "List harness feedback",
    description: "Returns totals, the most recently seen feedback groups and the reports not yet in a group, across the organizations that have harness feedback on. Reports that need review come first. Symptom and workaround text is left out; read a group or an ungrouped report for it.",
    parameters: [{
      name: "group",
      in: "query",
      required: false,
      description: "A feedback group id to list first. Ignored when it is not a group id.",
      schema: { type: "string" },
    }],
    responses: { 200: jsonResponse("Harness feedback returned.", feedbackSchema), ...routeErrors },
  }), noStore, adminRoute(), async (c) => {
    const selected = c.req.query("group")
    return c.json(await listHarnessFeedback(await harnessFeedbackOrganizationIds(),
      selected && isDenTypeId("harnessFeedbackGroup", selected) ? selected : undefined), 200, headers)
  })

  app.get(`${path}/reports/:organizationId/:reportId`, describeRoute({
    tags,
    summary: "Get an ungrouped harness feedback report",
    description: "Returns one report that is not in a group, with the symptom and workaround the agent wrote. The organization must have harness feedback on.",
    responses: {
      200: jsonResponse("The report returned.", reportDetailsSchema),
      ...routeErrors,
      404: jsonResponse("No ungrouped report with that id is available.", errorSchema("not_found")),
    },
  }), noStore, adminRoute(), async (c) => {
    const { organizationId, reportId } = c.req.param()
    const notFound = () => c.json({ error: "not_found", message: "Ungrouped feedback report not found." }, 404, headers)
    if (!isDenTypeId("organization", organizationId) || !(await isHarnessFeedbackOrganization(organizationId, { fresh: true })) || !isDenTypeId("harnessFeedbackReport", reportId)) return notFound()
    const detail = await readUngroupedHarnessFeedbackReport(organizationId, reportId)
    return detail ? c.json(detail, 200, headers) : notFound()
  })

  app.get(`${path}/:organizationId/:groupId`, describeRoute({
    tags,
    summary: "Get the reports in a harness feedback group",
    description: "Returns the most recent reports in one feedback group, newest first, with the symptom and workaround each agent wrote. The organization must have harness feedback on.",
    responses: {
      200: jsonResponse("The group's reports returned.", reportDetailsSchema),
      ...routeErrors,
      404: jsonResponse("No group with that id is available.", errorSchema("not_found")),
    },
  }), noStore, adminRoute(), async (c) => {
    const { organizationId, groupId } = c.req.param()
    const notFound = () => c.json({ error: "not_found", message: "Feedback group not found." }, 404, headers)
    if (!isDenTypeId("organization", organizationId) || !(await isHarnessFeedbackOrganization(organizationId, { fresh: true })) || !isDenTypeId("harnessFeedbackGroup", groupId)) return notFound()
    const detail = await readHarnessFeedbackGroup(organizationId, groupId)
    return detail ? c.json(detail, 200, headers) : notFound()
  })

  app.post(`${path}/reclassify`, describeRoute({
    tags,
    summary: "Classify harness feedback reports again",
    description: "Sends reports that need review back through classification for organizations that have harness feedback on.",
    responses: {
      200: jsonResponse("Returns how many reports were queued again.", z.object({ requeued: z.number().int().nonnegative() })),
      ...routeErrors,
    },
  }), noStore, adminRoute(), async (c) => {
    return c.json({ requeued: await requeueHarnessFeedbackReports() }, 200, headers)
  })

  app.post(`${path}/:organizationId/:groupId/retry`, describeRoute({
    tags,
    summary: "Retry the Slack message for a harness feedback group",
    description: "Queues the Slack message again for a feedback group whose message failed to send. The organization must have harness feedback on.",
    responses: {
      200: jsonResponse("The Slack message was queued again.", z.object({ queued: z.literal(true) })),
      ...routeErrors,
      404: jsonResponse("The group cannot be retried.", errorSchema("not_found")),
    },
  }), noStore, adminRoute(), async (c) => {
    const { organizationId, groupId } = c.req.param()
    const unavailable = () => c.json({ error: "not_found", message: "This group is no longer available to retry. Refresh the list." }, 404, headers)
    if (!isDenTypeId("organization", organizationId) || !(await isHarnessFeedbackOrganization(organizationId, { fresh: true })) || !isDenTypeId("harnessFeedbackGroup", groupId)) return unavailable()
    return await retryHarnessFeedbackGroup(organizationId, groupId) ? c.json({ queued: true }, 200, headers) : unavailable()
  })
}
