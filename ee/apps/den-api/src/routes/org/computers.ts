import {
  REMOTE_DEVICE_AVAILABILITIES,
  REMOTE_DEVICE_KINDS,
  REMOTE_DEVICE_PROVIDERS,
  organizationComputerDetailResponseSchema,
  organizationComputerDisconnectResponseSchema,
  organizationComputerListResponseSchema,
  organizationComputerInstanceDetailResponseSchema,
} from "@openwork/types/den/remote-devices"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { orgMemberRoute, paramValidator, queryValidator, requireOrgPermission } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { addAuditRequestResource } from "../../audit/request-capture.js"
import { signInSessionOf } from "../../computer-disconnect.js"
import { disconnectOrganizationComputer, listOrganizationComputerRecords, readOrganizationComputerRecord, removeOrganizationComputer } from "../../remote-devices.js"
import { readOrganizationComputerInstance } from "../../organization-computer-instances.js"
import { remoteDeviceFailure } from "./remote-devices.js"
import { hasPermission, type OrgRouteVariables } from "./shared.js"

const base = "/v1/org/computers"
const errors = {
  400: jsonResponse("Invalid filter or id.", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  403: jsonResponse("View team computers permission required.", forbiddenSchema),
  404: jsonResponse("Computer not found, or Devices is off.", notFoundSchema),
}
const listQuerySchema = z.object({
  search: z.string().max(160).optional(),
  kind: z.enum(REMOTE_DEVICE_KINDS).optional(),
  provider: z.enum(REMOTE_DEVICE_PROVIDERS).optional(),
  availability: z.enum(REMOTE_DEVICE_AVAILABILITIES).optional(),
  /** `include` also lists desktops nobody has heard from for 30 days; anything else leaves them out. */
  stale: z.string().max(16).optional(),
  page: z.string().regex(/^[1-9]\d{0,8}$/).optional(),
  instancePage: z.string().regex(/^[1-9]\d{0,8}$/).optional(),
  instanceDestination: z.enum(["local", "cloud"]).optional(),
  instanceStatus: z.enum(["provisioning", "healthy", "failed", "stopped"]).optional(),
  instanceProvider: z.string().max(64).optional(),
})
const deviceParamsSchema = z.object({ deviceId: denTypeIdSchema("remoteDevice") })
const instanceParamsSchema = z.object({ instanceId: denTypeIdSchema("worker") })
const describeComputerRead = (options: DescribeRouteOptions & { "x-mcp": true }) => describeRoute(options)
const errorSchema = z.object({ error: z.string(), message: z.string() })
const changeErrors = {
  ...errors,
  403: jsonResponse("Disconnect team computers permission and a recent sign-in required.", forbiddenSchema),
}

/** Organization inventory is separate from the member's own/shared, usable computers. */
export function registerOrgComputerRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(base, describeComputerRead({
    tags: ["Devices"], operationId: "listOrganizationComputers", "x-mcp": true,
    summary: "List team computers",
    description: "Read-only computer inventory for the current organization, including all members and shared registered devices. Includes owners, type, provider, versions, state, last contact and reported readiness. Desktops nobody has heard from for 30 days are left out and counted in `staleHidden` unless `stale=include`; a disconnected desktop stays listed for 30 days after it was disconnected. `total` and paging count what is listed, and `online` how many of those answered in the last ten minutes. Retained runner-only registrations are imported within this organization, even when stale. Registrations already pruned by runner retention cannot be recovered. `canDisconnect` and `canRemove` say what the caller may do with computers.disconnect. `remoteAccess` on a desktop that takes tasks from other devices says what they may do there under its owner's own policy, whether the owner chose it, and why when something else decides it. Devices and registered local/cloud worker instances are independently paged, 50 per page. `search` applies to both; kind/provider/availability/page filter devices; instanceDestination/instanceStatus/instanceProvider/instancePage filter registered instances. Never deployment-wide totals, credentials, files, screen content or conversation titles. Requires Devices and computers.view; does not grant control of computers.",
    responses: { 200: jsonResponse("Team computers returned.", organizationComputerListResponseSchema), ...errors },
  }), orgMemberRoute(), requireOrgPermission("computers.view"), queryValidator(listQuerySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const query = c.req.valid("query")
    return c.json(await listOrganizationComputerRecords({
      organizationId: context.organization.id,
      search: query.search, kind: query.kind, provider: query.provider, availability: query.availability,
      includeStale: query.stale === "include",
      page: query.page ? Number(query.page) : 1,
      instancePage: query.instancePage ? Number(query.instancePage) : 1,
      instanceDestination: query.instanceDestination, instanceStatus: query.instanceStatus, instanceProvider: query.instanceProvider,
    }, { canDisconnect: await hasPermission(c, "computers.disconnect") }))
  })
  app.get(`${base}/instances/:instanceId`, describeComputerRead({
    tags: ["Devices"], operationId: "getOrganizationComputerInstance", "x-mcp": true,
    summary: "Get registered OpenWork instance inventory",
    description: "A registered local or cloud worker host in the current organization. Reported status and heartbeat only, never inferred OS or online state. No endpoints, tokens, provider reference blobs or workspace paths. Requires Devices and computers.view.",
    responses: { 200: jsonResponse("Registered instance returned.", organizationComputerInstanceDetailResponseSchema), ...errors },
  }), orgMemberRoute(), requireOrgPermission("computers.view"), paramValidator(instanceParamsSchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const detail = await readOrganizationComputerInstance(context.organization.id, c.req.valid("param").instanceId)
    return detail ? c.json(detail) : c.json({ error: "not_found", message: "Instance not found." }, 404)
  })
  app.get(`${base}/:deviceId`, describeComputerRead({
    tags: ["Devices"], operationId: "getOrganizationComputer", "x-mcp": true,
    summary: "Get team computer inventory details",
    description: "One computer in the current organization, its reported OS, architecture, adapters, readiness, versions, fixed events, runner capabilities and workspace count. Owner feature state is resolved only within this organization. No credentials, workspace paths, screen content or conversation titles. Requires Devices and computers.view.",
    responses: { 200: jsonResponse("Team computer returned.", organizationComputerDetailResponseSchema), ...errors },
  }), orgMemberRoute(), requireOrgPermission("computers.view"), paramValidator(deviceParamsSchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const detail = await readOrganizationComputerRecord(context.organization.id, c.req.valid("param").deviceId, { canDisconnect: await hasPermission(c, "computers.disconnect") })
    return detail ? c.json(detail) : c.json({ error: "not_found", message: "Computer not found." }, 404)
  })
  app.post(`${base}/:deviceId/disconnect`, describeRoute({
    tags: ["Devices"], operationId: "disconnectOrganizationComputer",
    summary: "Disconnect a member's computer",
    description: "Disconnects a current member's signed-in desktop from the organization. Den stops accepting that install as the member's computer at once: it gets no runner credential, takes no remote tasks, shares no sessions and its reports are refused with 403 computer_disconnected; work that was going through it is failed. Where Den knows the sign-in the desktop uses and it is not the one making this request, that sign-in is ended too (`signedOut`), so OpenWork there is signed out. The computer stays in the team list as disconnected; signing in on it again connects it again. Repeating the call changes nothing. A computer that never signs in, or whose owner is no longer a member (it is already refused; remove it instead), answers 409 not_disconnectable. Requires Devices and computers.disconnect with a recent sign-in. Grants no access to the computer.",
    responses: {
      200: jsonResponse("The computer, now disconnected, and whether its sign-in was ended.", organizationComputerDisconnectResponseSchema),
      ...changeErrors,
      409: jsonResponse("This computer cannot be disconnected.", errorSchema),
    },
  }), orgMemberRoute(), requireOrgPermission("computers.disconnect"), paramValidator(deviceParamsSchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    try {
      const { device, signedOut, ownerMemberId } = await disconnectOrganizationComputer(
        { organizationId: context.organization.id, memberId: context.currentMember.id },
        c.req.valid("param").deviceId,
        { sessionId: signInSessionOf(c)?.id ?? null },
      )
      addAuditRequestResource(c, { type: "member", id: ownerMemberId })
      return c.json({ device, signedOut })
    } catch (error) {
      const failed = remoteDeviceFailure(error)
      return c.json(failed.body, failed.status)
    }
  })
  app.delete(`${base}/:deviceId`, describeRoute({
    tags: ["Devices"], operationId: "removeOrganizationComputer",
    summary: "Remove a computer from the team list",
    description: "Takes a computer off the team list when its `canRemove` is true: its owner is no longer a member, it is disconnected, it was registered by hand, or it is a desktop nobody has heard from for 30 days. A connected desktop of a current member answers 409 disconnect_first, because it would report itself back. Nothing is stopped or deleted at a provider, and a disconnected desktop stays disconnected. Requires Devices and computers.disconnect with a recent sign-in.",
    responses: {
      204: { description: "Removed." },
      ...changeErrors,
      409: jsonResponse("The computer is connected; disconnect it first.", errorSchema),
    },
  }), orgMemberRoute(), requireOrgPermission("computers.disconnect"), paramValidator(deviceParamsSchema), async (c) => {
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    try {
      await removeOrganizationComputer({ organizationId: context.organization.id, memberId: context.currentMember.id }, c.req.valid("param").deviceId)
      return c.body(null, 204)
    } catch (error) {
      const failed = remoteDeviceFailure(error)
      return c.json(failed.body, failed.status)
    }
  })
}
