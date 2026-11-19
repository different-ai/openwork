import { createHash } from "node:crypto"
import { isRunning, latestStep, toTranscript, type HeadlessThreadClient } from "@openwork/headless-threads"
import {
  REMOTE_SESSION_STATUS_PREVIEW_MAX_LENGTH,
  type RemoteSessionPending,
  type RemoteSessionPendingSummary,
  type RemoteSessionStatusRequest,
  type RemoteSessionStatusResult,
  type RemoteSessionThreadState,
  type RemoteSessionThreadStatus,
} from "@openwork/types/automations"
import { automationRunnerRowId } from "../automations/repository.js"
import type { RemoteSessionCommand } from "../remote-sessions/commands.js"

/**
 * `remote-session:status`: the compact status of every remote session a
 * caller follows, in one call, whatever runs it.
 *
 * Cost is the point. A desktop or registered client's command is one indexed
 * read for all of them (its runner already reports progress to Den). A Cloud
 * session is a small worker read: the last few messages, the run state and,
 * only while it runs, its pending requests. Callers send back each version
 * they hold, so an unchanged thread answers with its ref and version only, and
 * `waitMs` holds the call, re-checking quietly, until one changes. Settled
 * threads end the wait at once: nothing is coming.
 */

/** Re-checks while a call waits: a desktop task is one indexed read, a Cloud task a few worker requests. */
const COMMAND_RECHECK_MS = 2_000
const CLOUD_RECHECK_MS = 10_000
/** Enough of the tail to see the latest reply and whether it failed. */
const CLOUD_TAIL_MESSAGES = 6
const RETRY_STARTING_MS = 2_000
const RETRY_ACTIVE_MS = 5_000
const UNAVAILABLE_VERSION = "unavailable"

export type RemoteSessionStatusCloudClient = Pick<HeadlessThreadClient, "getThreadSnapshot">
  & Partial<Pick<HeadlessThreadClient, "getThreadWaitingFor" | "getThreadPending">>

/** Cloud for this caller: a client, a lasting reason it cannot be read, or null while it is waking or unreachable. */
export type RemoteSessionStatusCloud =
  | { client: RemoteSessionStatusCloudClient }
  | { error: { code: string; message: string } }
  | null

/** What the status read needs, already scoped to the caller. */
export type RemoteSessionStatusSources = {
  commands: (commandIds: readonly string[]) => Promise<RemoteSessionCommand[]>
  /** Display names of the caller's computers by computerId; read once, and only when a desktop thread changed. */
  computerLabels: () => Promise<ReadonlyMap<string, string>>
  cloud: () => Promise<RemoteSessionStatusCloud>
}

type Projection = Omit<RemoteSessionThreadStatus, "ref" | "changed" | "version" | "computerLabel">
type Observation =
  | { kind: "known"; projection: Projection; version: string }
  | { kind: "stale" }

type Thread = { key: string; ref: string; kind: "command" | "cloud"; known: string | undefined }

function versionOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16)
}

function preview(text: string | null | undefined): string | null {
  const trimmed = text?.trim()
  if (!trimmed) return null
  return trimmed.length > REMOTE_SESSION_STATUS_PREVIEW_MAX_LENGTH
    ? `${trimmed.slice(0, REMOTE_SESSION_STATUS_PREVIEW_MAX_LENGTH - 1)}…`
    : trimmed
}

/**
 * The status line's short form of what a session waits on: the first question's
 * text and option labels, or the permission's title. Its requestId is part of
 * the projection, so a new request changes the version.
 */
export function pendingSummary(pending: RemoteSessionPending | null | undefined): RemoteSessionPendingSummary | null {
  if (!pending) return null
  if (pending.kind === "permission") return { kind: "permission", requestId: pending.requestId, title: pending.title }
  const first = pending.questions[0]
  if (!first) return null
  return {
    kind: "question",
    requestId: pending.requestId,
    question: first.question || first.header,
    options: first.options.map((option) => option.label),
    multiple: first.multiple,
    custom: first.custom,
    questionCount: pending.questions.length,
  }
}

function known(projection: Projection, extra?: unknown): Observation {
  // A heartbeat that only re-confirms the same state is not a change.
  return { kind: "known", projection, version: versionOf({ ...projection, observedAt: undefined, extra }) }
}

function failed(target: Projection["target"], code: string, message: string, now: number): Observation {
  return known({
    target, state: "error", waitingFor: null, title: null, computerId: null, sessionId: null,
    workspaceId: null, messageCount: null, preview: null, latestStep: null, error: { code, message }, observedAt: now, pending: null,
  })
}

