import type { Hono, MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"
import { personalAgentChatTurnResponseSchema, personalAgentStandingChatSchema, sendPersonalAgentChatMessageSchema } from "@openwork/types/den/personal-agents"
import { jsonValidator, orgMemberRoute, paramValidator, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse, notFoundSchema } from "../../openapi.js"
import { personalAgentAccess } from "../../personal-agents/access.js"
import { listStandingChat, sendStandingChat } from "../../personal-agents/standing-chat.js"
import { personalAgentCaller } from "./sharing.js"

const path = "/v1/personal-agents/:id/standing-chat"
const params = z.object({ id: z.string().min(1).max(160) })
const notFound = { error: "personal_agent_not_found" }
type RouteContext = { Variables: Partial<OrganizationContextVariables> }

export function registerPersonalAgentStandingChatRoutes<T extends RouteContext>(app: Hono<T>, gate: MiddlewareHandler<RouteContext>) {
  app.get(path, describeRoute({ tags: ["Agents"], operationId: "getPersonalAgentStandingChat", summary: "Read your private chat with an agent",
    description: "Returns up to 100 of the signed-in member's most recent turns for this agent in chronological order.",
    responses: { 200: jsonResponse("Latest turns, in chronological order.", personalAgentStandingChatSchema), 404: jsonResponse("Not found.", notFoundSchema) },
  }), orgMemberRoute(), gate, paramValidator(params), async (c) => {
    const actor = { ...personalAgentCaller(c), userId: c.get("organizationContext").currentMember.userId }
    const agent = await personalAgentAccess(actor, c.req.valid("param").id, true)
    if (!agent || agent.state !== "active") return c.json(notFound, 404)
    return c.json(await listStandingChat(actor, agent))
  })

  app.post(path, describeRoute({ tags: ["Agents"], operationId: "sendPersonalAgentStandingChatMessage", summary: "Send a message in your private chat with an agent",
    description: "Starts a turn in the signed-in member's chat with the agent, or returns the existing turn for the same message key.",
    responses: {
      202: jsonResponse("Turn accepted or returned from an earlier request.", personalAgentChatTurnResponseSchema),
      400: jsonResponse("Invalid message.", invalidRequestSchema),
      404: jsonResponse("Not found.", notFoundSchema),
      409: jsonResponse("Agent unavailable, chat busy, or message key already used.", notFoundSchema),
    },
  }), orgMemberRoute(), gate, paramValidator(params), jsonValidator(sendPersonalAgentChatMessageSchema), async (c) => {
    const actor = { ...personalAgentCaller(c), userId: c.get("organizationContext").currentMember.userId }
    const agent = await personalAgentAccess(actor, c.req.valid("param").id, true)
    if (!agent || agent.state !== "active") return c.json(notFound, 404)
    const result = await sendStandingChat(actor, agent, c.req.valid("json"))
    return result.turn ? c.json({ turn: result.turn }, 202) : c.json({ error: result.error }, 409)
  })
}
