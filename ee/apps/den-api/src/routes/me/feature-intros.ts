import { featureIntroEventRequestSchema, featureIntroEventResponseSchema, featureIntroListResponseSchema } from "@openwork/types/den/feature-intros"
import type { Hono } from "hono"
import { describeRoute, type DescribeRouteOptions } from "hono-openapi"
import { listFeatureIntroStates, recordFeatureIntroEvent } from "../../feature-intros.js"
import { jsonValidator, orgMemberRoute, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, unauthorizedSchema } from "../../openapi.js"
import type { AuthContextVariables } from "../../session.js"

/** Intros for the person's own Den screens; agents have no use for them. */
type FeatureIntroRouteOptions = DescribeRouteOptions & { "x-mcp": false }
const describeFeatureIntroRoute = (options: FeatureIntroRouteOptions) => describeRoute(options)

const featureIntroListSchema = featureIntroListResponseSchema.meta({ ref: "FeatureIntroList" })
const featureIntroEventResultSchema = featureIntroEventResponseSchema.meta({ ref: "FeatureIntroEventResult" })

export function registerMeFeatureIntroRoutes<T extends { Variables: AuthContextVariables & Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  app.get(
    "/v1/me/feature-intros",
    describeFeatureIntroRoute({
      tags: ["Users"],
      operationId: "listMyFeatureIntros",
      "x-mcp": false,
      summary: "List my feature intro state",
      description: "Which Den page intros the signed-in member has seen, dismissed or acted on in the active organization, per intro key and version. Intros with no events are not listed.",
      responses: {
        200: jsonResponse("The member's intro state.", featureIntroListSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    async (c) => {
      const { organization, currentMember } = c.get("organizationContext")
      c.header("Cache-Control", "no-store")
      return c.json({ intros: await listFeatureIntroStates({ organizationId: organization.id, memberId: currentMember.id }) })
    },
  )

  app.post(
    "/v1/me/feature-intros/events",
    describeFeatureIntroRoute({
      tags: ["Users"],
      operationId: "recordMyFeatureIntroEvent",
      "x-mcp": false,
      summary: "Record that I saw, dismissed or acted on a feature intro",
      description: "Records one event for an intro: seen sets the first and last seen times, dismissed and cta_clicked set their times. A newer intro version than the stored one resets the times first; an older one changes nothing. Returns the intro's state.",
      responses: {
        200: jsonResponse("The intro's updated state.", featureIntroEventResultSchema),
        400: jsonResponse("The event was invalid.", invalidRequestSchema),
        401: jsonResponse("The caller must be signed in.", unauthorizedSchema),
      },
    }),
    orgMemberRoute(),
    jsonValidator(featureIntroEventRequestSchema),
    async (c) => {
      const { organization, currentMember } = c.get("organizationContext")
      const intro = await recordFeatureIntroEvent({ organizationId: organization.id, memberId: currentMember.id }, c.req.valid("json"))
      c.header("Cache-Control", "no-store")
      return c.json({ intro })
    },
  )
}
