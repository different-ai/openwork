import type { RunnerMessage, RunnerSnapshot } from "@openwork-ee/headless-protocol"
import type { RemoteSessionStatusResult } from "@openwork/types/automations"
import type { WorkbotRemoteJob, WorkbotRemoteJobs, WorkbotRemoteJobDetail } from "@openwork/types/workbot-remote-jobs"
import { WORKBOT_MESSAGE_PREFIX } from "./thread.js"

export class WorkbotRemoteJobError extends Error {
  constructor(readonly code: "remote_job_not_found" | "remote_job_unavailable" | "remote_stop_unavailable", readonly status: 404 | 409 | 503) { super(code) }
}

/** Normalize both desktop and cloud transcript receipts; never expose raw tool payloads to the browser. */
export function remoteJobDetail(output: unknown, job: WorkbotRemoteJob): WorkbotRemoteJobDetail {
  const parsed = resultOf(output)
  if (!parsed || typeof parsed.error === "string") return { state: "unavailable", messages: [], canStop: false, messageId: null }
  if (parsed.state === "pending") return { state: "pending", messages: [], canStop: false, messageId: null }
  const messages = Array.isArray(parsed.messages) ? parsed.messages.flatMap(message => {
    if (!record(message) || (message.role !== "user" && message.role !== "assistant") || typeof message.text !== "string" || typeof message.id !== "string") return []
    const role: "user" | "assistant" = message.role
    return [{ id: message.id.slice(0, 240), role, text: message.text.slice(0, 4_000) }]
  }) : []
  const messageId = [...messages].reverse().find(message => message.role === "user")?.id ?? null
  const canStop = !job.stale && (job.status?.state === "running" || job.status?.state === "waiting") && messageId !== null
  return { state: Array.isArray(parsed.messages) ? "ready" : "unavailable", messages: messages.slice(-6), canStop, messageId }
}

const MAX_JOBS = 10
const MAX_OUTPUT_CHARS = 256 * 1024
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0 && value.length <= 240 ? value.trim() : null

function parse(value: unknown): unknown {
  if (typeof value !== "string") return value
  if (value.length > MAX_OUTPUT_CHARS) return null
  try { return JSON.parse(value) } catch { return null }
}

/** The runner stores the MCP result as JSON, including its text-block envelope. */
function resultOf(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 3) return null
  const parsed: unknown = parse(value)
  if (!record(parsed) || parsed.isError === true) return null
  if (record(parsed.structuredContent)) return resultOf(parsed.structuredContent, depth + 1)
  if (Array.isArray(parsed.content)) {
    for (const item of parsed.content) {
      if (!record(item) || item.type !== "text") continue
      const result = resultOf(item.text, depth + 1)
      if (result) return result
    }
    return null
  }
  return parsed
}

type Call = Extract<RunnerMessage, { role: "assistant" }>["toolCalls"][number]
function capability(call: Call) {
  // The runner's registered tool name, not a substring of an arbitrary third-party tool name.
  if (call.name !== "execute_capability") return null
  const name = text(call.input.name)
  const body: unknown = parse(call.input.body ?? call.input.arguments)
  return name && record(body) ? { name, body } : null
}

function keysOf(body: Record<string, unknown>): string[] {
  const commandId = text(body.commandId)
  const sessionId = text(body.sessionId)
  if (commandId) return [`command:${commandId}`]
  if (sessionId) return [`cloud:${sessionId}`]
  return []
}

/**
 * Windowed discovery from the actor-owned runner transcript. A successful create and its matching tool return are
 * required. Ref text in prose, failed/unanswered creates and watcher titles cannot create a remote task.
 */
