import { computerAuthorizeRequestSchema, computerAuthorizeResponseSchema, computerExecutionSchema, computerSourceCommandRequestSchema, computerSourceListResponseSchema } from "@openwork/types/den/computers"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { z } from "zod"
import { authorizeMemberComputer } from "../../computers/member.js"
import { followComputerCommand, listComputers, runComputerTool, type ComputerCaller } from "../../computers/service.js"
import { projectStoredComputer, runnerComputer } from "../../computers/store.js"
import { jsonValidator, paramValidator, queryValidator, type OrganizationContextVariables } from "../../middleware/index.js"
import { denTypeIdSchema, invalidRequestSchema, jsonResponse } from "../../openapi.js"
import { authorizeComputerRunner, type ComputerRunnerEnv } from "../computer-runners/authorize.js"
import { runnerRoute } from "../session-runners/protocol.js"

type SourceEnv = { Variables: ComputerRunnerEnv["Variables"] & { computerCaller: ComputerCaller } }
const authenticate = authorizeComputerRunner(false)
const identifySource = createMiddleware<SourceEnv>(async (c, next) => {
  const runner = c.get("computerRunner")
  const row = await runnerComputer(runner, true)
  if (!row) return c.json({ error: "computer_not_found" }, 404)
  c.set("computerCaller", { ...runner, source: { id: row.id, computer: projectStoredComputer(row) } })
  await next()
})

const computerParams = z.object({ computerId: denTypeIdSchema("remoteDevice") })
const commandParams = z.object({ id: z.string().min(1).max(160) })
const commandQuery = z.object({ waitMs: z.coerce.number().int().min(0).max(20_000).default(0) })
const invalid = jsonResponse("Invalid request.", invalidRequestSchema)
const notFound = jsonResponse("The computer or command was not found, or Computers is off.", z.object({ error: z.string(), feature: z.literal("computers").optional() }))

export function registerDesktopComputerSourceRoutes<T extends { Variables: Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  const routes = new Hono<SourceEnv>()
  routes.get("/v1/computer-sources/computers", runnerRoute({
    summary: "List computers reachable from this desktop",
    description: "Shows this desktop and which computers take work from it.",
    responses: { 200: jsonResponse("Computers and their reach.", computerSourceListResponseSchema), 404: notFound },
  }), authenticate, identifySource, async (c) => c.json(await listComputers(c.get("computerCaller")), 200))

  routes.post("/v1/computer-sources/computers/:computerId/authorize", runnerRoute({
    summary: "Check whether this desktop can do work on a computer",
    description: "Checks permission for this desktop. An allowed registered virtual computer includes the details needed to reach it directly.",
    responses: { 200: jsonResponse("The decision and the connection if available.", computerAuthorizeResponseSchema), 400: invalid, 404: notFound },
  }), authenticate, identifySource, paramValidator(computerParams), jsonValidator(computerAuthorizeRequestSchema), async (c) => {
    const caller = c.get("computerCaller")
    const result = await authorizeMemberComputer(caller, c.req.valid("param").computerId, c.req.valid("json").action, caller.source)
    return result ? c.json(result, 200) : c.json({ error: "computer_not_found" }, 404)
  })

  routes.post("/v1/computer-sources/computers/:computerId/commands", runnerRoute({
    summary: "Send work to a personal computer",
    description: "Checks the sharing settings for this desktop before sending work to a personal computer's sandbox. Waits for the result if asked to.",
    responses: { 200: jsonResponse("The status or result of the work.", computerExecutionSchema), 400: invalid, 404: notFound },
  }), authenticate, identifySource, paramValidator(computerParams), jsonValidator(computerSourceCommandRequestSchema), async (c) => {
    const { call, waitMs } = c.req.valid("json")
    const result = await runComputerTool(c.get("computerCaller"), c.req.valid("param").computerId, call, waitMs, c.req.raw.signal)
    return c.json("state" in result ? result : { state: "unsupported", message: result.message }, 200)
  })

  routes.get("/v1/computer-sources/commands/:id", runnerRoute({
    summary: "Read the result of work sent from this desktop",
    description: "Only this desktop can read the work it sent. Waits for the result if asked to.",
    responses: { 200: jsonResponse("The status or result of the work.", computerExecutionSchema), 400: invalid, 404: notFound },
  }), authenticate, identifySource, paramValidator(commandParams), queryValidator(commandQuery), async (c) => {
    const result = await followComputerCommand(c.get("computerCaller"), c.req.valid("param").id, c.req.valid("query").waitMs, c.req.raw.signal)
    return result ? c.json(result, 200) : c.json({ error: "command_not_found" }, 404)
  })
  app.route("/", routes)
}
