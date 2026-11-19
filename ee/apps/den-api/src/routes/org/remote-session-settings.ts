import {
  organizationRemoteSessionSettingsResponseSchema,
  organizationRemoteSessionSettingsSchema,
  withOrganizationRemoteSessionSettings,
} from "@openwork/types/den/remote-sessions"
import type { Hono } from "hono"
import { automationRepository } from "../../automations/repository.js"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import type { FeatureMap } from "../../features.js"
import { jsonValidator, orgMemberRoute, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import { remoteSessionAccessPolicy } from "../../remote-sessions/access.js"
import { databaseRemoteSessionCommandStore } from "../../remote-sessions/commands.js"
import { hasPermission, type OrgRouteVariables } from "./shared.js"

const path = "/v1/org/remote-session-settings"
const describeSettingsRoute = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)
const settingsInputSchema = organizationRemoteSessionSettingsSchema.strict().meta({ ref: "OrganizationRemoteSessionSettingsInput" })
const notFound = jsonResponse("The organization was not found, or it uses neither Devices, sessions on members' computers nor the opt-in for tasks from other devices.", notFoundSchema)

/** The setting belongs to both access features; an organization with Devices also has it, to turn remote access off for everyone. */

/** The setting as it applies: the stored organization ceiling always applies. */
function settingsResponse(features: FeatureMap, metadata: unknown, canEdit: boolean) {
  const policy = remoteSessionAccessPolicy({ features, metadata })
  return { settings: { access: policy.ceiling }, canEdit, allowsAll: policy.enabled, optIn: policy.optIn }
}

/**
 * What other devices may do on members' own computers, at most: the
 * organization's ceiling over each member's choice per computer. Read
 * everywhere through remote-sessions/access.ts.
 */
export function registerOrgRemoteSessionSettingsRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(
    path,
    describeSettingsRoute({
      tags: ["Organizations"],
      summary: "Get remote session settings",
      description: "Returns the widest access members may choose for their own computers: off (nobody's computer takes anything from other devices), created (tasks can be started on a computer from other devices, and only those sessions reached) or all (also sessions started on the computer itself, once attached). Each member still chooses per computer in OpenWork, and the narrower of the two applies. allowsAll is always true; all can be chosen by an authorized editor, but access still requires both the organization ceiling and the computer owner to allow it. optIn says whether a computer whose owner has not chosen takes nothing (the remoteTasksOptIn feature). Any member can read it; canEdit says whether the caller can change it. Requires active organization membership.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("Remote session settings returned.", organizationRemoteSessionSettingsResponseSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const context = c.get("organizationContext")
      return c.json(settingsResponse(context.features, context.organization.metadata, await hasPermission(c, "organization.update")))
    },
  )

  app.patch(
    path,
    describeSettingsRoute({
      tags: ["Organizations"],
      summary: "Set remote session settings",
      description: "Sets the widest access members may choose for their own computers: off, created or all. Lowering it applies at once. To created: sessions that were started on a computer stop being listed and can no longer be read, followed up, stopped or answered from other devices, whatever a member chose, and have to be attached again if it is raised later; sessions started remotely are not affected. To off: also no task can be started on anyone's computer from another device and no session there is reached, answered with 409 remote_access_off, until it is raised again. Requires Edit organization settings. Each computer still enforces its owner's choice and its supported runner capabilities.",
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
    requireOrgPermission("organization.update"),
    jsonValidator(settingsInputSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const settings = c.req.valid("json")
      const context = c.get("organizationContext")

      const organizationId = context.organization.id
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
      return c.json(settingsResponse(context.features, metadata, true))
    },
  )
}
