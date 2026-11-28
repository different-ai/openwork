import { createHeadlessRunnerClient, type RunnerDesktopView, type RunnerLiveEvent } from "@openwork-ee/headless-protocol"
import {
  createWorkbot,
  createWorkbotSessionWrites,
  toWorkbotPageEvent,
  workbotOwner,
  WORKBOT_CHAT_ID,
  WorkbotFilesUnavailableError,
  WorkbotUnavailableError,
  WorkbotRemoteJobError,
  type WorkbotActor,
  type WorkbotChat,
  type WorkbotConnectors,
  type WorkbotEventsUnavailable,
} from "@openwork-ee/workbot-server"
import type { Context, Hono, MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { streamSSE } from "hono/streaming"
import { z } from "zod"
import { browserTeachingPrompt, compileBrowserDemonstration, demonstrationCommandSchema } from "@openwork/types/browser-demonstration"
import { workbotContextPrompt, workbotViewContextSchema, WORKBOT_MAX_MESSAGE_CHARS, type WorkbotViewContext } from "@openwork/types/workbot-context"
import { activationEventRequestSchema } from "@openwork/types/den/activation"
import { mcpAppIdSchema } from "@openwork/types/mcp-app"
import type { AppEnv, Member } from "./auth.js"
import type { Config } from "./config.js"
import { DenAppError, workbotApprovalPath, type Den } from "./den.js"
import { cloudCodingPushApprovalListSchema, cloudCodingPushApprovalSchema, cloudCodingPushDecisionInputSchema } from "@openwork/types/den/cloud-coding"

const approvalErrorSchema = z.object({ error: z.string(), message: z.string().optional(), feature: z.literal("cloudCoding").optional() })

function approvalResponse(result: { status: number; payload: unknown }, schema: z.ZodType) {
  const headers = { "Cache-Control": "no-store" }
  if (result.status === 200) {
    const parsed = schema.safeParse(result.payload)
    if (parsed.success) return Response.json(parsed.data, { headers })
  } else if (result.status === 403 || result.status === 404 || result.status === 409) {
    const parsed = approvalErrorSchema.safeParse(result.payload)
    if (parsed.success) return Response.json(parsed.data, { status: result.status, headers })
  }
  return Response.json({ error: "approval_unavailable", message: "Workbot couldn’t reach the push approvals. Try again." }, { status: 502, headers })
}
import { COMPUTER_ACTION_EVENTS, createComputerReporter } from "./device-reports.js"
import { observedRunnerFetch, reportError } from "./error-reporting.js"

const fileIdSchema = z.string().regex(/^fl_[a-f0-9]{32}$/)
const MAX_MESSAGE_CHARS = WORKBOT_MAX_MESSAGE_CHARS
const sendSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    text: z.string().trim().max(MAX_MESSAGE_CHARS),
    timeZone: z.string().max(64).optional(),
    attachments: z.array(fileIdSchema).max(20).optional(),
    context: workbotViewContextSchema.optional(),
    teachingId: z.string().uuid().optional(),
    teachingStepId: z.number().int().positive().optional(),
  })
  .strict()
  .refine(value => value.teachingStepId === undefined || value.teachingId !== undefined, "Choose a demonstration before explaining a step.")
const editSchema = z
  .object({
    newId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    text: z.string().trim().max(MAX_MESSAGE_CHARS),
    timeZone: z.string().max(64).optional(),
    attachments: z.array(fileIdSchema).max(20).optional(),
    context: workbotViewContextSchema.optional(),
  })
  .strict()
const messageTooLong = { error: "message_too_long", message: "That's too long for one message. Send it as a file instead." } as const
const tooLong = (error: z.ZodError) => error.issues.some((issue) => issue.path[0] === "text" && issue.code === "too_big")
const uploadQuerySchema = z.object({ name: z.string().trim().min(1).max(255), timeZone: z.string().max(64).optional() })
const threadQuerySchema = z.object({ turns: z.coerce.number().int().min(1).max(200).optional() })
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])
const EVENTS_MAX_MS = 170_000
const KEEP_ALIVE_MS = 15_000
const SOCKET_MIN_MS = 10_000
const SOCKET_REST_MS = 60_000
const SOCKET_REST_MAX = 10_000
const EVENTS_RETRY_AFTER_S = 5
const EVENTS_UNAVAILABLE_LOG_MS = 60_000
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
const MESSAGES_PER_WINDOW = 30
const MESSAGE_WINDOW_MS = 10 * 60_000
const RUN_TOKEN_TTL_MS = 60 * 60_000

function sharesContext(den: Pick<Member["den"], "browser" | "workspaceAssistant" | "calendar" | "documents">, context: WorkbotViewContext) {
  if (context.kind === "browser") return den.browser
  return den.workspaceAssistant && (context.kind === "calendar" ? den.calendar === true : den.documents === true)
}

function desktopViewsOf(den: Pick<Member["den"], "browser" | "computer">): RunnerDesktopView[] {
  return [...(den.browser ? ["browser" as const] : []), ...(den.computer ? ["computer" as const] : [])]
}

function actorOf(member: Member): WorkbotActor {
  const { den } = member
  const firstName = den.user.name?.trim().split(/\s+/)[0] ?? null
  return {
    organizationId: den.organization.id,
    organizationName: den.organization.name,
    organizationMetadata: den.organization.brandAppName ? { brandAppName: den.organization.brandAppName } : {},
    memberId: den.memberId,
    userId: den.user.id,
    firstName: firstName || null,
  }
}

const CONNECTORS_TTL_MS = 5 * 60_000
const CONNECTORS_RETRY_MS = 30_000
const CONNECTORS_KEPT = 2_000

export function createConnectorCache(read: (accessToken: string) => Promise<Array<{ id: string; name: string; site: string | null }>>, now = () => Date.now()) {
  const kept = new Map<string, { at: number; ttl: number; value: Promise<WorkbotConnectors> }>()
  return (key: string, accessToken: string): Promise<WorkbotConnectors> => {
    const entry = kept.get(key)
    if (entry && now() - entry.at < entry.ttl) return entry.value
    const value = read(accessToken).then(
      (list) => new Map(list.map((connector) => [connector.id, { name: connector.name, site: connector.site }])),
      () => {
        const failed = kept.get(key)
        if (failed) failed.ttl = CONNECTORS_RETRY_MS
        return new Map()
      },
    )
    kept.delete(key)
    kept.set(key, { at: now(), ttl: CONNECTORS_TTL_MS, value })
    if (kept.size > CONNECTORS_KEPT) kept.delete(kept.keys().next().value ?? "")
    return value
  }
}

