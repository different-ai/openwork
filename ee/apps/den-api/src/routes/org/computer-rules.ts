import { eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable } from "@openwork-ee/den-db/schema"
import { ORGANIZATION_COMPUTER_RULES_KEY, organizationComputerRulesResponseSchema, organizationComputerRulesUpdateSchema, readOrganizationComputerRules } from "@openwork/types/den/computer-inventory"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { z } from "zod"
import { db } from "../../db.js"
import { requireFeature } from "../../features.js"
import { jsonValidator, orgMemberRoute, requireOrgPermission } from "../../middleware/index.js"
import { forbiddenSchema, invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import { updateOrganizationMetadata } from "../../organization-metadata.js"
import type { OrgRouteVariables } from "./shared.js"

const path = "/v1/org/computer-rules"
const describeRules = (options: DescribeRouteOptions & { "x-mcp": false }) => describeRoute(options)
const sandboxRequired = "OpenWork can't run arriving work outside the sandbox on personal computers yet, so this rule can't be turned off."
const responses = {
  200: jsonResponse("The computer rules.", organizationComputerRulesResponseSchema),
  401: jsonResponse("Sign in required.", unauthorizedSchema),
  404: jsonResponse("The organization was not found, or Computers is off.", notFoundSchema),
}

export function registerOrgComputerRulesRoutes<T extends { Variables: OrgRouteVariables }>(app: Hono<T>) {
  app.get(path, describeRules({
    tags: ["Organizations"], operationId: "getOrganizationComputerRules", "x-mcp": false,
    summary: "Get the organization's computer rules",
    description: "Shows what the organization allows for tasks and for running code on another computer. Active members may read these rules when Computers is on.",
    responses,
  }), orgMemberRoute(), requireFeature("computers"), async (c) => {
    c.header("Cache-Control", "no-store")
    const { organization } = c.get("organizationContext")
    const [current] = await db.$primary.select({ metadata: OrganizationTable.metadata }).from(OrganizationTable).where(eq(OrganizationTable.id, organization.id)).limit(1)
    return c.json(readOrganizationComputerRules(current?.metadata))
  })

  app.patch(path, describeRules({
    tags: ["Organizations"], operationId: "updateOrganizationComputerRules", "x-mcp": false,
    summary: "Update the organization's computer rules",
    description: "Changes whether work from another computer may run code. Set runCode to null to follow the remote-tasks setting again. Does not change remote tasks or sessions. The sandbox requirement for personal computers cannot be turned off. Requires Edit organization settings.",
    responses: {
      ...responses,
      400: jsonResponse("The request was invalid.", invalidRequestSchema),
      403: jsonResponse("Edit organization settings permission required.", forbiddenSchema),
      409: jsonResponse(sandboxRequired, z.object({ error: z.literal("sandbox_required"), message: z.string() })),
    },
  }), orgMemberRoute(), requireFeature("computers"), requireOrgPermission("organization.update"), jsonValidator(organizationComputerRulesUpdateSchema), async (c) => {
    c.header("Cache-Control", "no-store")
    const update = c.req.valid("json")
    if (update.requireSandboxOnPersonal === false) return c.json({ error: "sandbox_required", message: sandboxRequired }, 409)
    const { organization } = c.get("organizationContext")
    const metadata = await updateOrganizationMetadata(organization.id, (current) => {
      const { rules, runCodeChosen } = readOrganizationComputerRules(current)
      const runCode = update.runCode === undefined ? (runCodeChosen ? rules.runCode : undefined) : update.runCode ?? undefined
      return { ...current, [ORGANIZATION_COMPUTER_RULES_KEY]: {
        ...(runCode === undefined ? {} : { runCode }), requireSandboxOnPersonal: update.requireSandboxOnPersonal ?? rules.requireSandboxOnPersonal,
      } }
    })
    return c.json(readOrganizationComputerRules(metadata))
  })
}
