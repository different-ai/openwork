import {
  organizationAutomationSettingsSchema,
  readOrganizationAutomationSettings,
  type OrganizationAutomationSettings,
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
import type { OrganizationContext } from "../../orgs.js"
import type { OrgRouteVariables } from "./shared.js"

const automationSettingsViewSchema = z.object({
  settings: organizationAutomationSettingsSchema,
  available: organizationAutomationSettingsSchema,
  deploymentEnabled: z.boolean(),
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

export async function saveOrganizationAutomationSettings(organizationId: OrganizationContext["organization"]["id"], input: Partial<OrganizationAutomationSettings>) {
  if (input.cloud === true && !headlessAutomationsConfigured()) {
    return { ok: false as const, error: "headless_runner_required" as const, message: "Cloud Automations need OpenWork's headless runner on this deployment. Ask your OpenWork operator to set it up." }
  }
  const metadata = await updateOrganizationMetadata(organizationId, current => withOrganizationAutomationSettings(current, input))
  return { ok: true as const, metadata }
}

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
      const saved = await saveOrganizationAutomationSettings(c.get("organizationContext").organization.id, c.req.valid("json"))
      if (!saved.ok) return c.json({ error: saved.error, message: saved.message }, 409)
      return c.json(view(saved.metadata))
    },
  )
}