export function commandProjection(command: RemoteSessionCommand): Projection {
  const session = command.session
  let state: RemoteSessionThreadState = "running"
  let error: Projection["error"] = null
  if (command.status === "pending" || command.status === "claimed") state = "starting"
  else if (command.status === "expired") {
    state = "error"
    error = { code: "expired", message: "No computer started this task before it expired." }
  } else if (command.status === "failed") {
    state = "error"
    error = command.error ?? { code: "failed", message: "The task couldn't start." }
  } else if (session?.status === "error") {
    state = "error"
    error = session.lastError ?? { code: "session_error", message: "The task stopped with an error." }
  } else if (session?.status === "waiting" || session?.status === "idle") {
    state = session.status
  }
  return {
    target: "desktop",
    state,
    waitingFor: state === "waiting" ? session?.waitingFor ?? null : null,
    title: command.title,
    // The computer that took it, or the one it waits for.
    computerId: command.claimedByRunnerId
      ? automationRunnerRowId({ organizationId: command.organizationId, ownerMemberId: command.ownerMemberId, runnerId: command.claimedByRunnerId })
      : command.targetComputerId,
    sessionId: command.sessionId,
    workspaceId: command.workspaceId,
    messageCount: session?.messageCount ?? null,
    preview: state === "idle" ? preview(session?.finalText) : null,
    // What it ran last only means something while it works.
    latestStep: state === "running" || state === "waiting" ? session?.latestStep ?? null : null,
    error,
    observedAt: session?.observedAt ?? command.updatedAt,
    pending: state === "waiting" ? pendingSummary(session?.pending) : null,
  }
}

async function observeCommands(threads: readonly Thread[], sources: RemoteSessionStatusSources, now: number) {
  const observed = new Map<string, Observation>()
  if (threads.length === 0) return observed
  const commands = new Map((await sources.commands(threads.map((thread) => thread.ref))).map((command) => [command.id, command]))
  for (const thread of threads) {
    const command = commands.get(thread.ref)
    observed.set(thread.key, command
      ? known(commandProjection(command))
      : failed("desktop", "unknown_command", "This task is not available to you.", now))
  }
  return observed
}

async function observeCloudThread(client: RemoteSessionStatusCloudClient, sessionId: string, now: number, signal?: AbortSignal): Promise<Observation> {
  try {
    const snapshot = await client.getThreadSnapshot(sessionId, { limit: CLOUD_TAIL_MESSAGES, signal })
    const running = isRunning(snapshot.status)
    // Two small reads, only while it runs: a settled thread waits on nobody.
    // The pending request itself where the client can read it, so the row can offer its options.
    const pending = running && client.getThreadPending
      ? await client.getThreadPending(sessionId, { signal }).catch(() => null)
      : null
    const waitingFor = pending ? pending.kind : running && client.getThreadWaitingFor && !client.getThreadPending
      ? await client.getThreadWaitingFor(sessionId, { signal }).catch(() => null)
      : null
    const transcript = toTranscript(snapshot)
    let lastUser = snapshot.messages.length - 1
    while (lastUser >= 0 && snapshot.messages[lastUser]?.role !== "user") lastUser -= 1
    const replied = snapshot.messages.slice(lastUser + 1).some((message) => message.role === "assistant")
    const terminalError = !running && replied ? transcript.terminalError : null
    // Idle with no reply yet is the moment between accepting a prompt and starting it.
    const state: RemoteSessionThreadState = terminalError ? "error" : waitingFor ? "waiting" : running || !replied ? "running" : "idle"
    const last = snapshot.messages.at(-1)
    return known({
      target: "cloud",
      state,
      waitingFor: state === "waiting" ? waitingFor : null,
      title: snapshot.title,
      computerId: null,
      sessionId,
      workspaceId: null,
      messageCount: null,
      preview: state === "idle" ? preview(transcript.finalAssistantText) : null,
      latestStep: state === "running" || state === "waiting" ? latestStep(snapshot.messages) : null,
      error: terminalError ? { code: terminalError.name || "session_error", message: terminalError.message || "The task stopped with an error." } : null,
      observedAt: now,
      pending: state === "waiting" ? pendingSummary(pending) : null,
    // A new message changes the version, so an open transcript knows to refresh;
    // a reply still streaming does not, or every check would be a change.
    }, last?.id ?? null)
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
      return failed("cloud", "unknown_session", "This task no longer exists on your cloud computer.", now)
    }
    return { kind: "stale" }
  }
}

