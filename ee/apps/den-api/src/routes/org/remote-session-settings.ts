import {
  organizationRemoteSessionSettingsResponseSchema,
  organizationRemoteSessionSettingsSchema,
  readOrganizationRemoteSessionSettings,
  withOrganizationRemoteSessionSettings,
} from "@openwork/types/den/remote-sessions"
import type { Hono } from "hono"
import { automationRepository } from "../../automations/repository.js"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import { databaseRemoteSessionCommandStore } from "../../remote-sessions/commands.js"
import { hasPermission, type OrgRouteVariables } from "./shared.js"

const path = "/v1/org/remote-session-settings"
const describeSettingsRoute = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)
const settingsInputSchema = organizationRemoteSessionSettingsSchema.strict().meta({ ref: "OrganizationRemoteSessionSettingsInput" })
const notFound = jsonResponse("The organization was not found, or sessions on members' computers are off.", notFoundSchema)

/**
 * Which sessions on members' own computers other devices may reach, at most:
 * the organization's ceiling over each member's choice per computer. Read
 * everywhere through remote-sessions/access.ts.
 */
export function registerOrgRemoteSessionSettingsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    path,
    describeSettingsRoute({
      tags: ["Organizations"],
      summary: "Get remote session settings",
      description: "Returns the widest access members may choose for their own computers: created (other devices reach only sessions that were started remotely) or all (also sessions started on the computer itself, once attached). Each member still chooses per computer in OpenWork, and the narrower of the two applies. Any member can read it; canEdit says whether the caller can change it. Requires the remoteSessionAccess feature.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("Remote session settings returned.", organizationRemoteSessionSettingsResponseSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("remoteSessionAccess"),
    async (c) => {
      c.header("Cache-Control", "no-store")
      return c.json({
        settings: readOrganizationRemoteSessionSettings(c.get("organizationContext").organization.metadata),
        canEdit: await hasPermission(c, "organization.update"),
      })
    },
  )

  app.patch(
    path,
    describeSettingsRoute({
      tags: ["Organizations"],
      summary: "Set remote session settings",
      description: "Sets the widest access members may choose for their own computers: created or all. Lowering it to created applies at once: sessions that were started on a computer stop being listed and can no longer be read, followed up, stopped or answered from other devices, whatever a member chose, and have to be attached again if it is raised later. Sessions started remotely are not affected. Requires Edit organization settings and the remoteSessionAccess feature.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("Remote session settings saved.", organizationRemoteSessionSettingsResponseSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller cannot edit organization settings.", forbiddenSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireFeature("remoteSessionAccess"),
    requireOrgPermission("organization.update"),
    jsonValidator(settingsInputSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const settings = c.req.valid("json")
      const organizationId = c.get("organizationContext").organization.id
      const metadata = await updateOrganizationMetadata(organizationId, (current) => withOrganizationRemoteSessionSettings(current, settings))
      // Den stops showing reported sessions the moment the ceiling drops; it also stops
      // keeping them, and lets go of every attach, so raising the ceiling later reopens nothing by itself.
      if (settings.access !== "all") {
        const now = Date.now()
        await Promise.all([
          automationRepository.clearReportedSessions({ organizationId, now }),
          databaseRemoteSessionCommandStore.detach({ organizationId, now }),
        ])
      }
      return c.json({ settings: readOrganizationRemoteSessionSettings(metadata), canEdit: true })
    },
  )
}
