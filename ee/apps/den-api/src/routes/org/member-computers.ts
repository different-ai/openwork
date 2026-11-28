import { computerAccessSettingSchema, computerAuthorizeRequestSchema, computerAuthorizeResponseSchema, computerListResponseSchema, listedComputerSchema } from "@openwork/types/den/computers"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { authorizeMemberComputer, listMemberComputers, setMemberComputerAccess } from "../../computers/member.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, paramValidator } from "../../middleware/index.js"
import { denTypeIdSchema, invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

const base = "/v1/computers"
const computerParamsSchema = z.object({ computerId: denTypeIdSchema("remoteDevice") })
const describeComputerRoute = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)
const featureOffSchema = z.object({ error: z.literal("feature_disabled"), feature: z.literal("computers") })
const organizationNotFoundSchema = z.object({ error: z.literal("organization_not_found") })
const computerNotFoundSchema = z.object({ error: z.literal("computer_not_found") })
const conflicts = {
  choose_on_that_computer: "You can't change access to a personal computer here.",
  not_configurable: "You can't change access to this computer here.",
}
const unauthorized = jsonResponse("Sign in required.", unauthorizedSchema)
const notFound = jsonResponse("No such computer for this member or Computers is off.", z.union([computerNotFoundSchema, featureOffSchema, organizationNotFoundSchema]))
const invalid = jsonResponse("Invalid computer id or request body.", invalidRequestSchema)

export function registerOrgMemberComputerRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(base, describeComputerRoute({
    tags: ["Devices"], operationId: "listMemberComputers", "x-mcp": false,
    summary: "List my computers and what I can reach",
    description: "Lists the caller's computers and those shared with the organization. Shows each computer's state and whether it takes work from an OpenWork app signed in as the caller. Access settings appear only on the caller's own registered virtual computers. Does not return provider ids or credentials. Requires active organization membership and Computers.",
    responses: {
      200: jsonResponse("The computers and their reach.", computerListResponseSchema),
      401: unauthorized,
      404: jsonResponse("No such organization or Computers is off.", z.union([featureOffSchema, organizationNotFoundSchema])),
    },
  }), orgMemberRoute(), requireFeature("computers"), async (c) => {
    c.header("Cache-Control", "no-store")
    const context = c.get("organizationContext")
    return c.json(await listMemberComputers({ organizationId: context.organization.id, memberId: context.currentMember.id }))
  })

  app.put(`${base}/:computerId/access`, describeComputerRoute({
    tags: ["Devices"], operationId: "setMemberComputerAccess", "x-mcp": false,
    summary: "Choose whether my OpenWork apps can access my entire virtual computer",
    description: "Only the owner can allow their OpenWork apps to access the entire registered virtual computer. Allowing access requires agreeing to let those apps use the entire computer and choosing one working folder, which is a starting point, not an access limit. Turning access off revokes permission. The organization can still turn access off. This setting isn't available for personal or Workbot computers. Requires active organization membership and Computers.",
    responses: {
      200: jsonResponse("The computer with its saved access choice and working folder, if allowed.", z.object({ computer: listedComputerSchema })),
      400: invalid,
      401: unauthorized,
      404: notFound,
      409: jsonResponse("This computer cannot be configured here.", z.object({ error: z.enum(["choose_on_that_computer", "not_configurable"]), message: z.string() })),
    },
  }), orgMemberRoute(), requireFeature("computers"), paramValidator(computerParamsSchema), jsonValidator(computerAccessSettingSchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const context = c.get("organizationContext")
    const result = await setMemberComputerAccess({ organizationId: context.organization.id, memberId: context.currentMember.id }, c.req.valid("param").computerId, c.req.valid("json"))
    if (result === "computer_not_found") return c.json({ error: result }, 404)
    if (typeof result === "string") return c.json({ error: result, message: conflicts[result] }, 409)
    return c.json({ computer: result })
  })

  app.post(`${base}/:computerId/authorize`, describeComputerRoute({
    tags: ["Devices"], operationId: "authorizeMemberComputer", "x-mcp": false,
    summary: "Check whether my OpenWork app can do work on a computer",
    description: "Checks the requested action on one of the caller's computers or a computer shared with the organization. Registered virtual computers require the owner's own OpenWork app and explicit permission to use the entire computer. The organization can turn access off. Personal computers don't take work yet. Both allowed and refused decisions return HTTP 200. Only an allowed action on a registered virtual computer includes its provider and provider id. Den never runs the action or supplies provider credentials. Requires active organization membership and Computers.",
    responses: {
      200: jsonResponse("The decision, computer and connection if available.", computerAuthorizeResponseSchema),
      400: invalid,
      401: unauthorized,
      404: notFound,
    },
  }), orgMemberRoute(), requireFeature("computers"), paramValidator(computerParamsSchema), jsonValidator(computerAuthorizeRequestSchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const context = c.get("organizationContext")
    const result = await authorizeMemberComputer({ organizationId: context.organization.id, memberId: context.currentMember.id }, c.req.valid("param").computerId, c.req.valid("json").action)
    return result ? c.json(result) : c.json({ error: "computer_not_found" }, 404)
  })
}