async function observeCloud(threads: readonly Thread[], cloud: () => Promise<RemoteSessionStatusCloud>, now: number, signal?: AbortSignal) {
  const observed = new Map<string, Observation>()
  if (threads.length === 0) return observed
  const access = await cloud()
  await Promise.all(threads.map(async (thread) => {
    observed.set(thread.key, access === null
      ? { kind: "stale" }
      : "error" in access
        ? failed("cloud", access.error.code, access.error.message, now)
        : await observeCloudThread(access.client, thread.ref, now, signal))
  }))
  return observed
}

function settled(observation: Observation | undefined) {
  return observation?.kind === "known" && (observation.projection.state === "idle" || observation.projection.state === "error")
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    signal?.addEventListener("abort", done, { once: true })
  })
}

export async function readRemoteSessionStatus(
  body: RemoteSessionStatusRequest,
  sources: RemoteSessionStatusSources,
  options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<RemoteSessionStatusResult> {
  const now = options.now ?? Date.now
  const byKey = new Map<string, Thread>()
  for (const input of body.threads) {
    const kind = input.commandId === undefined ? "cloud" : "command"
    const ref = input.commandId ?? input.sessionId ?? ""
    byKey.set(`${kind}:${ref}`, { key: `${kind}:${ref}`, ref, kind, known: input.version })
  }
  const threads = [...byKey.values()]
  const commands = threads.filter((thread) => thread.kind === "command")
  const clouds = threads.filter((thread) => thread.kind === "cloud")
  // Reuse ready access and lasting errors, but retry a waking workspace on
  // the next Cloud check so a long poll can observe it becoming available.
  let cloudAccess: Promise<RemoteSessionStatusCloud> | null = null
  const cloud = () => cloudAccess ??= sources.cloud().then((access) => {
    if (access === null) cloudAccess = null
    return access
  })

  const changed = (observed: ReadonlyMap<string, Observation>) => threads.some((thread) => {
    const observation = observed.get(thread.key)
    return observation?.kind === "known" && observation.version !== thread.known
  })
  const startedAt = now()
  const deadline = startedAt + (body.waitMs ?? 0)
  const [initialCommands, initialCloud] = await Promise.all([
    observeCommands(commands, sources, startedAt),
    observeCloud(clouds, cloud, startedAt, options.signal),
  ])
  let observed = new Map([...initialCommands, ...initialCloud])
  let cloudCheckedAt = startedAt
  while (!changed(observed) && !threads.every((thread) => settled(observed.get(thread.key))) && !options.signal?.aborted) {
    const remaining = deadline - now()
    if (remaining <= 0) break
    await sleep(Math.min(commands.length > 0 ? COMMAND_RECHECK_MS : CLOUD_RECHECK_MS, remaining), options.signal)
    if (options.signal?.aborted) break
    const checkedAt = now()
    const cloudDue = checkedAt - cloudCheckedAt >= CLOUD_RECHECK_MS
    const [checkedCommands, checkedCloud] = await Promise.all([
      observeCommands(commands, sources, checkedAt),
      cloudDue ? observeCloud(clouds, cloud, checkedAt, options.signal) : [],
    ])
    observed = new Map([...observed, ...checkedCommands, ...checkedCloud])
    if (cloudDue) cloudCheckedAt = checkedAt
  }

  const needsLabels = threads.some((thread) => {
    const observation = observed.get(thread.key)
    return observation?.kind === "known" && observation.version !== thread.known && observation.projection.computerId !== null
  })
  const labels = needsLabels ? await sources.computerLabels().catch(() => new Map<string, string>()) : new Map<string, string>()
  const states = threads.map((thread) => observed.get(thread.key))
  return {
    threads: threads.map((thread): RemoteSessionStatusResult["threads"][number] => {
      const observation = observed.get(thread.key)
      if (observation?.kind !== "known") {
        return { ref: thread.ref, changed: false, version: thread.known ?? UNAVAILABLE_VERSION, stale: true }
      }
      if (observation.version === thread.known) return { ref: thread.ref, changed: false, version: observation.version }
      const { projection } = observation
      return {
        ref: thread.ref,
        changed: true,
        version: observation.version,
        ...projection,
        computerLabel: projection.computerId ? labels.get(projection.computerId) ?? null : null,
      }
    }),
    retryAfterMs: states.every(settled)
      ? null
      : states.some((observation) => observation?.kind === "known" && observation.projection.state === "starting")
        ? RETRY_STARTING_MS
        : RETRY_ACTIVE_MS,
  }
}
