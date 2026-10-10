import { readWorkbotModel, withWorkbotModel, workbotSettingsInputSchema, workbotSettingsSchema } from "@openwork/types/den/workbot-settings"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import {
  checkWorkbotModelChoice,
  forgetHeadlessModelCatalog,
  headlessModelCatalog,
  readOrganizationDefaultModel,
  workbotSettingsView,
} from "../../workbot/model.js"
import type { OrgRouteVariables } from "./shared.js"

const workbotSettingsDocumentSchema = workbotSettingsSchema.meta({ ref: "WorkbotSettings" })
const workbotSettingsInputDocumentSchema = workbotSettingsInputSchema.meta({ ref: "WorkbotSettingsInput" })
const featureDisabledSchema = z.object({ error: z.literal("feature_disabled"), feature: z.string() })
const unknownModelSchema = z.object({ error: z.literal("unknown_model"), message: z.string() }).meta({ ref: "WorkbotUnknownModelError" })
const runnerUnavailableSchema = z
  .object({ error: z.literal("workbot_runner_unavailable"), message: z.string() })
  .meta({ ref: "WorkbotRunnerUnavailableError" })

export const UNKNOWN_MODEL_MESSAGE = "Workbot can't use that model. Choose one from the list."
export const RUNNER_UNAVAILABLE_MESSAGE = "Workbot's models can't be checked right now. Try again in a minute."

const notFound = jsonResponse("The organization was not found, or Workbot or its workbotDefaultModel feature is off.", featureDisabledSchema)

/**
 * Manage › Workbot: the organization's default model for its cloud agents (Workbot, the Slack assistant, and cloud
 * Automations set to the cloud default). Admins choose it from the models the headless runner serves.
 */
export function registerOrgWorkbotSettingsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/workbot-settings",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get Workbot settings",
      description:
        "Returns the organization's default model for Workbot, the Slack assistant and cloud Automations set to the cloud default (null means the headless runner's default), and the models the runner can serve. Requires the View OpenWork Models settings permission, Workbot and the workbotDefaultModel feature.",
      responses: {
        200: jsonResponse("Workbot settings returned.", workbotSettingsDocumentSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the View OpenWork Models settings permission.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("workbot"),
    requireFeature("workbotDefaultModel"),
    requireOrgPermission("inference.view"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const organizationId = c.get("organizationContext").organization.id
      const chosen = await readOrganizationDefaultModel(organizationId)
      return c.json(workbotSettingsView(chosen, await headlessModelCatalog()))
    },
  )

  app.put(
    "/v1/org/workbot-settings",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set Workbot's default model",
      description:
        "Sets the organization's default model for Workbot, the Slack assistant and cloud Automations set to the cloud default, from their next message or run; null uses the headless runner's default. Automations with their own model keep it. Only models the runner serves are accepted. Requires the Manage OpenWork Models permission, a recent sign-in, Workbot and the workbotDefaultModel feature.",
      responses: {
        200: jsonResponse("Workbot settings saved.", workbotSettingsDocumentSchema),
        400: jsonResponse("The model is not one the runner serves, or the request was invalid.", z.union([unknownModelSchema, invalidRequestSchema])),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller lacks the Manage OpenWork Models permission or needs to sign in again.", forbiddenSchema),
        404: notFound,
        503: jsonResponse("The headless runner could not be reached to check the model.", runnerUnavailableSchema),
      },
    }),
    orgMemberRoute(),
    requireFeature("workbot"),
    requireFeature("workbotDefaultModel"),
    requireOrgPermission("inference.manage"),
    jsonValidator(workbotSettingsInputDocumentSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const organizationId = c.get("organizationContext").organization.id
      const { model } = c.req.valid("json")
      // Checked against a fresh catalog, so a model added to the runner a moment ago can be chosen.
      if (model !== null) forgetHeadlessModelCatalog()
      const catalog = await headlessModelCatalog()
      const choice = checkWorkbotModelChoice(model, catalog)
      if (choice === "runner_unavailable") return c.json({ error: "workbot_runner_unavailable" as const, message: RUNNER_UNAVAILABLE_MESSAGE }, 503)
      if (choice === "unknown_model") return c.json({ error: "unknown_model" as const, message: UNKNOWN_MODEL_MESSAGE }, 400)
      const metadata = await updateOrganizationMetadata(organizationId, (current) => withWorkbotModel(current, model))
      return c.json(workbotSettingsView(readWorkbotModel(metadata), catalog))
    },
  )
}
