import {
  ORGANIZATION_COMPUTER_INVENTORY_TABS, computerInventoryDetailResponseSchema, myComputerInventoryResponseSchema, organizationComputerInventoryResponseSchema,
} from "@openwork/types/den/computer-inventory"
import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { listMyComputerInventory, listOrganizationComputerInventory, readComputerInventoryDetail, readInventoryInstanceDetail } from "../../computers/inventory-store.js"
import { requireFeature } from "../../features.js"
import { orgMemberRoute, paramValidator, queryValidator, requireOrgPermission } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { hasPermission, type OrgRouteVariables } from "./shared.js"

const memberBase = "/v1/computers/inventory"
const organizationBase = "/v1/org/computers/inventory"
const computerId = denTypeIdSchema("remoteDevice")
const workerId = denTypeIdSchema("worker")
const detailParams = z.object({ computerId })
const adminDetailParams = z.object({ computerId: z.union([computerId, workerId]) })
const listQuery = z.object({
  tab: z.enum(ORGANIZATION_COMPUTER_INVENTORY_TABS).default("desktops"),
  search: z.string().max(160).optional(),
  older: z.literal("include").optional(),
  page: z.string().regex(/^[1-9]\d{0,8}$/).optional(),
})
const errors = {
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  404: jsonResponse("The computer or organization was not found, or Computers is off.", notFoundSchema),
}
const invalid = jsonResponse("Invalid filter or computer id.", invalidRequestSchema)
const forbidden = jsonResponse("View team computers permission required.", forbiddenSchema)
const describeInventory = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)
const noStore: MiddlewareHandler = async (c, next) => {
  c.header("Cache-Control", "no-store")
  await next()
}

export function registerComputerInventoryRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(memberBase, describeInventory({
    tags: ["Devices"], operationId: "listMyComputerInventory", "x-mcp": false,
    summary: "List my computers",
    description: "Lists the caller's computers and computers shared with the organization. Sign-ins on the same computer are grouped for display only. Includes reachability and what the different access settings allow.",
    responses: { 200: jsonResponse("The computers.", myComputerInventoryResponseSchema), ...errors },
  }), noStore, orgMemberRoute(), requireFeature("computers"), async (c) => {
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const actor = { organizationId: context.organization.id, memberId: context.currentMember.id }
    return c.json(await listMyComputerInventory({ kind: "member", actor, canManageShared: await hasPermission(c, "desktop_policies.manage") }))
  })

  app.get(`${memberBase}/:computerId`, describeInventory({
    tags: ["Devices"], operationId: "getMyComputerInventoryDetail", "x-mcp": false,
    summary: "Get one of my computers",
    description: "Shows installation, access settings, and recent activity for a computer the caller owns or that is shared with the organization. The computer id must be the one shown in the list.",
    responses: { 200: jsonResponse("The computer details.", computerInventoryDetailResponseSchema), 400: invalid, ...errors },
  }), noStore, orgMemberRoute(), requireFeature("computers"), paramValidator(detailParams), async (c) => {
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const actor = { organizationId: context.organization.id, memberId: context.currentMember.id }
    const detail = await readComputerInventoryDetail({ kind: "member", actor, canManageShared: await hasPermission(c, "desktop_policies.manage") }, c.req.valid("param").computerId)
    return detail ? c.json(detail) : c.json({ error: "not_found", message: "Computer not found." }, 404)
  })

  app.get(organizationBase, describeInventory({
    tags: ["Devices"], operationId: "listOrganizationComputerInventory", "x-mcp": false,
    summary: "List the organization's computer inventory",
    description: "Lists grouped computers by tab, with counts matching the current search. Computers not heard from in the past week are hidden by default. Use `older=include` to show them. Requires the View team computers permission.",
    responses: { 200: jsonResponse("The team computers.", organizationComputerInventoryResponseSchema), 400: invalid, 403: forbidden, ...errors },
  }), noStore, orgMemberRoute(), requireFeature("computers"), requireOrgPermission("computers.view"), queryValidator(listQuery), async (c) => {
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const actor = { organizationId: context.organization.id, memberId: context.currentMember.id }
    const input = c.req.valid("query")
    return c.json(await listOrganizationComputerInventory({ kind: "organization", actor, canDisconnect: await hasPermission(c, "computers.disconnect") }, { ...input, page: Number(input.page ?? 1) }))
  })

  app.get(`${organizationBase}/:computerId`, describeInventory({
    tags: ["Devices"], operationId: "getOrganizationComputerInventoryDetail", "x-mcp": false,
    summary: "Get one computer in the organization's inventory",
    description: "Shows installation, access settings, and recent activity for a computer in the organization. The computer id must be the one shown in the list. Requires the View team computers permission.",
    responses: { 200: jsonResponse("The team computer details.", computerInventoryDetailResponseSchema), 400: invalid, 403: forbidden, ...errors },
  }), noStore, orgMemberRoute(), requireFeature("computers"), requireOrgPermission("computers.view"), paramValidator(adminDetailParams), async (c) => {
    const context = c.get("organizationContext")
    if (!context) return c.json({ error: "organization_not_found" }, 404)
    const actor = { organizationId: context.organization.id, memberId: context.currentMember.id }
    const viewer = { kind: "organization" as const, actor, canDisconnect: await hasPermission(c, "computers.disconnect") }
    const id = c.req.valid("param").computerId
    const instance = workerId.safeParse(id)
    const detail = instance.success ? await readInventoryInstanceDetail(viewer, instance.data)
      : await readComputerInventoryDetail(viewer, computerId.parse(id))
    return detail ? c.json(detail) : c.json({ error: "not_found", message: "Computer not found." }, 404)
  })
}
