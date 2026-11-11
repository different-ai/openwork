import {
  REMOTE_DEVICE_AVAILABILITIES,
  REMOTE_DEVICE_KINDS,
  REMOTE_DEVICE_PROVIDERS,
  organizationComputerDetailResponseSchema,
  organizationComputerListResponseSchema,
  organizationComputerInstanceDetailResponseSchema,
} from "@openwork/types/den/remote-devices"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { requireFeature } from "../../features.js"
import { orgMemberRoute, paramValidator, queryValidator, requireOrgPermission } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { listOrganizationComputerRecords, readOrganizationComputerRecord } from "../../remote-devices.js"
import { readOrganizationComputerInstance } from "../../organization-computer-instances.js"
import type { OrgRouteVariables } from "./shared.js"

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
  page: z.string().regex(/^[1-9]\d{0,8}$/).optional(),
  instancePage: z.string().regex(/^[1-9]\d{0,8}$/).optional(),
  instanceDestination: z.enum(["local", "cloud"]).optional(),
  instanceStatus: z.enum(["provisioning", "healthy", "failed", "stopped"]).optional(),
  instanceProvider: z.string().max(64).optional(),
})
const deviceParamsSchema = z.object({ deviceId: denTypeIdSchema("remoteDevice") })
const instanceParamsSchema = z.object({ instanceId: denTypeIdSchema("worker") })
const describeComputerRead = (options: DescribeRouteOptions & { "x-mcp": true }) => describeRoute(options)

/** Organization inventory is separate from the member's own/shared, usable computers. */
export function registerOrgComputerRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(base, describeComputerRead({
    tags: ["Devices"], operationId: "listOrganizationComputers", "x-mcp": true,
    summary: "List team computers",
    description: "Read-only computer inventory for the current organization, including all members and shared registered devices. Includes owners, type, provider, versions, state, last contact and reported readiness. Nonremoved desktops remain visible regardless of age; retained runner-only registrations are imported within this organization, even when stale. Registrations already pruned by runner retention cannot be recovered. Devices and registered local/cloud worker instances are independently paged, 50 per page. `search` applies to both; kind/provider/availability/page filter devices; instanceDestination/instanceStatus/instanceProvider/instancePage filter registered instances. Never deployment-wide totals, credentials, files, screen content or conversation titles. Requires Devices and computers.view; does not grant control of computers.",
    responses: { 200: jsonResponse("Team computers returned.", organizationComputerListResponseSchema), ...errors },
  }), orgMemberRoute(), requireFeature("remoteDevices"), requireOrgPermission("computers.view"), queryValidator(listQuerySchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const query = c.req.valid("query")
    return c.json(await listOrganizationComputerRecords({
      organizationId: context.organization.id,
      search: query.search, kind: query.kind, provider: query.provider, availability: query.availability,
      page: query.page ? Number(query.page) : 1,
      instancePage: query.instancePage ? Number(query.instancePage) : 1,
      instanceDestination: query.instanceDestination, instanceStatus: query.instanceStatus, instanceProvider: query.instanceProvider,
    }))
  })
  app.get(`${base}/instances/:instanceId`, describeComputerRead({
    tags: ["Devices"], operationId: "getOrganizationComputerInstance", "x-mcp": true,
    summary: "Get registered OpenWork instance inventory",
    description: "A registered local or cloud worker host in the current organization. Reported status and heartbeat only, never inferred OS or online state. No endpoints, tokens, provider reference blobs or workspace paths. Requires Devices and computers.view.",
    responses: { 200: jsonResponse("Registered instance returned.", organizationComputerInstanceDetailResponseSchema), ...errors },
  }), orgMemberRoute(), requireFeature("remoteDevices"), requireOrgPermission("computers.view"), paramValidator(instanceParamsSchema), async (c) => {
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
  }), orgMemberRoute(), requireFeature("remoteDevices"), requireOrgPermission("computers.view"), paramValidator(deviceParamsSchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const detail = await readOrganizationComputerRecord(context.organization.id, c.req.valid("param").deviceId)
    return detail ? c.json(detail) : c.json({ error: "not_found", message: "Computer not found." }, 404)
  })
}
