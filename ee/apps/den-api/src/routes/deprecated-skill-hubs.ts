import type { Context, Env, Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { publicRoute } from "../middleware/index.js"
import { jsonResponse } from "../openapi.js"

const deprecatedSkillHubMessage = "Skill hubs are deprecated. Use plugins instead."

const deprecatedSkillHubResponseSchema = z.object({
  error: z.literal("deprecated"),
  message: z.literal(deprecatedSkillHubMessage),
}).meta({ ref: "DeprecatedSkillHubError" })

const deprecatedSkillHubResponse = {
  error: "deprecated",
  message: deprecatedSkillHubMessage,
}

function deprecatedSkillHubRoute(summary: string) {
  return describeRoute({
    tags: ["Deprecated"],
    deprecated: true,
    summary,
    description: `${summary}. Skill hubs are deprecated; use plugins instead.`,
    responses: {
      410: jsonResponse("Skill hubs are deprecated. Use plugins instead.", deprecatedSkillHubResponseSchema),
    },
  })
}

function deprecatedSkillHubHandler(c: Context) {
  return c.json(deprecatedSkillHubResponse, 410)
}

export function registerDeprecatedSkillHubRoutes<T extends Env>(app: Hono<T>) {
  app.post(
    "/v1/skill-hubs",
    deprecatedSkillHubRoute("Create skill hub"),
    publicRoute,
    deprecatedSkillHubHandler,
  )

  app.get(
    "/v1/skill-hubs",
    deprecatedSkillHubRoute("List skill hubs"),
    publicRoute,
    deprecatedSkillHubHandler,
  )

  app.patch(
    "/v1/skill-hubs/:skillHubId",
    deprecatedSkillHubRoute("Update skill hub"),
    publicRoute,
    deprecatedSkillHubHandler,
  )

  app.delete(
    "/v1/skill-hubs/:skillHubId",
    deprecatedSkillHubRoute("Delete skill hub"),
    publicRoute,
    deprecatedSkillHubHandler,
  )

  app.post(
    "/v1/skill-hubs/:skillHubId/skills",
    deprecatedSkillHubRoute("Add skill to skill hub"),
    publicRoute,
    deprecatedSkillHubHandler,
  )

  app.delete(
    "/v1/skill-hubs/:skillHubId/skills/:skillId",
    deprecatedSkillHubRoute("Remove skill from skill hub"),
    publicRoute,
    deprecatedSkillHubHandler,
  )

  app.post(
    "/v1/skill-hubs/:skillHubId/access",
    deprecatedSkillHubRoute("Grant skill hub access"),
    publicRoute,
    deprecatedSkillHubHandler,
  )

  app.delete(
    "/v1/skill-hubs/:skillHubId/access/:accessId",
    deprecatedSkillHubRoute("Remove skill hub access"),
    publicRoute,
    deprecatedSkillHubHandler,
  )
}
