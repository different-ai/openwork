import { and, eq, isNull } from "@openwork-ee/den-db/drizzle"
import { MemberTable } from "@openwork-ee/den-db/schema"
import { isDenTypeId, normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  COMPUTER_SHELL_RUNNER_CAPABILITY,
  computerAccessReportSchema,
  computerCommandClaimResponseSchema,
  computerCommandCompleteRequestSchema,
  computerCommandCompleteResponseSchema,
  computerCommandListResponseSchema,
} from "@openwork/types/den/computers"
import { Hono } from "hono"
import { createMiddleware } from "hono/factory"
import { z } from "zod"
import { automationRunnerRowId } from "../../automations/repository.js"
import { claimComputerCommand, completeComputerCommand, pendingComputerCommands, replaceComputerAccess, runnerComputer } from "../../computers/store.js"
import { db } from "../../db.js"
import { markFeaturesUsed } from "../../feature-usage.js"
import { organizationFeatureEnabled } from "../../features.js"
import { jsonValidator, paramValidator, type OrganizationContextVariables } from "../../middleware/index.js"
import { invalidRequestSchema, jsonResponse } from "../../openapi.js"
import { signalComputerCommandUpdated } from "../../remote-sessions/work-signal.js"
import { createRunnerProtocol, runnerErrorSchema, runnerRoute } from "../session-runners/protocol.js"

const { authenticateRunner, attributeRunner } = createRunnerProtocol()
const idParamsSchema = z.object({ id: z.string().min(1).max(160) })
const accessResponseSchema = z.object({ ok: z.literal(true) })
const forbiddenResponse = jsonResponse("This runner cannot use computer shell commands.", runnerErrorSchema)
const notFoundResponse = jsonResponse("Computers is disabled or the computer or command was not found.", z.object({ error: z.string(), feature: z.literal("computers").optional() }))
const claimConflictResponse = jsonResponse("This computer can't pick up the command.", z.object({ error: z.enum(["command_conflict", "command_refused"]), message: z.string() }))
const completionConflictResponse = jsonResponse("This computer can't report that result for this command.", z.object({ error: z.literal("command_conflict"), message: z.string() }))

type ComputerRunnerEnv = { Variables: { computerRunner: { organizationId: DenTypeId<"organization">; memberId: DenTypeId<"member">; runnerId: string } } }

const authorize = createMiddleware<ComputerRunnerEnv>(async (c, next) => {
  const identity = await authenticateRunner(c)
  if (!identity) return c.json({ error: "unauthorized" }, 401)
  attributeRunner(c, identity)
  const organizationId = normalizeDenTypeId("organization", identity.organizationId)
  const memberId = normalizeDenTypeId("member", identity.ownerMemberId)
  const [owner] = await db.$primary.select({ userId: MemberTable.userId }).from(MemberTable).where(and(
    eq(MemberTable.organizationId, organizationId), eq(MemberTable.id, memberId), isNull(MemberTable.removedAt),
  )).limit(1)
  if (!owner?.userId) return c.json({ error: "unauthorized" }, 401)
  if (!await organizationFeatureEnabled(organizationId, "computers", { userId: owner.userId })) {
    return c.json({ error: "feature_disabled", feature: "computers" }, 404)
  }
  if (!identity.capabilities.includes(COMPUTER_SHELL_RUNNER_CAPABILITY)) return c.json({ error: "runner_capability_required" }, 403)
  markFeaturesUsed({ organizationId, memberId, keys: ["computers"] })
  c.set("computerRunner", { organizationId, memberId, runnerId: automationRunnerRowId(identity) })
  await next()
})

export function registerComputerRunnerRoutes<T extends { Variables: Partial<OrganizationContextVariables> }>(app: Hono<T>) {
  const routes = new Hono<ComputerRunnerEnv>()
  routes.put("/v1/computer-runners/access", runnerRoute({
    summary: "Report which folders the owner chose to share",
    description: "Replaces the access choices reported by this runner. No shipping desktop reports these choices yet.",
    responses: { 200: jsonResponse("Access saved.", accessResponseSchema), 400: jsonResponse("Invalid access report.", invalidRequestSchema), 403: forbiddenResponse, 404: notFoundResponse },
  }), authorize, jsonValidator(computerAccessReportSchema), async (c) => {
    const runner = c.get("computerRunner")
    const device = await runnerComputer(runner, true)
    if (!device) return c.json({ error: "computer_not_found" }, 404)
    const report = c.req.valid("json")
    const exact = report.grants.flatMap(({ source }) => source.kind === "computer" ? [source.id] : [])
    if (exact.some((id) => !isDenTypeId("remoteDevice", id)) || new Set(exact).size !== exact.length || report.grants.length - exact.length > 1) {
      return c.json({ error: "invalid_request", message: "Choose different computers. You can also choose the owner's apps or Workbot once, but not both." }, 400)
    }
    await replaceComputerAccess(device, runner.runnerId, report)
    return c.json({ ok: true }, 200)
  })

  routes.get("/v1/computer-runners/commands", runnerRoute({
    summary: "List pending shell commands for this computer",
    description: "Lists up to 20 unexpired commands for the authenticated computer, oldest first.",
    responses: { 200: jsonResponse("Pending commands.", computerCommandListResponseSchema), 403: forbiddenResponse, 404: notFoundResponse },
  }), authorize, async (c) => {
    const runner = c.get("computerRunner")
    const device = await runnerComputer(runner)
    return c.json({ items: device ? await pendingComputerCommands(runner.organizationId, device.id) : [] }, 200)
  })

  routes.post("/v1/computer-commands/:id/claim", runnerRoute({
    summary: "Pick up a shell command and its list of shared folders",
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
    summary: "Complete a claimed computer shell command",
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
