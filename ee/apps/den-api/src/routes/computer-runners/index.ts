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
import { createRunnerProtocol, runnerConflictResponse, runnerErrorSchema, runnerRoute } from "../session-runners/protocol.js"

const { authenticateRunner, attributeRunner } = createRunnerProtocol()
const idParamsSchema = z.object({ id: z.string().min(1).max(160) })
const accessResponseSchema = z.object({ ok: z.literal(true) })
const forbiddenResponse = jsonResponse("This runner cannot use computer shell commands.", runnerErrorSchema)
const notFoundResponse = jsonResponse("Computers is disabled or the computer or command was not found.", z.object({ error: z.string(), feature: z.literal("computers").optional() }))

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
    summary: "Report the access and shared folders on this computer",
    description: "Replaces the owner choice and all grants for the authenticated runner's computer.",
    responses: { 200: jsonResponse("Access saved.", accessResponseSchema), 400: jsonResponse("Invalid access report.", invalidRequestSchema), 403: forbiddenResponse, 404: notFoundResponse },
  }), authorize, jsonValidator(computerAccessReportSchema), async (c) => {
    const runner = c.get("computerRunner")
    const device = await runnerComputer(runner, true)
    if (!device) return c.json({ error: "computer_not_found" }, 404)
    const report = c.req.valid("json")
    const exact = report.grants.flatMap(({ source }) => source.kind === "computer" ? [source.id] : [])
    if (exact.some((id) => !isDenTypeId("remoteDevice", id)) || new Set(exact).size !== exact.length || report.grants.length - exact.length > 1) {
      return c.json({ error: "invalid_request", message: "Each grant must name a different computer or Workbot." }, 400)
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
    summary: "Claim a shell command with its current folder grant",
    description: "Only the target computer can claim a pending shell command. The policy is checked again before issuing an assignment.",
    responses: { 200: jsonResponse("Command assignment.", computerCommandClaimResponseSchema), 403: forbiddenResponse, 404: notFoundResponse, 409: runnerConflictResponse },
  }), authorize, paramValidator(idParamsSchema), async (c) => {
    const runner = c.get("computerRunner")
    const { id } = c.req.valid("param")
    const device = await runnerComputer(runner)
    if (!device || !isDenTypeId("computerCommand", id)) return c.json({ error: "command_not_found" }, 404)
    const result = await claimComputerCommand(runner, device, id)
    if (result === "command_not_found") return c.json({ error: result }, 404)
    if (result === "command_refused") signalComputerCommandUpdated(id)
    if (typeof result === "string") return c.json({ error: result }, 409)
    return c.json({ assignment: result }, 200)
  })

  routes.post("/v1/computer-commands/:id/complete", runnerRoute({
    summary: "Complete a claimed computer shell command",
    description: "Only the claiming computer can complete the command. Repeating the same completion is safe.",
    responses: { 200: jsonResponse("Completion acknowledged.", computerCommandCompleteResponseSchema), 400: jsonResponse("Invalid completion.", invalidRequestSchema), 403: forbiddenResponse, 404: notFoundResponse, 409: runnerConflictResponse },
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
    if (result === "command_conflict") return c.json({ error: result }, 409)
    signalComputerCommandUpdated(id)
    return c.json({ command: { id, status: result } }, 200)
  })
  app.route("/", routes)
}
