import { createHash } from "node:crypto"
import type { AutomationListItem } from "@openwork/automations"
import { AUTOMATION_CLOUD_DEFAULT_MODEL, type AutomationRun } from "@openwork/types/automations"
import { cloudAutomationRuntime, type CloudAutomationRuntime } from "../automations/headless-runtime.js"
import {
  createHeadlessRunnerClient,
  defaultHeadlessRunnerDeps,
  headlessRunnerConfig,
  type HeadlessRunnerClient,
} from "../headless-runner/client.js"
import { organizationHasCapability } from "../organization-capabilities.js"
import { cloudBrowserEnabledFor, getCloudBrowser } from "../cloud-browser/service.js"
import { buildWorkbotTurns, interruptedTurnId, threadBusy, WORKBOT_MESSAGE_PREFIX, type WorkbotTurn } from "./thread.js"

/**
 * Workbot: one chat per person, set up once by an admin. Each member has a
 * single durable conversation on the headless runner (its memory), reaches
 * their apps through OpenWork MCP with a token minted per turn, and runs on
 * the one model the runner is configured with. Nothing is configured here.
 */

export type WorkbotActor = {
  organizationId: string
  organizationName: string
  organizationMetadata: Parameters<typeof organizationHasCapability>[0]
  memberId: string
  userId: string
  firstName: string | null
}

export type WorkbotAutomation = {
  id: string
  name: string
  state: AutomationListItem["automation"]["state"]
  schedule: AutomationListItem["revision"]["schedule"]
  nextDueAt: number | null
  runs: Array<Pick<AutomationRun, "id" | "status" | "finishedAt" | "resultSummary"> & { error: string | null }>
}

export type WorkbotThread = {
  name: string
  organizationName: string
  status: "idle" | "busy"
  turns: WorkbotTurn[]
  automations: WorkbotAutomation[]
}

export type WorkbotDeps = {
  client: HeadlessRunnerClient | null
  cloudRuntime: (organizationId: string) => Promise<CloudAutomationRuntime>
  automations: {
    get(input: { organizationId: string; ownerMemberId: string; automationId: string }): Promise<AutomationListItem | null>
    listRuns(input: { organizationId: string; ownerMemberId: string; automationId: string; limit: number }): Promise<{ items: AutomationRun[] }>
  }
  /** Whether this member's turns get the cloud browser tools. */
  canBrowse: (actor: WorkbotActor) => boolean
}

export function defaultWorkbotDeps(): WorkbotDeps {
  const runner = defaultHeadlessRunnerDeps()
  return {
    client: runner ? createHeadlessRunnerClient(runner) : null,
    cloudRuntime: cloudAutomationRuntime,
    automations: {
      get: async (input) => (await import("../automations/repository.js")).automationRepository.get(input),
      listRuns: async (input) => (await import("../automations/repository.js")).automationRepository.listRuns(input),
    },
    // The same rule that registers the browser tools for a headless run.
    canBrowse: (actor) => cloudBrowserEnabledFor(actor.organizationMetadata) && getCloudBrowser() !== null,
  }
}

export function workbotEnabled(metadata: WorkbotActor["organizationMetadata"], env: Record<string, string | undefined> = process.env) {
  return organizationHasCapability(metadata, "workbot") && headlessRunnerConfig(env) !== null
}