export function buildWorkbotRemoteJobs(snapshot: RunnerSnapshot): WorkbotRemoteJobs {
  const results = new Map(snapshot.messages.flatMap(message => message.role === "tool" ? [[message.callId, message] as const] : []))
  const jobs = new Map<string, WorkbotRemoteJob>()
  for (const message of snapshot.messages) {
    if (message.role !== "assistant") continue
    for (const call of message.toolCalls) {
      const invocation = capability(call)
      if (invocation?.name !== "remote-session:create") continue
      const output = results.get(call.id)
      if (!output || output.isError) continue
      const receipt = resultOf(output.output)
      if (!receipt || typeof receipt.error === "string") continue
      const commandId = text(receipt.commandId)
      const sessionId = text(receipt.sessionId)
      const ref = commandId ? { commandId } : receipt.target === "cloud" && sessionId ? { sessionId } : null
      if (!ref) continue
      const key = commandId ? `command:${commandId}` : `cloud:${sessionId}`
      if (jobs.has(key)) continue
      const target = commandId ? (receipt.target === "registered" ? "registered" : "desktop") : "cloud"
      jobs.set(key, {
        key, ref, title: text(invocation.body.title) ?? text(receipt.title) ?? "Remote task", target,
        toolCallId: call.id,
        turnId: message.messageId?.startsWith(WORKBOT_MESSAGE_PREFIX) ? message.messageId.slice(WORKBOT_MESSAGE_PREFIX.length) : null,
        startedAt: message.createdAt ?? null, watcherTaskIds: [], status: null, stale: true,
      })
    }
  }
  const selected = [...jobs.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, MAX_JOBS)
  const shown = new Map(selected.map(job => [job.key, job]))
  for (const turn of snapshot.turns) {
    if (turn.kind !== "task" || !turn.messageId.startsWith(WORKBOT_MESSAGE_PREFIX)) continue
    const calls = snapshot.messages.flatMap(message => message.role === "assistant" && message.messageId === turn.messageId ? message.toolCalls : [])
    if (!calls.length) continue
    const watching = new Set<string>()
    const onlyChecks = calls.every(call => {
      const invocation = capability(call)
      if (!invocation) return false
      const keys = invocation.name === "remote-session:status" && Array.isArray(invocation.body.threads)
        ? invocation.body.threads.flatMap(thread => record(thread) ? keysOf(thread) : [])
        : invocation.name === "remote-session:read" && text(invocation.body.commandId) ? keysOf(invocation.body) : []
      // Reading a transcript or running other tools is real work, not a duplicate status-watcher.
      if (!keys.length || keys.some(key => !shown.has(key))) return false
      keys.forEach(key => watching.add(key))
      return true
    })
    if (!onlyChecks) continue
    for (const key of watching) shown.get(key)?.watcherTaskIds.push(turn.messageId.slice(WORKBOT_MESSAGE_PREFIX.length))
  }
  return { jobs: selected, hasEarlier: snapshot.hasEarlier === true || jobs.size > MAX_JOBS }
}

/** The last status Workbot verified for one task, kept so a failed refresh never erases what was known. */
export type WorkbotRemoteLastKnown = { status: NonNullable<WorkbotRemoteJob["status"]>; checkedAt: number }

/**
 * Only live statuses returned for the requested refs can change state. No local-task completion inference.
 * A ref Den couldn't check just now keeps its last verified state (stale, with when it was checked).
 */
export function applyWorkbotRemoteStatuses(
  jobs: WorkbotRemoteJobs,
  result: RemoteSessionStatusResult,
  options: { now?: number; lastKnown?: (job: WorkbotRemoteJob) => WorkbotRemoteLastKnown | undefined } = {},
): WorkbotRemoteJobs {
  const now = options.now ?? Date.now()
  return { ...jobs, jobs: jobs.jobs.map(job => {
    const id = "commandId" in job.ref ? job.ref.commandId : job.ref.sessionId
    const status = result.threads.find(thread => thread.ref === id)
    const expectedTarget = "commandId" in job.ref ? "desktop" : "cloud"
    if (status?.changed && status.target === expectedTarget) return { ...job, status, stale: false, checkedAt: now, unreachable: null }
    const before = options.lastKnown?.(job)
    if (before) return { ...job, status: before.status, stale: true, checkedAt: before.checkedAt, unreachable: null }
    // Den answered but could not reach what runs it, and nothing was ever verified: say so plainly.
    const unreachable = status && !status.changed && status.stale === true
      ? (job.target === "cloud" ? "Can't reach your cloud computer right now." : "Can't reach the computer running this right now.")
      : null
    return { ...job, unreachable }
  }) }
}

/** Last known states only, after the whole status read failed. */
export function retainWorkbotRemoteStatuses(
  jobs: WorkbotRemoteJobs,
  lastKnown: (job: WorkbotRemoteJob) => WorkbotRemoteLastKnown | undefined,
): WorkbotRemoteJobs {
  return { ...jobs, jobs: jobs.jobs.map(job => {
    const before = lastKnown(job)
    return before ? { ...job, status: before.status, stale: true, checkedAt: before.checkedAt } : job
  }) }
}

/** Signed-out (needs the person) versus everything else (passing). Never includes tokens or response bodies. */
export function remoteStatusFailure(error: unknown): "signed_out" | "unavailable" {
  return typeof error === "object" && error !== null && "reason" in error && error.reason === "signed_out" ? "signed_out" : "unavailable"
}
