import {
  organizationRemoteSessionSettingsResponseSchema,
  organizationRemoteSessionSettingsSchema,
  withOrganizationRemoteSessionSettings,
} from "@openwork/types/den/remote-sessions"
import type { Hono } from "hono"
import { z } from "zod"
import { automationRepository } from "../../automations/repository.js"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { requireAnyFeature, type FeatureMap } from "../../features.js"
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
const featureDisabledSchema = z.object({ error: z.literal("feature_disabled"), feature: z.literal("remoteSessionAccess") })

/** The setting belongs to both access features; an organization with Devices also has it, to turn remote access off for everyone. */
const requireSettingFeature = requireAnyFeature(["remoteSessionAccess", "remoteTasksOptIn", "remoteDevices"])

/** The setting as it applies: a stored `all` reads as `created` while `remoteSessionAccess` is off. */
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
      description: "Returns the widest access members may choose for their own computers: off (nobody's computer takes anything from other devices), created (tasks can be started on a computer from other devices, and only those sessions reached) or all (also sessions started on the computer itself, once attached). Each member still chooses per computer in OpenWork, and the narrower of the two applies. allowsAll says whether all can be chosen (the remoteSessionAccess feature); a stored all reads as created while it cannot. optIn says whether a computer whose owner has not chosen takes nothing (the remoteTasksOptIn feature). Any member can read it; canEdit says whether the caller can change it. Requires one of the remoteDevices, remoteSessionAccess or remoteTasksOptIn features.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("Remote session settings returned.", organizationRemoteSessionSettingsResponseSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        404: notFound,
      },
    }),
    orgMemberRoute(),
    requireSettingFeature,
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
      description: "Sets the widest access members may choose for their own computers: off, created or all. Lowering it applies at once. To created: sessions that were started on a computer stop being listed and can no longer be read, followed up, stopped or answered from other devices, whatever a member chose, and have to be attached again if it is raised later; sessions started remotely are not affected. To off: also no task can be started on anyone's computer from another device and no session there is reached, answered with 409 remote_access_off, until it is raised again. all needs the remoteSessionAccess feature: without it the request answers 409 feature_disabled and nothing is saved. Requires Edit organization settings and one of the remoteDevices, remoteSessionAccess or remoteTasksOptIn features.",
      "x-mcp": false,
      responses: {
        200: jsonResponse("Remote session settings saved.", organizationRemoteSessionSettingsResponseSchema),
        400: jsonResponse("The request was invalid.", invalidRequestSchema),
        401: jsonResponse("Authentication required.", unauthorizedSchema),
        403: jsonResponse("The caller cannot edit organization settings.", forbiddenSchema),
        404: notFound,
        409: jsonResponse("all was asked for and the organization does not have the remoteSessionAccess feature.", featureDisabledSchema),
      },
    }),
    orgMemberRoute(),
    requireSettingFeature,
    requireOrgPermission("organization.update"),
    jsonValidator(settingsInputSchema),
    async (c) => {
      c.header("Cache-Control", "no-store")
      const settings = c.req.valid("json")
      const context = c.get("organizationContext")
      if (settings.access === "all" && !context.features.remoteSessionAccess) {
        return c.json({ error: "feature_disabled" as const, feature: "remoteSessionAccess" as const }, 409)
      }
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