/** Derived, so each member has exactly one thread and Den stores nothing to find it. */
export function workbotSessionId(organizationId: string, memberId: string) {
  return `hs_wb_${createHash("sha256").update(`workbot:${organizationId}:${memberId}`).digest("hex").slice(0, 40)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseMetadata(metadata: WorkbotActor["organizationMetadata"]): Record<string, unknown> {
  if (typeof metadata !== "string") return metadata ?? {}
  try {
    const parsed: unknown = JSON.parse(metadata)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** The organization's own app name when it set one (Settings → Brand), otherwise Workbot. */
export function workbotName(metadata: WorkbotActor["organizationMetadata"]) {
  const brand = parseMetadata(metadata).brandAppName
  return typeof brand === "string" && brand.trim() && brand.trim() !== "OpenWork" ? brand.trim().slice(0, 40) : "Workbot"
}

export function workbotInstructions(input: {
  name: string
  organizationName: string
  firstName: string | null
  timeZone: string
  canSchedule: boolean
  canBrowse: boolean
  now?: Date
}) {
  const localNow = (input.now ?? new Date()).toLocaleString("en-US", {
    timeZone: input.timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  })
  const person = input.firstName ?? "this person"
  return [
    `You are ${input.name}, the assistant ${input.organizationName} set up for ${person}. This is your one ongoing conversation with them: it is your memory, so use what was said before.`,
    "",
    `- ${person} is not technical. Never mention tools, MCP, capabilities, models, prompts or settings. Write like a helpful coworker: short, plain sentences.`,
    "- Reach their connected apps with search_capabilities, then execute_capability. Look things up before asking them.",
    "- Keep chat replies to a few lines. For anything longer (a draft, notes, a comparison), write it with write_file under drafts/ using a clear file name such as drafts/launch-pricing-copy.md, then reply with one line about it. They see it as a card they can open.",
    "- Ask before you send, post, delete or change anything in their apps, unless they asked for that exact action in this message.",
    input.canSchedule
      ? `- For anything recurring or later ("every Monday at 8", "remind me at 3"), create an Automation: find createCloudAutomation with search_capabilities, then call it with execute_capability. Use their time zone (${input.timeZone}), a short plain name, instructions that make sense on their own later, and model {"providerId":"${AUTOMATION_CLOUD_DEFAULT_MODEL.providerId}","modelId":"${AUTOMATION_CLOUD_DEFAULT_MODEL.modelId}"}. Then confirm in one line that it runs in the cloud, so their laptop can stay closed.`
      : "- You cannot schedule recurring work here yet. If they ask, say so in one line and offer to do it now instead.",
    input.canBrowse
      ? "- When a site has no connected app, use the browser tools (browser_open, browser_observe, browser_act). When the task needs them signed in to a site, call browser_handoff right away instead of asking first, then tell them in one line to sign in from the browser card below. Choosing Done there tells you they are signed in, and the sign-in is remembered. Never ask for a password or code in the chat."
      : "",
    `- Their time zone is ${input.timeZone}. When they sent their latest message it was ${localNow} there; say "today" and "tomorrow" from their point of view.`,
  ].filter(Boolean).join("\n")
}

function validTimeZone(value: string | undefined) {
  if (!value) return "UTC"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return value
  } catch {
    return "UTC"
  }
}

async function automationsFor(actor: WorkbotActor, ids: string[], deps: WorkbotDeps): Promise<WorkbotAutomation[]> {
  const scope = { organizationId: actor.organizationId, ownerMemberId: actor.memberId }
  const loaded = await Promise.all(ids.slice(-20).map(async (automationId) => {
    const item = await deps.automations.get({ ...scope, automationId }).catch(() => null)
    if (!item) return null
    const runs = await deps.automations.listRuns({ ...scope, automationId, limit: 5 }).catch(() => ({ items: [] }))
    return {
      id: item.automation.id,
      name: item.automation.name,
      state: item.automation.state,
      schedule: item.revision.schedule,
      nextDueAt: item.automation.nextDueAt,
      runs: runs.items
        .filter((run) => run.status === "succeeded" || run.status === "failed")
        .map((run) => ({ id: run.id, status: run.status, finishedAt: run.finishedAt, resultSummary: run.resultSummary, error: run.error?.message ?? null })),
    }
  }))
  return loaded.flatMap((entry) => (entry ? [entry] : []))
}

export class WorkbotUnavailableError extends Error {
  constructor(readonly code: "workbot_not_enabled" | "workbot_runner_unavailable") {
    super(code)
    this.name = "WorkbotUnavailableError"
  }
}

function clientOf(deps: WorkbotDeps) {
  if (!deps.client) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return deps.client
}

async function ensureSession(actor: WorkbotActor, timeZone: string, deps: WorkbotDeps) {
  const client = clientOf(deps)
  const name = workbotName(actor.organizationMetadata)
  const canSchedule = await deps.cloudRuntime(actor.organizationId) === "headless"
  const saved = await client.putSession(workbotSessionId(actor.organizationId, actor.memberId), {
    title: `${name} · ${actor.firstName ?? "member"}`,
    instructions: workbotInstructions({
      name,
      organizationName: actor.organizationName,
      firstName: actor.firstName,
      timeZone,
      canSchedule,
      canBrowse: deps.canBrowse(actor),
    }),
  })
  if (!saved.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return saved.value.id
}

export async function readWorkbotThread(actor: WorkbotActor, deps: WorkbotDeps = defaultWorkbotDeps()): Promise<WorkbotThread> {
  const client = clientOf(deps)
  const sessionId = workbotSessionId(actor.organizationId, actor.memberId)
  const name = workbotName(actor.organizationMetadata)
  const read = await client.readSession(sessionId, { limit: 500 })
  if (!read.ok && read.status === 404) {
    // First visit: no thread yet. It is created with the first message.
    return { name, organizationName: actor.organizationName, status: "idle", turns: [], automations: [] }
  }
  if (!read.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")

  // A runner restart interrupts the running turn; re-sending its id resumes it with a fresh token.
  const interrupted = interruptedTurnId(read.value)
  if (interrupted) {
    await client.sendTurn({ userId: actor.userId, organizationId: actor.organizationId }, { sessionId, messageId: interrupted, prompt: "resume" }).catch(() => null)
  }

  const turns = buildWorkbotTurns(read.value)
  return {
    name,
    organizationName: actor.organizationName,
    status: threadBusy(read.value) ? "busy" : "idle",
    turns,
    automations: await automationsFor(actor, [...new Set(turns.flatMap((turn) => turn.automationIds))], deps),
  }
}

export async function sendWorkbotMessage(
  actor: WorkbotActor,
  input: { id: string; text: string; timeZone?: string },
  deps: WorkbotDeps = defaultWorkbotDeps(),
) {
  const client = clientOf(deps)
  const sessionId = await ensureSession(actor, validTimeZone(input.timeZone), deps)
  // The page's own id makes retries safe: the runner never starts a second turn for it.
  const sent = await client.sendTurn(
    { userId: actor.userId, organizationId: actor.organizationId },
    { sessionId, messageId: `${WORKBOT_MESSAGE_PREFIX}${input.id}`, prompt: input.text },
  )
  if (!sent.ok && sent.status === 429) return { ok: false as const, code: "too_many_queued" as const }
  if (!sent.ok) throw new WorkbotUnavailableError("workbot_runner_unavailable")
  return { ok: true as const }
}

export async function stopWorkbot(actor: WorkbotActor, deps: WorkbotDeps = defaultWorkbotDeps()) {
  const stopped = await clientOf(deps).abort(workbotSessionId(actor.organizationId, actor.memberId))
  return { stopped: stopped.stopped }
}

export async function readWorkbotFile(actor: WorkbotActor, path: string, deps: WorkbotDeps = defaultWorkbotDeps()) {
  const read = await clientOf(deps).readFile(workbotSessionId(actor.organizationId, actor.memberId), path)
  return read.ok ? read.value.content : null
}
