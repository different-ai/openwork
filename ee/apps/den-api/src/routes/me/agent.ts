import { isValidTimeZone } from "@openwork/automations/proactive"
import {
  AGENT_RESPONSIBILITIES,
  AGENT_RESPONSIBILITY_COPY,
  memberAgentInputSchema,
  memberAgentViewSchema,
  type MemberAgentView,
  type WorkbotProactiveSettings,
} from "@openwork/types/den/workbot-proactive"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"
import { readProactiveSettings } from "../../workbot-proactive/access.js"
import { destinationBlock } from "../../workbot-proactive/deliver.js"
import { memberAgentOn, memberChoiceChange, mutedOf, type MemberChoices } from "../../workbot-proactive/policy.js"
import { readAgentInstance, saveMemberChoices } from "../../workbot-proactive/repository.js"
import { readAgentTemplate } from "../../workbot-proactive/template.js"
import { workbotOrigin } from "../../workbot/config.js"

/**
 * A member's own agent, as settings: what it will tell them about, and their controls in plain words ("stop telling
 * me about calendar changes", "snooze until tomorrow", "turn it off"). Exposed through Connect, so the member can
 * say it to Workbot; a background agent's read-scoped token can read it but never change it.
 */

const memberAgentDocumentSchema = memberAgentViewSchema.meta({ ref: "MemberAgent" })
const memberAgentInputDocumentSchema = memberAgentInputSchema.meta({ ref: "MemberAgentInput" })
const featureDisabledSchema = z.object({ error: z.literal("feature_disabled"), feature: z.string() }).meta({ ref: "MemberAgentDisabled" })

async function memberAgentView(input: {
  organizationId: DenTypeId<"organization">
  userId: DenTypeId<"user">
  settings: WorkbotProactiveSettings
  row: (MemberChoices & { nextWakeAt: Date | null }) | null
}): Promise<MemberAgentView> {
  const { settings, row } = input
  const template = await readAgentTemplate(input.organizationId)
  const muted = mutedOf(row)
  const on = memberAgentOn(row, settings)
  const destination: MemberAgentView["destination"] = settings.destination === "workbot_dm"
    ? { kind: "workbot_dm", name: "Workbot DM", blocked: await destinationBlock({ organizationId: input.organizationId, userId: input.userId }) }
    : null
  return {
    available: settings.enabled,
    on,
    snoozedUntil: row?.snoozedUntil && row.snoozedUntil.getTime() > Date.now() ? row.snoozedUntil.toISOString() : null,
    responsibilities: AGENT_RESPONSIBILITIES.map((id) => ({ id, ...AGENT_RESPONSIBILITY_COPY[id], enabled: template.responsibilities[id], muted: muted.has(id) })),
    destination,
    workingHours: { workingDays: settings.workingDays, startHour: settings.startHour, endHour: settings.endHour, dailyCap: settings.dailyCap },
    nextCheckAt: settings.enabled && on && row?.nextWakeAt ? row.nextWakeAt.toISOString() : null,
  }
}

export function registerMeAgentRoutes<T extends { Variables: AuthContextVariables & Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  app.get(
    "/v1/me/agent",
    describeRoute({
      tags: ["Users"],
      summary: "Get my agent",
      description:
        "The signed-in member's own agent in the active organization: whether it is on for them, what it will tell them about (each responsibility, whether the organization turned it on and whether they muted it), where its messages go (a DM from the Workbot Slack app) and whether they can arrive yet (the Slack app installed, their Slack account linked), the working hours and daily limit it follows, and when it looks next. Requires the workbotProactive feature and Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent.", memberAgentDocumentSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization.", featureDisabledSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context || workbotOrigin() === null) return c.json({ error: "feature_disabled" as const, feature: "workbot" }, 404)
      c.header("Cache-Control", "no-store")
      const organizationId = context.organization.id
      const userId = context.currentMember.userId
      if (!userId) return c.json({ error: "feature_disabled" as const, feature: "workbotProactive" }, 404)
      return c.json(await memberAgentView({ organizationId, userId, settings: await readProactiveSettings(organizationId), row: await readAgentInstance(context.currentMember.id) }))
    },
  )

  app.put(
    "/v1/me/agent",
    describeRoute({
      tags: ["Users"],
      summary: "Change my agent",
      description:
        "Changes the signed-in member's own agent, as they would say it: turn it on or off (`on`), snooze it until the next working morning or resume (`snooze: \"tomorrow\"` or null), stop or restart one kind of message (`mute` / `unmute`: morning_brief, meeting_prep, calendar_changes, waiting_on_you). Organization settings and limits still apply. Requires the workbotProactive feature and Workbot on this deployment.",
      responses: {
        200: jsonResponse("The member's agent after the change.", memberAgentDocumentSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Agents are off for this organization.", featureDisabledSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbotProactive"),
    jsonValidator(memberAgentInputDocumentSchema),
    async (c) => {
      const context = c.get("organizationContext")
      if (!context || workbotOrigin() === null) return c.json({ error: "feature_disabled" as const, feature: "workbot" }, 404)
      c.header("Cache-Control", "no-store")
      const organizationId = context.organization.id
      const memberId = context.currentMember.id
      const input = c.req.valid("json")
      const userId = context.currentMember.userId
      if (!userId) return c.json({ error: "feature_disabled" as const, feature: "workbotProactive" }, 404)
      const settings = await readProactiveSettings(organizationId)
      const row = await readAgentInstance(memberId)
      const timeZone = row && isValidTimeZone(row.timeZone) ? row.timeZone : "UTC"
      await saveMemberChoices(organizationId, memberId, memberChoiceChange(input, row, settings, Date.now(), timeZone))
      return c.json(await memberAgentView({ organizationId, userId, settings, row: await readAgentInstance(memberId) }))
    },
  )
}
