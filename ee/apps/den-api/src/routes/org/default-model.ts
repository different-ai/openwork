import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  defaultModelOptionsSchema,
  defaultModelSettingsSchema,
  defaultModelWriteSchema,
  type DefaultModelChoice,
} from "@openwork/types/den/default-model"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import {
  checkDefaultModelChoice,
  findOrganizationTeamForDefaultModel,
  listDefaultModelOptions,
  listDefaultModelSettings,
  saveDefaultModel,
} from "../../default-model.js"
import { jsonValidator, orgMemberRoute, paramValidator, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { isDuplicateEntry, type ResourceActionContext } from "./declarative.js"
import type { OrgRouteVariables } from "./shared.js"
import { hasPermission, idParamSchema, type PermissionRouteContext } from "./shared.js"

const unknownModelSchema = z
  .object({ error: z.literal("unknown_model"), message: z.string() })
  .meta({ ref: "DefaultModelUnknownModelError" })
const sourceUnavailableSchema = z
  .object({ error: z.literal("model_source_unavailable"), message: z.string() })
  .meta({ ref: "DefaultModelSourceUnavailableError" })

export const UNKNOWN_DEFAULT_MODEL_MESSAGE = "That model isn't one your organization has. Choose one from the list."
export const DEFAULT_MODEL_SOURCE_UNAVAILABLE_MESSAGE = "That model's provider can't be checked right now. Try again in a minute."

const notFound = jsonResponse("The organization or team was not found, or the organization default model is off.", notFoundSchema)
const teamParamsSchema = idParamSchema("teamId", "team")

type SaveContext = ResourceActionContext & PermissionRouteContext

async function settingsView(c: SaveContext, organizationId: DenTypeId<"organization">) {
  return { ...await listDefaultModelSettings(organizationId), canEdit: await hasPermission(c, "inference.manage") }
}

async function save(c: SaveContext, input: { teamId: DenTypeId<"team"> | null; model: DefaultModelChoice | null }) {
  const payload = c.get("organizationContext")
  if (!payload) return c.json({ error: "organization_not_found" }, 404)
  const organizationId = payload.organization.id
  if (input.teamId && !await findOrganizationTeamForDefaultModel(organizationId, input.teamId)) {
    return c.json({ error: "team_not_found" }, 404)
  }
  if (input.model) {
    const check = checkDefaultModelChoice(input.model, await listDefaultModelOptions(organizationId))
    if (check === "unknown_model") return c.json({ error: "unknown_model" as const, message: UNKNOWN_DEFAULT_MODEL_MESSAGE }, 400)
    if (check === "source_unavailable") return c.json({ error: "model_source_unavailable" as const, message: DEFAULT_MODEL_SOURCE_UNAVAILABLE_MESSAGE }, 503)
  }
  const write = () => saveDefaultModel({ organizationId, teamId: input.teamId, model: input.model, updatedByOrgMemberId: payload.currentMember.id })
  try {
    await write()
  } catch (error) {
    // A concurrent first save of the same scope created the row; replace it.
    if (!isDuplicateEntry(error)) throw error
    await write()
  }
  return c.json(await settingsView(c, organizationId))
}

const writeResponses = {
  200: jsonResponse("Default models saved.", defaultModelSettingsSchema),
  400: jsonResponse("The model is not one the organization has, or the request was invalid.", z.union([unknownModelSchema, invalidRequestSchema])),
  401: jsonResponse("Authentication required.", unauthorizedSchema),
  403: jsonResponse("The caller lacks the Manage OpenWork Models permission or needs to sign in again.", forbiddenSchema),
  404: notFound,
  503: jsonResponse("The model's provider could not be read to check the model.", sourceUnavailableSchema),
}

/**
 * The model new desktop chats start with (OpenCode v2 engine only): one
 * organization default and an optional override per team,
 * available to every organization.
 */
export function registerOrgDefaultModelRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/default-model",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get default models",
      description:
        "Returns the model new desktop chats start with on the OpenCode v2 engine: the organization default (null for none) and each team's override (null when the team uses the organization default), teams by name. A member on several teams whose overrides differ starts on the organization default; conflictingMemberCount counts them per team. Members can still change the model in each chat. Requires the View OpenWork Models settings permission and the Organization default model feature.",
      responses: {
        200: jsonResponse("Default models returned.", defaultModelSettingsSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the View OpenWork Models settings permission.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("inference.view"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return c.json(await settingsView(c, c.get("organizationContext").organization.id))
    },
  )

  app.get(
    "/v1/org/default-model/options",
    describeRoute({
      tags: ["Organizations"],
      summary: "List models for the default model",
      description:
        "Lists every model the organization can choose as a default, read live from what it has set up: OpenWork Models, the AI Gateway's providers and models, and the organization's own providers. A source that cannot be read is named in unavailableSources and its models are left out. Requires the View OpenWork Models settings permission and the Organization default model feature.",
      responses: {
        200: jsonResponse("Models returned.", defaultModelOptionsSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the View OpenWork Models settings permission.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("inference.view"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return c.json(await listDefaultModelOptions(c.get("organizationContext").organization.id))
    },
  )

  app.put(
    "/v1/org/default-model/everyone",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set the organization default model",
      description:
        "Sets the model new desktop chats start with for every member whose teams do not override it; null removes the organization default. Only models the organization has are accepted. Desktops pick it up the next time they refresh their organization's settings. Requires the Manage OpenWork Models permission, a recent sign-in and the Organization default model feature.",
      responses: writeResponses,
    }),
    orgMemberRoute(),
    requireOrgPermission("inference.manage"),
    jsonValidator(defaultModelWriteSchema),
    async (c) => save(c, { teamId: null, model: c.req.valid("json").model }),
  )

  app.put(
    "/v1/org/default-model/teams/:teamId",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set a team's default model",
      description:
        "Overrides the model new desktop chats start with for one team's members; null makes the team use the organization default again. A member on several teams whose overrides differ starts on the organization default. Only models the organization has are accepted. Requires the Manage OpenWork Models permission, a recent sign-in and the Organization default model feature.",
      responses: writeResponses,
    }),
    orgMemberRoute(),
    requireOrgPermission("inference.manage"),
    paramValidator(teamParamsSchema),
    jsonValidator(defaultModelWriteSchema),
    async (c) => save(c, { teamId: normalizeDenTypeId("team", c.req.valid("param").teamId), model: c.req.valid("json").model }),
  )
}
