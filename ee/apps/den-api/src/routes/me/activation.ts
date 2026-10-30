import { activationEventRequestSchema, activationStateSchema } from "@openwork/types/den/activation"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { readActivationState, recordActivationEvent } from "../../activation.js"
import { jsonValidator, orgMemberRoute, type OrganizationContextVariables } from "../../middleware/index.js"
import { listTeamsForMember } from "../../orgs.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

/** A checklist for the person's own screens; agents have no use for it. */
type ActivationRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeActivationRoute = (options: ActivationRouteOptions) => describeRoute(options)

export const activationResponseSchema = activationStateSchema.meta({ ref: "ActivationChecklist" })

export function registerMeActivationRoutes<T extends { Variables: AuthContextVariables & Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  app.get(
    "/v1/me/activation",
    describeActivationRoute({
      tags: ["Users"],
      operationId: "getMyActivation",
      "x-mcp": false,
      summary: "Get my Get set up checklist",
      description: "The six activation steps for the signed-in member in the active organization (first answer, invite a teammate, use a skill, set up a model provider, share a provider on AI Gateway, connect an app), each checked off only from what actually happened, with who can do a step the caller cannot.",
      responses: {
        200: jsonResponse("The member's checklist.", activationResponseSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Organization not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const organizationContext = c.get("organizationContext")
      if (!organizationContext) return c.json({ error: "organization_not_found" }, 404)
      const memberTeams = await listTeamsForMember({ organizationId: organizationContext.organization.id, memberId: organizationContext.currentMember.id })
      c.header("Cache-Control", "no-store")
      return c.json(await readActivationState({ organizationContext, memberTeams }))
    },
  )

  app.post(
    "/v1/me/activation/events",
    describeActivationRoute({
      tags: ["Users"],
      operationId: "recordMyActivationEvent",
      "x-mcp": false,
      summary: "Report a Get set up step this app observed",
      description: "Records a step only the client can see (its first answer, a provider key saved on the device, a local skill run) or that the member hid the checklist. Repeats are ignored. Returns the updated checklist.",
      responses: {
        200: jsonResponse("The updated checklist.", activationResponseSchema),
        400: jsonResponse("The event is not one a client may report.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
        404: jsonResponse("Organization not found.", notFoundSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(activationEventRequestSchema),
    async (c) => {
      const organizationContext = c.get("organizationContext")
      if (!organizationContext) return c.json({ error: "organization_not_found" }, 404)
      const organizationId = organizationContext.organization.id
      const memberId = organizationContext.currentMember.id
      await recordActivationEvent({ organizationId, memberId }, c.req.valid("json"), "app")
      const memberTeams = await listTeamsForMember({ organizationId, memberId })
      c.header("Cache-Control", "no-store")
      return c.json(await readActivationState({ organizationContext, memberTeams }))
    },
  )
}
