import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { orgPromptSettingsSchema, orgPromptWriteSchema } from "@openwork/types/den/prompts"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import {
  findOrganizationTeamForPrompt,
  listPromptSettings,
  removePromptForScope,
  savePromptForScope,
  type PromptScope,
} from "../../prompts.js"
import { isDuplicateEntry, type ResourceActionContext } from "./declarative.js"
import type { OrgRouteVariables } from "./shared.js"
import { hasPermission, idParamSchema, type PermissionRouteContext } from "./shared.js"

const notFound = jsonResponse("The organization or team was not found.", notFoundSchema)
const teamParamsSchema = idParamSchema("teamId", "team")

type PromptRouteContext = ResourceActionContext & PermissionRouteContext

async function settingsView(c: PromptRouteContext, organizationId: DenTypeId<"organization">) {
  return { ...await listPromptSettings(organizationId), canEdit: await hasPermission(c, "prompts.manage") }
}

async function resolveScope(organizationId: DenTypeId<"organization">, teamId: DenTypeId<"team"> | null): Promise<PromptScope | null> {
  if (!teamId) return { kind: "everyone" }
  const team = await findOrganizationTeamForPrompt(organizationId, teamId)
  return team ? { kind: "team", teamId: team.id, teamName: team.name } : null
}

async function save(c: PromptRouteContext, input: { teamId: DenTypeId<"team"> | null; content: string }) {
  const payload = c.get("organizationContext")
  if (!payload) return c.json({ error: "organization_not_found" }, 404)
  const organizationId = payload.organization.id
  const scope = await resolveScope(organizationId, input.teamId)
  if (!scope) return c.json({ error: "team_not_found" }, 404)
  const write = () => savePromptForScope({ organizationId, scope, content: input.content, updatedByOrgMemberId: payload.currentMember.id })
  try {
    await write()
  } catch (error) {
    // A concurrent first save of the same scope created the prompt; update it.
    if (!isDuplicateEntry(error)) throw error
    await write()
  }
  return c.json(await settingsView(c, organizationId))
}

async function remove(c: PromptRouteContext, teamId: DenTypeId<"team"> | null) {
  const payload = c.get("organizationContext")
  if (!payload) return c.json({ error: "organization_not_found" }, 404)
  const organizationId = payload.organization.id
  const scope = await resolveScope(organizationId, teamId)
  if (!scope) return c.json({ error: "team_not_found" }, 404)
  await removePromptForScope({ organizationId, scope })
  return c.json(await settingsView(c, organizationId))
}

const writeResponses = {
  200: jsonResponse("Prompts saved.", orgPromptSettingsSchema),
  400: jsonResponse("The prompt was empty, too long, or the request was invalid.", invalidRequestSchema),
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse("The caller lacks the Manage prompts permission or needs to sign in again.", forbiddenSchema),
  404: notFound,
}

const removeResponses = {
  200: jsonResponse("Prompt removed; the remaining prompts are returned.", orgPromptSettingsSchema),
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse("The caller lacks the Manage prompts permission or needs to sign in again.", forbiddenSchema),
  404: notFound,
}

/**
 * Prompts: system prompts admins write for everyone and for each team. Members'
 * desktops append the ones that apply to them to OpenWork's instructions
 * (GET /v1/me/prompts).
 */
export function registerOrgPromptRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/prompts",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get prompts",
      description:
        "Returns the organization's system prompts: the prompt for everyone (null for none) and each team's own prompt (null for none), teams by name. Desktops append the prompts that apply to a member to every agent's instructions, Everyone's first, then each team's by team name. Requires the View prompts permission.",
      responses: {
        200: jsonResponse("Prompts returned.", orgPromptSettingsSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the View prompts permission.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("prompts.view"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return c.json(await settingsView(c, c.get("organizationContext").organization.id))
    },
  )

  app.put(
    "/v1/org/prompts/everyone",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set the prompt for everyone",
      description:
        "Sets the system prompt every member's agents follow. The first save creates the prompt and assigns it to everyone. Desktops pick it up at their next provider sync. Requires the Manage prompts permission and a recent sign-in.",
      responses: writeResponses,
    }),
    orgMemberRoute(),
    requireOrgPermission("prompts.manage"),
    jsonValidator(orgPromptWriteSchema),
    async (c) => save(c, { teamId: null, content: c.req.valid("json").content }),
  )

  app.delete(
    "/v1/org/prompts/everyone",
    describeRoute({
      tags: ["Organizations"],
      summary: "Remove the prompt for everyone",
      description:
        "Removes the system prompt for everyone; teams' prompts are kept. Requires the Manage prompts permission and a recent sign-in.",
      responses: removeResponses,
    }),
    orgMemberRoute(),
    requireOrgPermission("prompts.manage"),
    async (c) => remove(c, null),
  )

  app.put(
    "/v1/org/prompts/teams/:teamId",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set a team's prompt",
      description:
        "Sets the system prompt one team's members' agents follow, after the prompt for everyone. The first save creates the prompt and assigns it to the team. Requires the Manage prompts permission and a recent sign-in.",
      responses: writeResponses,
    }),
    orgMemberRoute(),
    requireOrgPermission("prompts.manage"),
    paramValidator(teamParamsSchema),
    jsonValidator(orgPromptWriteSchema),
    async (c) => save(c, { teamId: normalizeDenTypeId("team", c.req.valid("param").teamId), content: c.req.valid("json").content }),
  )

  app.delete(
    "/v1/org/prompts/teams/:teamId",
    describeRoute({
      tags: ["Organizations"],
      summary: "Remove a team's prompt",
      description:
        "Removes one team's system prompt; the prompt for everyone still applies. Requires the Manage prompts permission and a recent sign-in.",
      responses: removeResponses,
    }),
    orgMemberRoute(),
    requireOrgPermission("prompts.manage"),
    paramValidator(teamParamsSchema),
    async (c) => remove(c, normalizeDenTypeId("team", c.req.valid("param").teamId)),
  )
}
