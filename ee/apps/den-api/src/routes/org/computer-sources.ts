import { computerSourceAccessSchema } from "@openwork/types/den/computer-inventory"
import { COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY } from "@openwork/types/den/computers"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { addAuditRequestResource } from "../../audit/request-capture.js"
import { updateInventoryComputerSource } from "../../computers/inventory-store.js"
import { requireFeature } from "../../features.js"
import { orgMemberRoute, paramValidator, requireOrgPermission } from "../../middleware/index.js"
import { denTypeIdSchema, forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { OrgRouteVariables } from "./shared.js"

const memberPath = "/v1/computers/:computerId/sources/:sourceKey"
const organizationPath = "/v1/org/computers/:computerId/sources/:sourceKey"
const params = z.object({
  computerId: denTypeIdSchema("remoteDevice"),
  sourceKey: z.union([z.enum(["workbot", "owner", COMPUTER_OWNER_WHOLE_VM_SOURCE_KEY]), denTypeIdSchema("remoteDevice")]),
})
const describeSource = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)
const responses = {
  200: jsonResponse("The source and its updated access.", z.object({ source: computerSourceAccessSchema })),
  400: jsonResponse("Invalid computer or source.", invalidRequestSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  404: jsonResponse("The computer or source was not found, or Computers is off.", notFoundSchema),
}
const notFound = { error: "not_found", message: "Computer or source not found." }

export function registerComputerSourceRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.delete(memberPath, describeSource({
    tags: ["Devices"], operationId: "revokeMemberComputerSource", "x-mcp": false,
    summary: "Revoke a source on my computer",
    description: "Stops one source from running work on a computer the caller owns, including every sign-in grouped under that computer. Does not change remote tasks or sessions.",
    responses,
  }), orgMemberRoute(), requireFeature("computers"), paramValidator(params), async (c) => {
    c.header("Cache-Control", "no-store")
    const { organization, currentMember } = c.get("organizationContext")
    const { computerId, sourceKey } = c.req.valid("param")
    const result = await updateInventoryComputerSource({ kind: "member", actor: { organizationId: organization.id, memberId: currentMember.id } }, computerId, sourceKey, "revoke")
    if (!result) return c.json(notFound, 404)
    for (const id of result.grantIds) addAuditRequestResource(c, { type: "computer_grant", id })
    return c.json({ source: result.source })
  })

  app.post(`${memberPath}/restore`, describeSource({
    tags: ["Devices"], operationId: "restoreMemberComputerSource", "x-mcp": false,
    summary: "Restore a source on my computer",
    description: "Lets the computer owner restore a source's saved access on every sign-in grouped under that computer. The organization and each sign-in's own choices still apply.",
    responses,
  }), orgMemberRoute(), requireFeature("computers"), paramValidator(params), async (c) => {
    c.header("Cache-Control", "no-store")
    const { organization, currentMember } = c.get("organizationContext")
    const { computerId, sourceKey } = c.req.valid("param")
    const result = await updateInventoryComputerSource({ kind: "member", actor: { organizationId: organization.id, memberId: currentMember.id } }, computerId, sourceKey, "restore")
    if (!result) return c.json(notFound, 404)
    for (const id of result.grantIds) addAuditRequestResource(c, { type: "computer_grant", id })
    return c.json({ source: result.source })
  })

  app.delete(organizationPath, describeSource({
    tags: ["Devices"], operationId: "revokeOrganizationComputerSource", "x-mcp": false,
    summary: "Revoke a source on a team computer",
    description: "Stops one source from running work on a computer in the organization, including every sign-in grouped under that computer. Only the computer owner can restore access. Requires Disconnect team computers and a recent sign-in.",
    responses: { ...responses, 403: jsonResponse("Disconnect team computers permission and a recent sign-in required.", forbiddenSchema) },
  }), orgMemberRoute(), requireFeature("computers"), requireOrgPermission("computers.disconnect"), paramValidator(params), async (c) => {
    c.header("Cache-Control", "no-store")
    const { organization, currentMember } = c.get("organizationContext")
    const { computerId, sourceKey } = c.req.valid("param")
    const result = await updateInventoryComputerSource({ kind: "organization", actor: { organizationId: organization.id, memberId: currentMember.id } }, computerId, sourceKey, "revoke")
    if (!result) return c.json(notFound, 404)
    for (const id of result.grantIds) addAuditRequestResource(c, { type: "computer_grant", id })
    addAuditRequestResource(c, { type: "member", id: result.ownerMemberId })
    return c.json({ source: result.source })
  })
}
