import { isDenTypeId } from "@openwork-ee/utils/typeid"
import {
  computerAccessReportSchema,
  computerCommandClaimResponseSchema,
  computerCommandCompleteRequestSchema,
  computerCommandCompleteResponseSchema,
  computerCommandListResponseSchema,
  computerRunnerAccessResponseSchema,
} from "@openwork/types/den/computers"
import { Hono } from "hono"
import { z } from "zod"
import { claimComputerCommand, completeComputerCommand, pendingComputerCommands, readComputerAccess, replaceComputerAccess, runnerComputer } from "../../computers/store.js"
import { jsonValidator, paramValidator, queryValidator, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse } from "../../openapi.js"
import { signalComputerCommandUpdated } from "../../remote-sessions/work-signal.js"
import { runnerErrorSchema, runnerRoute } from "../session-runners/protocol.js"
import { authorizeComputerRunner, type ComputerRunnerEnv } from "./authorize.js"

const authorize = authorizeComputerRunner(true)
const listQuery = z.object({ waitMs: z.coerce.number().int().min(0).max(25_000).default(0) })
const idParamsSchema = z.object({ id: z.string().min(1).max(160) })
const accessResponseSchema = z.object({ ok: z.literal(true) })
const forbiddenResponse = jsonResponse("This computer cannot use the sandbox or has been disconnected.", runnerErrorSchema)
const notFoundResponse = jsonResponse("Computers is disabled or the computer or command was not found.", z.object({ error: z.string(), feature: z.literal("computers").optional() }))
const claimConflictResponse = jsonResponse("This computer can't pick up the command.", z.object({ error: z.enum(["command_conflict", "command_refused"]), message: z.string() }))
const completionConflictResponse = jsonResponse("This computer can't report that result for this command.", z.object({ error: z.literal("command_conflict"), message: z.string() }))

export function registerComputerRunnerRoutes<T extends { Variables: Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  const routes = new Hono<ComputerRunnerEnv>()
  routes.get("/v1/computer-runners/access", runnerRoute({
    summary: "Read this computer's access settings",
    description: "Shows whether the organization allows work, what this computer shares, and which sources have been revoked.",
    responses: { 200: jsonResponse("Computer access settings.", computerRunnerAccessResponseSchema), 403: forbiddenResponse, 404: notFoundResponse },
  }), authorize, async (c) => {
    const device = await runnerComputer(c.get("computerRunner"), true)
    return device ? c.json(await readComputerAccess(device), 200) : c.json({ error: "computer_not_found" }, 404)
  })

  routes.put("/v1/computer-runners/access", runnerRoute({
    summary: "Report which folders the owner chose to share",
    description: "Saves the owner’s sharing choices without clearing any revocations already recorded in Den.",
    responses: { 200: jsonResponse("Access saved.", accessResponseSchema), 400: jsonResponse("Invalid access report.", invalidRequestSchema), 403: forbiddenResponse, 404: notFoundResponse },
  }), authorize, jsonValidator(computerAccessReportSchema), async (c) => {
    const runner = c.get("computerRunner")
    const device = await runnerComputer(runner, true)
    if (!device) return c.json({ error: "computer_not_found" }, 404)
    const report = c.req.valid("json")
    if (report.grants.filter(({ source }) => source.kind === "workbot").length > 1) {
      return c.json({ error: "invalid_request", message: "Choose Workbot only once." }, 400)
    }
    if (!await replaceComputerAccess(device, runner.runnerId, report)) {
      return c.json({ error: "invalid_request", message: "Choose another desktop that you own in this organization." }, 400)
    }
    return c.json({ ok: true }, 200)
  })

  routes.get("/v1/computer-runners/commands", runnerRoute({
    summary: "List pending work for this computer",
    description: "Lists up to 20 commands still available to pick up, oldest first. If asked to wait, returns as soon as work arrives.",
    responses: { 200: jsonResponse("Pending commands.", computerCommandListResponseSchema), 400: jsonResponse("Invalid wait time.", invalidRequestSchema), 403: forbiddenResponse, 404: notFoundResponse },
  }), authorize, queryValidator(listQuery), async (c) => {
    const runner = c.get("computerRunner")
    const device = await runnerComputer(runner)
    const { waitMs } = c.req.valid("query")
    return c.json({ items: device ? await pendingComputerCommands(runner.organizationId, device.id, waitMs, c.req.raw.signal) : [] }, 200)
  })

  routes.post("/v1/computer-commands/:id/claim", runnerRoute({
    summary: "Pick up work and its list of shared folders",
    description: "Only the target computer can pick up a pending command. Den checks access again. The runner must run the assignment in its sandbox and mount only the folders in the assignment.",
    responses: { 200: jsonResponse("Command assignment.", computerCommandClaimResponseSchema), 403: forbiddenResponse, 404: notFoundResponse, 409: claimConflictResponse },
  }), authorize, paramValidator(idParamsSchema), async (c) => {
    const runner = c.get("computerRunner")
    const { id } = c.req.valid("param")
    const device = await runnerComputer(runner)
    if (!device || !isDenTypeId("computerCommand", id)) return c.json({ error: "command_not_found" }, 404)
    const result = await claimComputerCommand(runner, device, id)
    if (result === "command_not_found") return c.json({ error: result }, 404)
    if (result === "command_refused") {
      signalComputerCommandUpdated(id)
      return c.json({ error: result, message: "The current access settings don't allow this command." }, 409)
    }
    if (result === "command_conflict") return c.json({ error: result, message: "This computer can't pick up the command." }, 409)
    return c.json({ assignment: result }, 200)
  })

  routes.post("/v1/computer-commands/:id/complete", runnerRoute({
    summary: "Report the result of work on this computer",
    description: "Only the runner that picked up the command can report its result. It can do so after the deadline as long as Den still has the command. Repeating the same result is safe.",
    responses: { 200: jsonResponse("Completion acknowledged.", computerCommandCompleteResponseSchema), 400: jsonResponse("Invalid completion.", invalidRequestSchema), 403: forbiddenResponse, 404: notFoundResponse, 409: completionConflictResponse },
  }), authorize, paramValidator(idParamsSchema), jsonValidator(computerCommandCompleteRequestSchema), async (c) => {
    const runner = c.get("computerRunner")
    const { id } = c.req.valid("param")
    const device = await runnerComputer(runner)
    if (!device || !isDenTypeId("computerCommand", id)) return c.json({ error: "command_not_found" }, 404)
    const body = c.req.valid("json")
    if (body.status === "done" && (body.exitCode < -2147483648 || body.exitCode > 2147483647)) {
      return c.json({ error: "invalid_request", message: "The exit code is out of range." }, 400)
    }
    const result = await completeComputerCommand(runner, device, id, body)
    if (result === "command_not_found") return c.json({ error: result }, 404)
    if (result === "command_conflict") return c.json({ error: result, message: "This computer can't report that result for this command." }, 409)
    signalComputerCommandUpdated(id)
    return c.json({ command: { id, status: result } }, 200)
  })
  app.route("/", routes)
}
