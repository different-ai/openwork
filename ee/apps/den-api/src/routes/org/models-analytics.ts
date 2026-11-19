import { and, eq, inArray } from "@openwork-ee/den-db/drizzle"
import { ModelsAnalyticsEventTable as Event } from "@openwork-ee/den-db/schema"
import { appendModelsAnalyticsEvents, readModelsAnalyticsSettings, modelsTaskBatchSchema } from "@openwork-ee/telemetry"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { db } from "../../db.js"
import { jsonValidator, orgMemberRoute } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { z } from "zod"
import type { OrgRouteVariables } from "./shared.js"

export function registerModelsAnalyticsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  // Runtime collection outlives the retired Models and Task analytics screens:
  // removing them must not revoke stored consent or interrupt existing exports.
  app.post("/v1/inference/analytics/events", describeRoute({
    tags: ["Inference"], summary: "Report task analytics events for the calling member's OpenWork Models calls",
    description: "Accepts runtime metadata for tasks the member actually ran through OpenWork Models; events for other members' tasks or BYOK calls are dropped. Answers 204 when the organization has not opted into task analytics.",
    responses: {
      202: jsonResponse("Accepted event ids.", z.object({ acceptedIds: z.array(z.string()) })),
      204: { description: "Task analytics are not enabled for this organization; nothing was recorded." },
      400: jsonResponse("Invalid request.", invalidRequestSchema),
      401: jsonResponse("Sign-in required.", unauthorizedSchema),
    },
  }), orgMemberRoute(), jsonValidator(modelsTaskBatchSchema), async (c) => {
    const context = c.get("organizationContext")
    const orgId = context.organization.id
    const memberId = context.currentMember.id
    const settings = await readModelsAnalyticsSettings(db, orgId)
    if (!settings.enabled) return c.body(null, 204)
    const { events } = c.req.valid("json")
    // Runtime metadata is accepted only for this member's actual Models calls.
    // A client cannot attach events to another member's task or a BYOK call.
    const calls = await db.select({ sessionId: Event.session_id, taskId: Event.task_id }).from(Event).where(and(
      eq(Event.org_id, orgId), eq(Event.member_id, memberId), eq(Event.source, "inference"),
      inArray(Event.task_id, events.map((event) => event.taskId)),
    ))
    const matched = events.filter((event) => calls.some((call) => call.taskId === event.taskId && call.sessionId === event.sessionId))
    await appendModelsAnalyticsEvents(db, { orgId, memberId, source: "app", events: matched })
    return c.json({ acceptedIds: matched.map((event) => event.id) }, 202)
  })
}