export function workbotConnectionUrl(denWeb: string, organizationId: string, connectionId: string) {
  return `${denWeb}/dashboard/your-connections?${new URLSearchParams({ connectionId, workbotOrganizationId: organizationId })}`
}

export function registerWorkbotRoutes(app: Hono<AppEnv>, input: { config: Config; den: Den; member: MiddlewareHandler<AppEnv>; sameOrigin: MiddlewareHandler }) {
  const { config, den } = input
  const sent = new Map<string, number[]>()
  const connectors = createConnectorCache((accessToken) => den.connectors(accessToken))
  const runnerFetch = observedRunnerFetch()
  const sessionWrites = createWorkbotSessionWrites()

  const runnerFor = (member: Member) => ({ ...config.runner, owner: workbotOwner(member.den.organization.id, member.den.memberId) })

  const runnerClientFor = (member: Member) =>
    createHeadlessRunnerClient({
      config: runnerFor(member),
      fetch: runnerFetch,
      modelAccessRequired: () => member.den.gatewayModels,
      mintToken: ({ readOnly, sessionId, messageId, model, modelAccessRequired }) => den.runToken(member.accessToken, { readOnly, sessionId, messageId, model, modelAccessRequired, gatewayModels: member.den.gatewayModels }),
      maxTokenTtlMs: RUN_TOKEN_TTL_MS,
    })

  const workbotFor = (member: Member, desktopViews = desktopViewsOf(member.den)) =>
    createWorkbot({
      client: runnerClientFor(member),
      remoteStatus: input => den.remoteStatus(member.accessToken, input),
      remoteRead: input => den.remoteRead(member.accessToken, input),
      remoteStop: input => den.remoteStop(member.accessToken, input),
      desktopViews,
      canSchedule: async () => member.den.canSchedule,
      model: async () => member.den.model,
      verifyModel: !member.den.gatewayModels && member.den.verifyModel,
      workspaceAssistant: async () => member.den.workspaceAssistant,
      guidedNavigation: async () => member.den.guidedNavigation && member.den.documents === true,
      teachingNavigation: async () => member.den.browser === true && member.den.browserDemonstrations === true,
      connectors: () => connectors(`${member.den.organization.id}:${member.den.memberId}`, member.accessToken),
      browserRecovery: member.den.browserRecovery,
      stepTurns: member.den.stepTurns,
      sessionCells: member.den.sessionCells,
      sessionWrites,
    })

  const enabled = (c: Context<AppEnv>) => c.get("member").den.enabled
  const chatOf = (c: Context<AppEnv>): { chat: WorkbotChat; refused?: undefined } | { refused: Response } => {
    const raw = c.req.query("chat")
    if (!raw) return { chat: null }
    if (!c.get("member").den.sideChats) return { refused: c.json({ error: "feature_disabled" }, 404) }
    if (!WORKBOT_CHAT_ID.test(raw)) return { refused: c.json({ error: "invalid_request" }, 400) }
    return { chat: raw }
  }
  const rateLimited = (memberId: string) => {
    const now = Date.now()
    const recent = (sent.get(memberId) ?? []).filter((at) => now - at < MESSAGE_WINDOW_MS)
    if (recent.length >= MESSAGES_PER_WINDOW) {
      sent.set(memberId, recent)
      return Math.ceil(((recent[0] ?? now) + MESSAGE_WINDOW_MS - now) / 1000)
    }
    sent.set(memberId, [...recent, now])
    return null
  }

  const phoneAllowed: MiddlewareHandler<AppEnv> = async (c, next) => {
    const member = c.get("member")
    if (member.app && !member.den.mobile && c.req.path !== "/v1/workbot/me") return c.json({ error: "workbot_mobile_not_enabled" }, 403)
    await next()
  }

  app.use("/v1/workbot/*", input.sameOrigin, input.member, phoneAllowed)
  app.use("/v1/workbot", input.sameOrigin, input.member, phoneAllowed)

  app.get(workbotApprovalPath, async c => {
    const member = c.get("member")
    return approvalResponse(await den.cloudCodingApprovals(member.accessToken), cloudCodingPushApprovalListSchema)
  })
  app.get(`${workbotApprovalPath}/:id`, async c => {
    const member = c.get("member")
    return approvalResponse(await den.cloudCodingApproval(member.accessToken, c.req.param("id")), cloudCodingPushApprovalSchema)
  })
  app.post(`${workbotApprovalPath}/:id/decision`, bodyLimit({ maxSize: 1024 }), async c => {
    c.header("Cache-Control", "no-store")
    const member = c.get("member")
    const body = cloudCodingPushDecisionInputSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ error: "invalid_request" }, 400)
    return approvalResponse(await den.decideCloudCodingApproval(member.accessToken, c.req.param("id"), body.data), cloudCodingPushApprovalSchema)
  })
  const teachingSaves = new Map<string, { markdown: string; name: string; saving: ReturnType<Den["saveBrowserSkill"]> }>()
  app.post("/v1/workbot/teaching", bodyLimit({ maxSize: 8192 }), async c => {
    c.header("Cache-Control", "no-store")
    const member = c.get("member")
    const allowed = async () => {
      const fresh = await den.session(member.accessToken)
      return fresh.enabled && fresh.browser && fresh.browserDemonstrations && fresh.user.id === member.den.user.id
        && fresh.organization.id === member.den.organization.id && fresh.memberId === member.den.memberId
    }
    if (!member.den.enabled || !member.den.browser || !member.den.browserDemonstrations || !await allowed()) return c.json({ error: "feature_disabled" }, 403)
    const raw: unknown = await c.req.json().catch(() => null)
    const save = z.object({ action: z.literal("save"), demonstrationId: z.string().uuid(), name: z.string().trim().min(1).max(100), purpose: z.string().trim().min(1).max(1000), skillId: z.string().trim().min(1).max(160).optional() }).strict().safeParse(raw)
    const command = demonstrationCommandSchema.safeParse(raw)
    if (!save.success && !command.success) return c.json({ error: "invalid_request" }, 400)
    try {
      const workbot = workbotFor(member)
      const client = runnerClientFor(member)
      const sessionId = await workbot.sessionIdOf(actorOf(member))
      if (!await allowed()) return c.json({ error: "feature_disabled" }, 403)
      if (save.success) {
        const state = await client.browserDemonstration(sessionId, { action: "read" })
        if (!state.ok || state.value.demonstration?.id !== save.data.demonstrationId) return c.json({ error: "demonstration_unavailable" }, 409)
        const markdown = compileBrowserDemonstration(state.value.demonstration, save.data.name, save.data.purpose)
        if (!await allowed()) return c.json({ error: "feature_disabled" }, 403)
        const key = JSON.stringify([member.den.organization.id, member.den.memberId, save.data.demonstrationId, ...(save.data.skillId ? [save.data.skillId, markdown] : [])])
        let receipt = teachingSaves.get(key)
        if (receipt && (receipt.markdown !== markdown || receipt.name !== save.data.name)) return c.json({ error: "already_saved", message: "This demonstration already has a save attempt. Check the saved skill before making another version." }, 409)
        if (!receipt) {
          if (teachingSaves.size >= 1000) return c.json({ error: "save_capacity", message: "Skill saving is busy. Keep your draft and try again later." }, 503)
          receipt = { markdown, name: save.data.name, saving: den.saveBrowserSkill(member.accessToken, save.data.name, markdown, save.data.skillId) }
          teachingSaves.set(key, receipt)
        }
        const saved = await receipt.saving
        if (!await allowed()) return c.json({ error: "feature_disabled" }, 403)
        return c.json({ saved, markdown })
      }
      if (!command.success) return c.json({ error: "invalid_request" }, 400)
      if (command.data.action === "start" || command.data.action === "resume") await workbot.stop(actorOf(member))
      const result = await client.browserDemonstration(sessionId, command.data)
      if (!await allowed()) return c.json({ error: "feature_disabled" }, 403)
      return result.ok ? c.json(result.value) : c.json({ error: "teaching_unavailable", message: "Teaching is unavailable. Reconnect the browser or ask an operator to update its desktop snapshot." }, 409)
    } catch { return c.json({ error: "teaching_unavailable", message: save.success ? "Couldn't confirm the skill was saved. Check your skill library before trying another save." : "Couldn't update the demonstration. Reconnect and check its current state." }, 409) }
  })

  app.get("/v1/workbot/me", async (c) => {
    const member = c.get("member")
    const { den: who } = member
    if (who.enabled) {
      try { workbotFor(member).warm(actorOf(member)) } catch {}
    }
    return c.json({
      userId: who.user.id,
      organizationId: who.organization.id,
      name: who.user.name,
      email: who.user.email,
      organizationName: who.organization.name,
      enabled: who.enabled,
      calendar: who.enabled && who.calendar === true,
      documents: who.enabled && who.documents === true,
      computer: who.enabled && who.computer,
      browser: who.enabled && who.browser,
      browserDemonstrations: who.enabled && who.browser && who.browserDemonstrations,
      browserLiveView: who.enabled && who.browser,
      nativeDictation: who.enabled,
      workspaceAssistant: who.enabled && who.workspaceAssistant,
      guidedNavigation: who.enabled && who.workspaceAssistant && who.guidedNavigation,
      usageRecovery: who.enabled,
      activationChecklist: who.enabled,
      canSchedule: who.enabled && who.canSchedule,
      sideChats: who.enabled && who.sideChats,
      accountMenu: true,
      workingStatus: who.enabled,
      quickReply: who.enabled,
      browserChat: who.enabled && who.browser,
      instantOpen: who.enabled,
      profileSheet: who.enabled,
      centeredProfile: who.enabled,
      browserPreview: who.enabled && (who.browser || who.computer),
      remoteTasks: who.enabled,
      profileNav: who.enabled,
      quietCalendar: who.enabled && who.calendar === true,
      scrollToBottom: who.enabled,
      profileComputers: who.enabled,
      deviceActivity: who.enabled,
      calmChat: who.enabled && who.calmChat,
      devices: who.enabled,
      commandPalette: true,
      mobile: who.enabled && who.mobile,
      denUrl: config.denWebUrl ?? (await den.webUrl().catch(() => null)),
    })
  })

  const desktopFailure = (c: Context<AppEnv>, operation: string, code: string, rebuilt = false) => {
    console.error("[workbot] desktop unavailable", { operation, code, rebuilt })
    if (code === "desktop_outdated") return c.json({ error: code, message: rebuilt ? "Your computer still needs an update after rebuilding. Ask your workspace admin for help." : "Your computer needs an update before it can connect. Rebuild it, or ask your workspace admin if that doesn't help." }, 409)
    if (code === "desktop_updating") return c.json({ error: code, message: "Your computer is updating. It will be ready when its current work finishes." }, 409)
    if (code === "desktop_replacing") return c.json({ error: code, message: "Your computer's desktop didn't start, so it is being replaced. This usually takes about a minute." }, 409)
    return c.json({ error: "desktop_unavailable", message: "Your computer is unavailable. Try reconnecting." }, 409)
  }
  const autoRebuilds = new Map<string, Promise<{ ok: boolean; error: string }>>()

  app.post("/v1/workbot/computer/:operation", async (c) => {
    const member = c.get("member")
    c.header("Cache-Control", "no-store")
    if (!member.den.enabled || !desktopViewsOf(member.den).length) return c.json({ error: "feature_disabled" }, 403)
    const operation = c.req.param("operation")
    if (operation !== "viewer" && operation !== "action") return c.json({ error: "not_found" }, 404)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const raw: unknown = await c.req.json().catch(() => null)
    const viewer = z.object({ view: z.enum(["browser", "computer"]), control: z.boolean().default(false), wake: z.boolean().default(false) }).strict().safeParse(raw)
    const action = z.object({ action: z.enum(["continue", "pause", "resume", "rebuild"]) }).strict().safeParse(raw)
    if (operation === "viewer" ? !viewer.success : !action.success) return c.json({ error: "invalid_request" }, 400)
    const requestedView = viewer.success ? viewer.data.view : null
    const client = runnerClientFor(member)
    let devices: boolean = member.den.enabled
    const report = createComputerReporter({ enabled: () => devices, send: body => den.reportComputer(member.accessToken, body) })
    let computer: { sessionId: string; chat: WorkbotChat } | null = null
    const failed = (code: string, rebuilt = false) => {
      if (computer && code !== "desktop_replacing") report(computer, { event: "failed", code })
      return desktopFailure(c, operation, code, rebuilt)
    }
    const allowedViews = async () => {
      const fresh = await den.session(member.accessToken)
      const views = desktopViewsOf(fresh)
      const allowed = fresh.enabled && (requestedView ? views.includes(requestedView) : views.length > 0) && fresh.organization.id === member.den.organization.id && fresh.memberId === member.den.memberId
      devices = allowed
      return allowed ? views : null
    }
    try {
      const views = await allowedViews()
      if (!views) return c.json({ error: "feature_disabled" }, 403)
      const workbot = workbotFor(member, views)
      let sessionId = await workbot.sessionIdOf(actorOf(member), scope.chat)
      computer = { sessionId, chat: scope.chat }
      const existing = await client.readSession(sessionId, { turns: 1, limit: 1, outputs: "none" })
      if (!existing.ok && existing.status === 404) {
        sessionId = await workbot.ensureComputer(actorOf(member), scope.chat)
        computer = { sessionId, chat: scope.chat }
      } else {
        if (!existing.ok) return failed(existing.error)
        const updated = await workbot.allowDesktopViews(sessionId, views)
        if (!updated.ok) return failed(updated.error)
      }
      const target = computer
      const canRebuild = !existing.ok || existing.value.status !== "busy"
      const rebuildOutdated = () => {
        let rebuilding = autoRebuilds.get(sessionId)
        if (!rebuilding) {
          console.error("[workbot] rebuilding an outdated computer", { operation })
          rebuilding = client.desktopAction(sessionId, "rebuild").finally(() => autoRebuilds.delete(sessionId))
          autoRebuilds.set(sessionId, rebuilding)
          rebuilding.then(result => { if (result.ok) report(target, { event: "rebuilt" }) }, () => undefined)
        }
        return rebuilding
      }
      if (operation === "viewer") {
        const body = viewer
        if (!body.success) return c.json({ error: "invalid_request" }, 400)
        const { wake, ...view } = body.data
        if (view.control) await workbot.stop(actorOf(member), scope.chat)
        const open = () => client.desktopViewer(sessionId, { ...view, origin: new URL(config.publicUrl).origin })
        let result = await open()
        if (!result.ok && result.error === "desktop_unavailable") {
          await new Promise(resolve => setTimeout(resolve, 500))
          result = await open()
        }
        if (wake && result.ok && result.value.state === "paused") {
          let resumed = await client.desktopAction(sessionId, "resume")
          if (resumed.ok) report(target, { event: "resumed" })
          else if (resumed.error === "desktop_outdated" && canRebuild) resumed = await rebuildOutdated()
          if (!resumed.ok) return failed(resumed.error)
          result = await open()
        }
        if (!result.ok && result.error === "desktop_outdated" && canRebuild) {
          const rebuilt = await rebuildOutdated()
          if (!rebuilt.ok) return failed(rebuilt.error, true)
          result = await open()
          if (!result.ok) return failed(result.error, true)
        }
        if (!result.ok) return failed(result.error)
        if (!await allowedViews()) return c.json({ error: "feature_disabled" }, 403)
        report(target, result.value.state === "connected" ? { event: "viewer_opened", view: view.view, control: view.control } : { event: "paused" })
        return c.json(result.value)
      }
      const body = action
      if (!body.success) return c.json({ error: "invalid_request" }, 400)
      if (!await allowedViews()) return c.json({ error: "feature_disabled" }, 403)
      if (body.data.action === "pause" || body.data.action === "rebuild") await workbot.stop(actorOf(member), scope.chat)
      let result = await client.desktopAction(sessionId, body.data.action)
      let rebuilt = body.data.action === "rebuild"
      if (!result.ok && result.error === "desktop_outdated" && body.data.action === "resume" && canRebuild) {
        result = await rebuildOutdated()
        rebuilt = true
      }
      if (!result.ok) return failed(result.error, rebuilt)
      if (body.data.action === "rebuild" || !rebuilt) report(target, { event: COMPUTER_ACTION_EVENTS[body.data.action] })
      return c.json({ ok: true })
    } catch (error) {
      console.error("[workbot] desktop request failed", { operation, error: error instanceof Error ? error.message : "unknown" })
      return failed("desktop_unavailable")
    }
  })

  app.get("/v1/workbot/model-recovery", async (c) => {
    const member = c.get("member")
    if (!member.den.enabled) return c.json({ error: "feature_disabled" }, 404)
    const result = await den.modelRecovery(member.accessToken)
    return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
  })

  app.get("/v1/workbot/activation", async (c) => {
    const member = c.get("member")
    if (!member.den.enabled) return c.json({ error: "feature_disabled" }, 404)
    const result = await den.activation(member.accessToken)
    return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
  })
  app.get("/v1/workbot/devices", async (c) => {
    c.header("Cache-Control", "no-store")
    const member = c.get("member")
    if (!member.den.enabled) return c.json({ error: "feature_disabled" }, 403)
    const result = await den.devices(member.accessToken)
    return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
  })
  app.post("/v1/workbot/activation/events", bodyLimit({ maxSize: 1024 }), async (c) => {
    const member = c.get("member")
    if (!member.den.enabled) return c.json({ error: "feature_disabled" }, 404)
    const body = activationEventRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success || body.data.step === "own_provider" || body.data.step === "use_skill" || body.data.step === "connector") return c.json({ error: "invalid_request" }, 400)
    const result = await den.activationEvent(member.accessToken, body.data)
    return new Response(JSON.stringify(result.payload), { status: result.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } })
  })

  const calendarRoute = async (c: Context<AppEnv>) => {
    const member = c.get("member")
    if (!member.den.enabled || member.den.calendar !== true) return c.json({ error: "workbot_calendar_not_enabled" }, 403)
    const url = new URL(c.req.url)
    const path = url.pathname.slice("/v1/workbot/calendar".length)
    const method = c.req.method === "POST" ? "POST" : c.req.method === "PATCH" ? "PATCH" : "GET"
    if (method === "GET" && config.calendarMockUrl && /^\/v1\/capabilities\/(google-workspace|microsoft-365)\/calendar-events$/.test(path)) {
      const response = await fetch(`${config.calendarMockUrl}${path}${url.search}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) })
      return new Response(JSON.stringify(await response.json().catch(() => null)), { status: response.status, headers: { "content-type": "application/json" } })
    }
    const body = method === "PATCH" || (method === "POST" && path === "/v1/cloud-automations") ? await c.req.json().catch(() => null) : method === "POST" ? {} : undefined
    const { status, payload } = await den.calendar(member.accessToken, { method, path: `${path}${url.search}`, body })
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
  }
  app.get("/v1/workbot/documents/*", async (c) => {
    const member = c.get("member")
    if (!member.den.enabled || member.den.documents !== true) return c.json({ error: "workbot_documents_not_enabled" }, 403)
    const url = new URL(c.req.url)
    const path = url.pathname.slice("/v1/workbot/documents".length)
    const editor = /^\/v1\/documents\/(?:google-drive|microsoft-365)\/files\/[A-Za-z0-9_-]{1,512}\/(editor|content|metadata)$/.exec(path)
    if (editor?.[1] === "metadata" && !member.den.workspaceAssistant) return c.json({ error: "feature_disabled" }, 403)
    if (path !== "/v1/capabilities/google-workspace/drive-files" && path !== "/v1/documents/microsoft-365/files" && !editor) return c.json({ error: "not_found" }, 404)
    if (editor?.[1] === "content") {
      const response = await den.documentContent(member.accessToken, `${path}${url.search}`, c.req.header("range"))
      const ranged = Object.fromEntries(["content-length", "content-range", "accept-ranges"].flatMap(name => { const value = response.headers.get(name); return value ? [[name, value]] : [] }))
      return new Response(response.body, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", ...ranged } })
    }
    const { status, payload } = await den.documents(member.accessToken, `${path}${url.search}`)
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
  })

  app.get("/v1/workbot/calendar/*", calendarRoute)
  app.post("/v1/workbot/calendar/*", calendarRoute)
  app.patch("/v1/workbot/calendar/*", calendarRoute)

  app.get("/v1/workbot/chats", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    if (!member.den.sideChats) return c.json({ error: "feature_disabled" }, 404)
    try {
      return c.json(await workbotFor(member).listChats(actorOf(member)))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.delete("/v1/workbot/chats/:chatId", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    if (!member.den.sideChats) return c.json({ error: "feature_disabled" }, 404)
    try {
      const chatId = c.req.param("chatId")
      const workbot = workbotFor(member)
      const sessionId = WORKBOT_CHAT_ID.test(chatId) ? await workbot.sessionIdOf(actorOf(member), chatId).catch(() => null) : null
      const result = await workbot.removeChat(actorOf(member), chatId)
      if (!result.ok) return c.json({ error: result.code }, result.code === "busy" ? 409 : 404)
      if (sessionId) createComputerReporter({ enabled: () => true, send: body => den.reportComputer(member.accessToken, body) })({ sessionId, chat: chatId }, { event: "removed" })
      return c.json({ ok: true as const })
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.post("/v1/workbot/hello", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const body = z.object({ timeZone: z.string().min(1).max(100).optional() }).safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request" }, 400)
    const member = c.get("member")
    try {
      return c.json(await workbotFor(member).hello(actorOf(member), body.data))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.post("/v1/workbot/connections/:connectionId/connect/start", bodyLimit({ maxSize: 4096 }), async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    const { status, payload } = await den.connect(member.accessToken, c.req.param("connectionId"), await c.req.json().catch(() => null))
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
  })

  app.get("/v1/workbot/connections", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const member = c.get("member")
    const listed = await den.connections(member.accessToken).catch(() => null)
    if (!listed) return c.json({ error: "connections_unavailable", message: "Couldn't verify your connections. Try again." }, 502)
    const denWeb = config.denWebUrl ?? (await den.webUrl().catch(() => null))
    const linked = <T extends { id: string; connectUrl: string | null }>(connection: T): T => ({
      ...connection,
      connectUrl: !connection.connectUrl || !denWeb ? connection.connectUrl : workbotConnectionUrl(denWeb, member.den.organization.id, connection.id),
    })
    return c.json({
      connections: listed.connections.map((connection) => ({
        ...connection,
        connectUrl: connection.ready || !denWeb ? connection.connectUrl : workbotConnectionUrl(denWeb, member.den.organization.id, connection.id),
      })),
      ...(listed.apps ? { apps: listed.apps.map((app) => ({
        ...linked(app),
        iconCandidates: app.iconCandidates?.map((src) => src.startsWith("/integrations/") || src === "/openwork-mark.svg" ? (denWeb ? new URL(src, denWeb).href : null) : src).filter((src): src is string => src !== null),
      })) } : {}),
    })
  })

  app.get("/v1/workbot/remote-jobs", async (c) => {
    c.header("Cache-Control", "no-store")
    const member = c.get("member")
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    try {
      return c.json(await workbotFor(member).readRemoteJobs(actorOf(member), { chat: scope.chat }))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 503)
      throw error
    }
  })

  app.get("/v1/workbot/remote-jobs/:key", async (c) => {
    c.header("Cache-Control", "no-store")
    const member = c.get("member")
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const key = c.req.param("key")
    if (key.length > 260) return c.json({ error: "invalid_request" }, 400)
    try {
      return c.json(await workbotFor(member).readRemoteJob(actorOf(member), { key, chat: scope.chat }))
    } catch (error) {
      if (error instanceof WorkbotRemoteJobError) return c.json({ error: error.code }, error.status)
      return c.json({ error: "remote_job_unavailable" }, 503)
    }
  })

  app.post("/v1/workbot/remote-jobs/:key/stop", bodyLimit({ maxSize: 1024 }), async (c) => {
    c.header("Cache-Control", "no-store")
    const member = c.get("member")
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const body = z.object({ messageId: z.string().trim().min(1).max(240) }).strict().safeParse(await c.req.json().catch(() => null))
    const key = c.req.param("key")
    if (!body.success || key.length > 260) return c.json({ error: "invalid_request" }, 400)
    try {
      return c.json(await workbotFor(member).stopRemoteJob(actorOf(member), { key, messageId: body.data.messageId, chat: scope.chat }))
    } catch (error) {
      if (error instanceof WorkbotRemoteJobError) return c.json({ error: error.code }, error.status)
      return c.json({ error: "remote_stop_unconfirmed" }, 503)
    }
  })

  app.post("/v1/workbot/apps/:appId/open", bodyLimit({ maxSize: 1024 }), async (c) => {
    c.header("Cache-Control", "no-store")
    const member = c.get("member")
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const appId = mcpAppIdSchema.safeParse(c.req.param("appId"))
    if (!appId.success) return c.json({ error: "invalid_request" }, 400)
    try {
      return c.json(await den.openApp(member.accessToken, appId.data))
    } catch (error) {
      if (error instanceof DenAppError) return c.json({ error: error.reason === "signed_out" ? "app_signed_out" : "app_unavailable" }, 502)
      throw error
    }
  })

  app.post("/v1/workbot/apps/:appId/call", bodyLimit({ maxSize: 256 * 1024 }), async (c) => {
    c.header("Cache-Control", "no-store")
    const member = c.get("member")
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const appId = mcpAppIdSchema.safeParse(c.req.param("appId"))
    const body = z.object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()).default({}) }).strict().safeParse(await c.req.json().catch(() => null))
    if (!appId.success || !body.success) return c.json({ error: "invalid_request" }, 400)
    try {
      return c.json({ result: await den.callApp(member.accessToken, appId.data, body.data.name, body.data.arguments) })
    } catch (error) {
      if (error instanceof DenAppError) return c.json({ error: error.reason === "signed_out" ? "app_signed_out" : "app_unavailable" }, 502)
      throw error
    }
  })

  app.get("/v1/workbot/memory", async (c) => {
    const member = c.get("member")
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    try {
      return c.json({ files: await workbotFor(member).readMemory(actorOf(member)) })
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 503)
      throw error
    }
  })

  app.get("/v1/workbot", async (c) => {
    if (!enabled(c)) return c.json({ available: false as const, reason: "workbot_not_enabled" as const })
    const query = threadQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: "invalid_request" }, 400)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const member = c.get("member")
    try {
      const started = performance.now()
      const thread = await workbotFor(member).readThread(actorOf(member), { turns: query.data.turns, chat: scope.chat })
      c.header("Server-Timing", `thread;dur=${Math.round(performance.now() - started)}`)
      return c.json({ available: true as const, ...thread })
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ available: false as const, reason: error.code })
      throw error
    }
  })

  app.post("/v1/workbot/messages", async (c) => {
    const body = sendSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json(tooLong(body.error) ? messageTooLong : { error: "invalid_request" }, 400)
    if (!body.data.text && !body.data.attachments?.length) return c.json({ error: "invalid_request", message: "Send text or a file." }, 400)
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const member = c.get("member")
    if (body.data.context && !sharesContext(member.den, body.data.context)) return c.json({ error: "feature_disabled", message: "Contextual chat is off for this workspace." }, 403)
    if (workbotContextPrompt(body.data.text, body.data.context).length > MAX_MESSAGE_CHARS) return c.json(messageTooLong, 400)
    const retryAfter = rateLimited(member.den.memberId)
    if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
    try {
      let text = body.data.text
      if (body.data.teachingId) {
        const fresh = await den.session(member.accessToken)
        if (scope.chat !== null || !fresh.enabled || !fresh.browser || !fresh.browserDemonstrations || fresh.user.id !== member.den.user.id || fresh.organization.id !== member.den.organization.id || fresh.memberId !== member.den.memberId) return c.json({ error: "feature_disabled" }, 403)
        const client = runnerClientFor(member)
        const sessionId = await workbotFor(member).sessionIdOf(actorOf(member))
        const state = await client.browserDemonstration(sessionId, { action: "read" })
        if (!state.ok || state.value.demonstration?.id !== body.data.teachingId || !["recording", "paused", "draft"].includes(state.value.demonstration.phase)) return c.json({ error: "teaching_unavailable", message: "Reopen teaching to check the demonstration before sending this explanation." }, 409)
        const demo = state.value.demonstration
        if (!demo.annotationIds?.includes(body.data.id) && (demo.annotationIds?.length ?? 0) >= 256) return c.json({ error: "notes_full", message: "Finish this skill before adding more teaching notes." }, 400)
        if (text.length > 2000) return c.json({ error: "explanation_too_long", message: "Keep each explanation under 2,000 characters, or explain several steps separately." }, 400)
        const focused = body.data.teachingStepId ? demo.steps.find(step => step.id === body.data.teachingStepId) : demo.steps.at(-1)
        if (body.data.teachingStepId && !focused) return c.json({ error: "step_unavailable", message: "Choose a recorded step before sending this explanation." }, 409)
        if (!demo.annotationIds?.includes(body.data.id) && focused && focused.explanation.length + text.length + (focused.explanation ? 1 : 0) > 2000) return c.json({ error: "step_notes_full", message: "This step's notes are full. Edit its explanation before adding more." }, 400)
        const annotated = await client.browserDemonstration(sessionId, { action: "annotate", text, messageId: body.data.id, ...(focused ? { stepId: focused.id } : {}) })
        if (!annotated.ok || !annotated.value.demonstration) return c.json({ error: "teaching_unavailable" }, 409)
        const confirmed = await den.session(member.accessToken)
        if (!confirmed.enabled || !confirmed.browser || !confirmed.browserDemonstrations || confirmed.user.id !== fresh.user.id || confirmed.organization.id !== fresh.organization.id || confirmed.memberId !== fresh.memberId) return c.json({ error: "feature_disabled" }, 403)
        text = browserTeachingPrompt(text, annotated.value.demonstration.steps, { phase: annotated.value.demonstration.phase, stepId: focused?.id ?? annotated.value.demonstration.steps.at(-1)?.id })
        if (text.length > MAX_MESSAGE_CHARS) return c.json(messageTooLong, 400)
      }
      const result = await workbotFor(member).send(actorOf(member), { ...body.data, text, chat: scope.chat })
      if (!result.ok && result.code === "message_too_long") return c.json(messageTooLong, 400)
      if (!result.ok) return c.json({ error: result.code }, result.code === "unknown_file" ? 400 : 429)
      return c.json({ ok: true as const }, 202)
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.post("/v1/workbot/messages/:id/retry", async (c) => {
    const body = z.object({ timeZone: z.string().max(64).optional() }).strict().safeParse(await c.req.json().catch(() => ({})))
    if (!body.success) return c.json({ error: "invalid_request" }, 400)
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const member = c.get("member")
    const retryAfter = rateLimited(member.den.memberId)
    if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
    try {
      const result = await workbotFor(member).retry(actorOf(member), { id: c.req.param("id"), timeZone: body.data.timeZone, chat: scope.chat })
      if (!result.ok) return c.json({ error: result.code }, result.code === "unknown_message" ? 404 : result.code === "not_failed" ? 409 : 429)
      return c.json({ ok: true as const }, 202)
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.post("/v1/workbot/stop", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const member = c.get("member")
    try {
      return c.json(await workbotFor(member).stop(actorOf(member), scope.chat))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.delete("/v1/workbot/messages/:id", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const member = c.get("member")
    try {
      const result = await workbotFor(member).deleteMessage(actorOf(member), c.req.param("id"), scope.chat)
      if (!result.ok) return c.json({ error: result.code }, result.code === "busy" ? 409 : 404)
      return c.json({ ok: true as const })
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.post("/v1/workbot/messages/:id/edit", async (c) => {
    const body = editSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json(tooLong(body.error) ? messageTooLong : { error: "invalid_request" }, 400)
    if (!body.data.text && !body.data.attachments?.length) return c.json({ error: "invalid_request", message: "Send text or a file." }, 400)
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const member = c.get("member")
    if (body.data.context && !sharesContext(member.den, body.data.context)) return c.json({ error: "feature_disabled", message: "Contextual chat is off for this workspace." }, 403)
    if (workbotContextPrompt(body.data.text, body.data.context).length > MAX_MESSAGE_CHARS) return c.json(messageTooLong, 400)
    const retryAfter = rateLimited(member.den.memberId)
    if (retryAfter !== null) return c.json({ error: "rate_limited" as const, retryAfter }, 429)
    try {
      const result = await workbotFor(member).editMessage(actorOf(member), { id: c.req.param("id"), ...body.data, chat: scope.chat })
      if (!result.ok && result.code === "message_too_long") return c.json(messageTooLong, 400)
      if (!result.ok) {
        const status = result.code === "unknown_message" ? 404 : result.code === "unknown_file" ? 400 : 429
        return c.json({ error: result.code }, status)
      }
      return c.json({ ok: true as const }, 202)
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.post("/v1/workbot/tasks/:taskId/stop", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const member = c.get("member")
    try {
      return c.json(await workbotFor(member).stopTask(actorOf(member), c.req.param("taskId"), scope.chat))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  const socketRest = new Map<string, number>()
  const rest = (owner: string) => {
    const now = Date.now()
    if (socketRest.size >= SOCKET_REST_MAX) for (const [key, until] of socketRest) if (until <= now) socketRest.delete(key)
    if (socketRest.size < SOCKET_REST_MAX) socketRest.set(owner, now + SOCKET_REST_MS)
  }

  const openLiveSocket = async (member: Member, chat: WorkbotChat, signal: AbortSignal) => {
    const owner = workbotOwner(member.den.organization.id, member.den.memberId)
    const now = Date.now()
    const resting = socketRest.get(owner)
    if (resting !== undefined && resting > now) return null
    socketRest.delete(owner)
    const sessionId = await workbotFor(member).sessionIdOf(actorOf(member), chat).catch(() => null)
    const socket = sessionId ? await runnerClientFor(member).openEventsSocket(sessionId, signal).catch(() => null) : null
    if (!socket) rest(owner)
    return socket ? { owner, events: socket, openedAt: now } : null
  }

  const relayLiveSocket = (c: Context<AppEnv>, socket: { owner: string; events: AsyncIterableIterator<RunnerLiveEvent>; openedAt: number }, upstream: AbortController) => {
    c.header("Cache-Control", "no-cache, no-transform")
    c.header("X-Accel-Buffering", "no")
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => upstream.abort())
      const deadline = setTimeout(() => upstream.abort(), EVENTS_MAX_MS)
      const keepAlive = setInterval(() => void stream.write(": keep-alive\n\n").catch(() => undefined), KEEP_ALIVE_MS)
      try {
        await stream.writeSSE({ event: "ready", data: "{}" })
        for await (const raw of socket.events) {
          if (stream.aborted) break
          const event = toWorkbotPageEvent(raw)
          if (event) await stream.writeSSE({ data: JSON.stringify(event) })
        }
        if (!upstream.signal.aborted && Date.now() - socket.openedAt < SOCKET_MIN_MS) rest(socket.owner)
      } catch (error) {
        if (!upstream.signal.aborted && !stream.aborted) reportError("events_relay_failed", error)
      } finally {
        clearTimeout(deadline)
        clearInterval(keepAlive)
        upstream.abort()
      }
    })
  }

  const eventsUnavailable = new Map<WorkbotEventsUnavailable, number>()
  let eventsUnavailableLoggedAt = 0
  const logEventsUnavailable = (code: WorkbotEventsUnavailable) => {
    eventsUnavailable.set(code, (eventsUnavailable.get(code) ?? 0) + 1)
    const now = Date.now()
    if (now - eventsUnavailableLoggedAt < EVENTS_UNAVAILABLE_LOG_MS) return
    eventsUnavailableLoggedAt = now
    console.error("[workbot] live events unavailable", Object.fromEntries(eventsUnavailable))
    eventsUnavailable.clear()
  }

  app.get("/v1/workbot/events", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const member = c.get("member")
    const upstream = new AbortController()
    const socket = member.den.stepTurns ? await openLiveSocket(member, scope.chat, upstream.signal) : null
    if (socket) return relayLiveSocket(c, socket, upstream)
    const opened = await workbotFor(member).openEvents(actorOf(member), upstream.signal, scope.chat)
    const body = opened.ok ? opened.response.body : null
    if (!body) {
      logEventsUnavailable(opened.ok ? "runner_refused" : opened.code)
      return c.json({ error: "workbot_runner_unavailable" }, 409, { "Retry-After": String(EVENTS_RETRY_AFTER_S) })
    }
    c.header("Cache-Control", "no-cache, no-transform")
    c.header("X-Accel-Buffering", "no")
    return streamSSE(c, async (stream) => {
      stream.onAbort(() => upstream.abort())
      const deadline = setTimeout(() => upstream.abort(), EVENTS_MAX_MS)
      const reader = body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ""
      try {
        await stream.writeSSE({ event: "ready", data: "{}" })
        for (;;) {
          const { value, done } = await reader.read()
          if (done || stream.aborted) break
          buffer += value
          let boundary = buffer.indexOf("\n\n")
          while (boundary !== -1) {
            const block = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            boundary = buffer.indexOf("\n\n")
            if (block.startsWith(":")) {
              await stream.write(": keep-alive\n\n")
              continue
            }
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n")
            let parsed: unknown = null
            try {
              parsed = JSON.parse(data)
            } catch {
              continue
            }
            const event = toWorkbotPageEvent(parsed)
            if (event) await stream.writeSSE({ data: JSON.stringify(event) })
          }
        }
      } catch (error) {
        if (!upstream.signal.aborted && !stream.aborted) reportError("events_relay_failed", error)
      } finally {
        clearTimeout(deadline)
        upstream.abort()
        reader.releaseLock()
      }
    })
  })

  app.post(
    "/v1/workbot/files",
    bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: "file_too_large", message: "The most a file can be is 100 MB." }, 413) }),
    async (c) => {
      const query = uploadQuerySchema.safeParse(c.req.query())
      if (!query.success) return c.json({ error: "invalid_request" }, 400)
      if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
      const scope = chatOf(c)
      if (scope.refused) return scope.refused
      const member = c.get("member")
      try {
        const file = await workbotFor(member).uploadFile(actorOf(member), {
          name: query.data.name,
          mediaType: c.req.header("content-type") ?? "application/octet-stream",
          bytes: await c.req.arrayBuffer(),
          timeZone: query.data.timeZone,
          chat: scope.chat,
        })
        return c.json(file, 201)
      } catch (error) {
        if (error instanceof WorkbotFilesUnavailableError) return c.json({ error: "workbot_files_not_configured" }, 409)
        if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
        throw error
      }
    },
  )

  app.get("/v1/workbot/files", async (c) => {
    if (!enabled(c)) return c.json({ error: "workbot_not_enabled" }, 409)
    const scope = chatOf(c)
    if (scope.refused) return scope.refused
    const member = c.get("member")
    try {
      return c.json(await workbotFor(member).listFiles(actorOf(member), scope.chat))
    } catch (error) {
      if (error instanceof WorkbotUnavailableError) return c.json({ error: error.code }, 409)
      throw error
    }
  })

  app.get("/v1/workbot/files/:fileId/preview", async (c) => {
    const fileId = fileIdSchema.safeParse(c.req.param("fileId"))
    const scope = chatOf(c)
    if (!fileId.success || !enabled(c) || scope.refused) return c.json({ error: "not_found" }, 404)
    const member = c.get("member")
    const manifest = await workbotFor(member).readPreview(actorOf(member), fileId.data, scope.chat).catch(() => null)
    return manifest ? c.json(manifest, 200) : c.json({ error: "not_found" }, 404)
  })

  app.get("/v1/workbot/files/:fileId/preview/:page", async (c) => {
    const fileId = fileIdSchema.safeParse(c.req.param("fileId"))
    const page = z.coerce.number().int().min(1).max(1_000).safeParse(c.req.param("page"))
    const scope = chatOf(c)
    if (!fileId.success || !page.success || !enabled(c) || scope.refused) return c.json({ error: "not_found" }, 404)
    const member = c.get("member")
    const upstream = await workbotFor(member).downloadPreviewPage(actorOf(member), fileId.data, page.data, scope.chat).catch(() => null)
    if (!upstream?.body) return c.json({ error: "not_found" }, 404)
    const length = upstream.headers.get("content-length")
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": "image/png",
        ...(length ? { "content-length": length } : {}),
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=3600",
      },
    })
  })

  app.get("/v1/workbot/files/:fileId", async (c) => {
    const fileId = fileIdSchema.safeParse(c.req.param("fileId"))
    const scope = chatOf(c)
    if (!fileId.success || !enabled(c) || scope.refused) return c.json({ error: "not_found" }, 404)
    const member = c.get("member")
    const upstream = await workbotFor(member).downloadFile(actorOf(member), fileId.data, scope.chat).catch(() => null)
    if (!upstream?.body) return c.json({ error: "not_found" }, 404)
    const type = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "application/octet-stream"
    const encodedName = upstream.headers.get("x-file-name") ?? "file"
    let name = "file"
    try {
      name = decodeURIComponent(encodedName)
    } catch {
    }
    const inline = c.req.query("inline") === "1" && INLINE_TYPES.has(type)
    const asciiName = name.replace(/[^\x20-\x7e]|["\\]/g, "_")
    const length = upstream.headers.get("content-length")
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": inline ? type : type.startsWith("text/") || type === "image/svg+xml" ? "application/octet-stream" : type,
        ...(length ? { "content-length": length } : {}),
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=3600",
      },
    })
  })

  app.delete("/v1/workbot/files/:fileId", async (c) => {
    const fileId = fileIdSchema.safeParse(c.req.param("fileId"))
    const scope = chatOf(c)
    if (!fileId.success || !enabled(c) || scope.refused) return c.json({ error: "not_found" }, 404)
    const member = c.get("member")
    const deleted = await workbotFor(member).deleteFile(actorOf(member), fileId.data, scope.chat).catch(() => false)
    return deleted ? c.body(null, 204) : c.json({ error: "not_found" }, 404)
  })
}
