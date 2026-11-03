import {
  organizationAutomationSettingsSchema,
  readOrganizationAutomationSettings,
  withOrganizationAutomationSettings,
} from "@openwork/types/den/automation-settings"
import type { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { automationAvailabilityFor, headlessAutomationsConfigured } from "../../automations/organization-availability.js"
import { env } from "../../env.js"
import { jsonValidator, orgMemberRoute, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import type { OrgRouteVariables } from "./shared.js"

const automationSettingsViewSchema = z.object({
  /** What the organization chose. */
  settings: organizationAutomationSettingsSchema,
  /** What members can run now: the choice, the deployment's own switch and, for Cloud, its headless runner. */
  available: organizationAutomationSettingsSchema,
  /** The deployment runs Automations at all (DEN_AUTOMATIONS_ENABLED). */
  deploymentEnabled: z.boolean(),
  /** The deployment has a headless runner, which Cloud Automations need. */
  headlessRunnerConfigured: z.boolean(),
}).meta({ ref: "OrganizationAutomationSettings" })

const automationSettingsInputSchema = organizationAutomationSettingsSchema.partial().strict()
  .refine(value => value.desktop !== undefined || value.cloud !== undefined, { message: "Provide desktop, cloud or both." })
  .meta({ ref: "OrganizationAutomationSettingsInput" })

const errorSchema = z.object({ error: z.string(), message: z.string() })

function view(metadata: unknown) {
  const availability = automationAvailabilityFor({ metadata, headlessRunnerConfigured: headlessAutomationsConfigured() })
  return {
    settings: readOrganizationAutomationSettings(metadata),
    available: { desktop: availability.desktop, cloud: availability.cloud },
    deploymentEnabled: env.automations.enabled,
    headlessRunnerConfigured: availability.headlessRunnerConfigured,
  }
}

/** Settings › Automations: whether members may create and run Desktop and Cloud Automations. */
export function registerOrgAutomationSettingsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    "/v1/org/automation-settings",
    describeRoute({
      tags: ["Organizations"],
      summary: "Get Automation settings",
      description: "Returns whether the organization allows Desktop Automations (run on a member's signed-in desktop) and Cloud Automations (run headlessly in OpenWork Cloud), and what members can run now. Cloud Automations also need the deployment's headless runner. Any member can read it.",
      responses: {
        200: jsonResponse("Automation settings returned.", automationSettingsViewSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return c.json(view(c.get("organizationContext").organization.metadata))
    },
  )

  app.put(
    "/v1/org/automation-settings",
    describeRoute({
      tags: ["Organizations"],
      summary: "Set Automation settings",
      description: "Turns Desktop Automations and Cloud Automations on or off for the organization. Turning a kind off stops new ones from being created and skips its scheduled runs; existing Automations and their history are kept and resume when it is turned back on. Cloud Automations cannot be turned on until the deployment has a headless runner. Requires Edit organization settings.",
      responses: {
        200: jsonResponse("Automation settings saved.", automationSettingsViewSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller cannot edit organization settings.", forbiddenSchema),
        409: jsonResponse("Cloud Automations need the deployment's headless runner.", errorSchema),
      },
    }),
    orgMemberRoute(),
    requireOrgPermission("organization.update"),
    jsonValidator(automationSettingsInputSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const input = c.req.valid("json")
      if (input.cloud === true && !headlessAutomationsConfigured()) {
        return c.json({ error: "headless_runner_required", message: "Cloud Automations need OpenWork's headless runner on this deployment. Ask your OpenWork operator to set it up." }, 409)
      }
      const metadata = await updateOrganizationMetadata(c.get("organizationContext").organization.id, current => withOrganizationAutomationSettings(current, input))
      return c.json(view(metadata))
    },
  )
}
