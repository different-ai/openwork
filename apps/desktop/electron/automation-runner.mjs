import { createHeadlessThreadClient } from "@openwork/headless-threads"

const EMPTY_USAGE = { inputTokens: null, outputTokens: null, costMicros: null }
const RUNNER_WORK_POLL_MS = 60_000
/** Inventory is gathered at most this often; it is sent only when it changed. */
const INVENTORY_MIN_INTERVAL_MS = 2 * 60_000
const INVENTORY_WORKSPACE_LIMIT = 50
const INVENTORY_MODEL_LIMIT = 200
const INVENTORY_REQUEST_TIMEOUT_MS = 10_000
const INVENTORY_CONCURRENCY = 4

function serializedError(value) {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
  if (typeof value?.message === "string") return value.message
  if (typeof value?.data?.message === "string") return value.data.message
  try { return JSON.stringify(value) } catch { return String(value) }
}

export function classifyAutomationExecutionError(error) {
  const raw = serializedError(error)
  if (error?.code === "model_access_lost") {
    return { code: "model_access_lost", message: raw }
  }
  if (/ProviderModelNotFoundError/i.test(raw) || /model\s+not\s+found\s*:/i.test(raw)) {
    const identity = raw.match(/model\s+not\s+found\s*:\s*([^.,}\]"\n]+)/i)?.[1]?.trim()
    return {
      code: "model_access_lost",
      message: identity
        ? `The selected model ${identity} is no longer available. Choose a supported model to resume this Automation.`
        : "The selected model is no longer available. Choose a supported model to resume this Automation.",
    }
  }
  return {
    code: "execution_failed",
    message: raw || "Desktop Automation execution failed",
  }
}

/**
 * How long a remote session's first turn is watched before it is reported.
 * Long enough for a provider to reject the request, short enough that the
 * runner slot held during the window is released promptly.
 */
export const REMOTE_SESSION_FIRST_TURN_WINDOW_MS = 20_000
const REMOTE_SESSION_IDLE_GRACE_MS = 5_000
const REMOTE_SESSION_POLL_MS = 500
const REMOTE_SESSION_MESSAGE_LIMIT = 2_000

function isProviderAuthError(error, raw) {
  if (error?.name === "ProviderAuthError") return true
  return /invalid\s+api\s+key|authentication\s+failed|unauthori[sz]ed|\b401\b/i.test(raw)
}

/**
 * Classifies a remote session's first-turn failure. Desktop Automations keep
 * `classifyAutomationExecutionError`; this only adds the credential case.
 */
export function classifyRemoteSessionError(error) {
  const raw = serializedError(error)
  if (isProviderAuthError(error, raw)) {
    return { code: "provider_auth_failed", message: "The model provider rejected its credentials." }
  }
  return classifyAutomationExecutionError(error)
}

function remoteSessionFailureMessage(sessionId, workspaceId, summary, raw) {
  const location = `The first reply failed in local session ${sessionId} (workspace ${workspaceId}).`
  const detail = raw && raw !== summary ? ` Provider error: ${raw}` : ""
  return `${location} ${summary}${detail}`.slice(0, REMOTE_SESSION_MESSAGE_LIMIT)
}

function hasAssistantOutput(message) {
  return (Array.isArray(message?.parts) ? message.parts : []).some((part) => (
    part?.type === "tool"
    || ((part?.type === "text" || part?.type === "reasoning") && typeof part.text === "string" && part.text.trim())
  ))
}

/**
 * Watches a freshly prompted session until its first turn shows a reply, an
 * error, or the window ends. A busy session at the deadline counts as started;
 * only an explicit error or an idle session without output counts as failed.
 */
async function observeRemoteSessionFirstTurn(client, sessionId, workspaceId, options) {
  const windowMs = options.firstTurnWindowMs ?? REMOTE_SESSION_FIRST_TURN_WINDOW_MS
  const idleGraceMs = options.idleGraceMs ?? REMOTE_SESSION_IDLE_GRACE_MS
  const pollIntervalMs = options.pollIntervalMs ?? REMOTE_SESSION_POLL_MS
  const startedAt = Date.now()
  const deadlineAt = startedAt + windowMs
  while (Date.now() < deadlineAt) {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))
    let snapshot = null
    try {
      snapshot = await client.getThreadSnapshot(sessionId, {
        signal: AbortSignal.any([options.signal, timeoutSignal]),
        limit: 50,
      })
    } catch (error) {
      if (options.signal.aborted) throw error
      // The session exists and accepted its prompt; an unreadable snapshot
      // is not evidence of failure, so keep watching until the window ends.
    }
    const assistants = Array.isArray(snapshot?.messages)
      ? snapshot.messages.filter((message) => message?.role === "assistant")
      : []
    const failed = [...assistants].reverse().find((message) => message?.error)
    if (failed) {
      const classified = classifyRemoteSessionError(failed.error)
      return {
        outcome: "failed",
        code: classified.code,
        message: remoteSessionFailureMessage(sessionId, workspaceId, classified.message, serializedError(failed.error)),
      }
    }
    if (assistants.some(hasAssistantOutput)) return { outcome: "replied" }
    if (snapshot?.status?.type === "idle" && Date.now() - startedAt >= idleGraceMs) {
      return {
        outcome: "failed",
        code: "no_reply",
        message: remoteSessionFailureMessage(sessionId, workspaceId, "The session stopped without replying.", ""),
      }
    }
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) break
    await sleep(Math.min(pollIntervalMs, remaining), options.signal)
  }
  return { outcome: "busy" }
}

/**
 * After a remote session is delivered, its progress is followed in the
 * background until it settles so Den callers can see the outcome.
 */
export const REMOTE_SESSION_WATCH = Object.freeze({
  fastPollMs: 3_000,
  fastWindowMs: 5 * 60_000,
  slowPollMs: 15_000,
  keepaliveMs: 60_000,
  maxMs: 6 * 60 * 60_000,
  /** Consecutive idle polls without any reply before the session counts as silent. */
  silentIdlePolls: 3,
})
const REMOTE_SESSION_FINAL_TEXT_LIMIT = 20_000
const REMOTE_SESSION_SNAPSHOT_LIMIT = 200

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Reads the optional engine and model a headless thread may carry. */
export function remoteSessionThreadIdentity(thread) {
  const engine = thread?.engine === "v1" || thread?.engine === "v2" ? thread.engine : undefined
  const raw = isRecord(thread?.model) ? thread.model : null
  const model = raw && typeof raw.providerId === "string" && raw.providerId && typeof raw.modelId === "string" && raw.modelId
    ? {
      providerId: raw.providerId,
      modelId: raw.modelId,
      ...(typeof raw.variant === "string" && raw.variant ? { variant: raw.variant } : {}),
    }
    : undefined
  return { ...(engine ? { engine } : {}), ...(model ? { model } : {}) }
}

function messageText(message) {
  return (Array.isArray(message?.parts) ? message.parts : [])
    .filter((part) => part?.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

/**
 * Reads the pending permission or question for a session through the same
 * engine proxy routes the desktop UI and task recovery already use.
 * Returns undefined when the probe could not be read.
 */
async function readRemoteSessionWaitingFor(local, workspaceId, sessionId, engine, fetchImpl, signal) {
  const workspace = `/workspace/${encodeURIComponent(workspaceId)}`
  const session = encodeURIComponent(sessionId)
  const [permissionPath, questionPath] = engine === "v2"
    ? [`${workspace}/opencode2/api/session/${session}/permission`, `${workspace}/opencode2/api/session/${session}/form`]
    : [`${workspace}/opencode/permission`, `${workspace}/opencode/question`]
  const list = async (requestPath) => {
    const payload = await requestJson(fetchImpl, local.baseUrl, local.token, requestPath, { signal })
    const rows = isRecord(payload) && "data" in payload ? payload.data : payload
    if (!Array.isArray(rows)) throw new Error("Invalid pending request list")
    return rows.filter((row) => isRecord(row) && (engine === "v2" || row.sessionID === sessionId))
  }
  try {
    const [permissions, questions] = await Promise.all([list(permissionPath), list(questionPath)])
    if (permissions.length) return "permission"
    if (questions.length) return "question"
    return null
  } catch (error) {
    if (signal.aborted) throw error
    return undefined
  }
}

/** Turns one local snapshot into the session report Den stores. */
export function remoteSessionObservation(snapshot, waitingFor) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
  let lastUser = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") { lastUser = index; break }
  }
  const replies = messages.slice(lastUser + 1).filter((message) => message?.role === "assistant")
  const failed = [...replies].reverse().find((message) => message?.error)
  const running = snapshot?.status?.type === "busy" || snapshot?.status?.type === "retry"
  if (failed && !running) {
    const classified = classifyRemoteSessionError(failed.error)
    return {
      status: "error",
      error: {
        code: classified.code,
        message: (classified.message || "The session failed").slice(0, REMOTE_SESSION_MESSAGE_LIMIT),
      },
      messageCount: messages.length,
    }
  }
  if (waitingFor) return { status: "waiting", waitingFor, messageCount: messages.length }
  if (running) return { status: "running", messageCount: messages.length }
  const finalText = [...replies].reverse().map(messageText).find(Boolean)
  if (finalText || replies.some(hasAssistantOutput)) {
    return {
      status: "idle",
      ...(finalText ? { finalText: finalText.slice(0, REMOTE_SESSION_FINAL_TEXT_LIMIT) } : {}),
      messageCount: messages.length,
    }
  }
  // Idle with no reply yet: status and messages are read separately, so one
  // such read is not proof the session stopped.
  return { status: "silent", messageCount: messages.length }
}

function observationKey(observation) {
  return JSON.stringify([
    observation.status,
    observation.waitingFor ?? null,
    observation.error?.code ?? null,
    observation.error?.message ?? null,
    observation.finalText ?? null,
  ])
}

/**
 * Follows a delivered remote session and reports its progress until it
 * settles, the watch window ends, or Den stops accepting reports.
 * `report` resolves to false when Den retired the command (404/409).
 */
export async function watchRemoteSession(input) {
  const timing = { ...REMOTE_SESSION_WATCH, ...input.timing }
  const fetchImpl = input.fetchImpl ?? fetch
  const startedAt = Date.now()
  let lastKey = null
  let lastReportedAt = 0
  let silentPolls = 0
  while (!input.signal.aborted && Date.now() - startedAt < timing.maxMs) {
    let observation = null
    try {
      const local = await input.getLocalRuntime()
      if (!local?.baseUrl || !local?.token) throw new Error("The desktop runtime is unavailable")
      const client = createWorkspaceSessionClient(local, input.workspaceId, fetchImpl)
      const snapshot = await client.getThreadSnapshot(input.sessionId, {
        signal: input.signal,
        limit: REMOTE_SESSION_SNAPSHOT_LIMIT,
      })
      const running = snapshot?.status?.type === "busy" || snapshot?.status?.type === "retry"
      if (input.turn && !remoteSessionTurnVisible(snapshot, input.turn)) {
        // A follow-up was just accepted; until its user message shows up the
        // previous turn's answer must not be reported as this turn's.
        observation = { status: "silent", messageCount: Array.isArray(snapshot?.messages) ? snapshot.messages.length : 0 }
      } else {
        const waitingFor = running
          ? await readRemoteSessionWaitingFor(local, input.workspaceId, input.sessionId, input.engine, fetchImpl, input.signal)
          : null
        observation = remoteSessionObservation(snapshot, waitingFor)
      }
    } catch (error) {
      if (input.signal.aborted) return "stopped"
      if (error?.status === 404) {
        observation = {
          status: "error",
          error: { code: "session_not_found", message: "The local session is no longer available." },
        }
      } else {
        input.log?.(`remote session watch read failed: ${serializedError(error)}`)
      }
    }
    if (observation?.status === "silent") {
      silentPolls += 1
      observation = silentPolls >= timing.silentIdlePolls
        ? {
          status: "error",
          error: { code: "no_reply", message: "The session stopped without replying." },
          messageCount: observation.messageCount,
        }
        : null
    } else if (observation) {
      silentPolls = 0
    }
    if (observation) {
      const key = observationKey(observation)
      const terminal = observation.status === "idle" || observation.status === "error"
      if (key !== lastKey || Date.now() - lastReportedAt >= timing.keepaliveMs) {
        let accepted
        try {
          accepted = await input.report({
            ...observation,
            waitingFor: observation.waitingFor ?? null,
            error: observation.error ?? null,
            ...(input.engine ? { engine: input.engine } : {}),
            ...(input.model ? { model: input.model } : {}),
            observedAt: Date.now(),
          })
        } catch (error) {
          if (input.signal.aborted) return "stopped"
          input.log?.(`remote session progress report failed: ${serializedError(error)}`)
          accepted = null
        }
        if (accepted === false) return "retired"
        if (accepted === true) {
          lastKey = key
          lastReportedAt = Date.now()
          if (terminal) return observation.status
        }
      }
    }
    const elapsed = Date.now() - startedAt
    try {
      await sleep(elapsed < timing.fastWindowMs ? timing.fastPollMs : timing.slowPollMs, input.signal)
    } catch {
      return "stopped"
    }
  }
  return input.signal.aborted ? "stopped" : "expired"
}

function lastUserMessageId(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return typeof messages[index].id === "string" ? messages[index].id : null
  }
  return null
}

/** Whether the user message of a just-accepted follow-up is in the snapshot. */
export function remoteSessionTurnVisible(snapshot, turn) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
  if (turn.messageId) return messages.some((message) => message?.role === "user" && message.id === turn.messageId)
  const latest = lastUserMessageId(snapshot)
  return Boolean(latest) && latest !== turn.previousUserMessageId
}

/**
 * Den asks the runner that delivered a remote session to read, follow up on,
 * or stop it. Each request is short and bounded so it never needs the runner
 * slot an Automation run holds.
 */
export const REMOTE_SESSION_REQUEST_TIMEOUT_MS = 15_000
export const REMOTE_SESSION_REQUEST_POLL = Object.freeze({
  /** How often pending requests are fetched while the desktop is in active remote use. */
  pollMs: 2_000,
  /** How long after the last remote-session activity the fast poll continues. */
  activeWindowMs: 30 * 60_000,
})
export const REMOTE_SESSION_CONTROL_CAPABILITY = "remote_session_control_v1"
const TRANSCRIPT_TEXT_LIMIT = 20_000
const TOOL_SUMMARY_LIMIT = 2_000
const TOOL_CALLS_PER_MESSAGE_LIMIT = 200
/** Summaries past this per-message budget are dropped so one message always fits a page. */
const TOOL_SUMMARY_BUDGET_BYTES = 64 * 1024
/** Den accepts 256 KB; the rest is headroom for the result envelope. */
const TRANSCRIPT_PAGE_BUDGET_BYTES = 224 * 1024

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function boundedSummary(value) {
  if (value === undefined || value === null) return { text: null, truncated: false }
  let raw
  if (typeof value === "string") raw = value
  else {
    try { raw = JSON.stringify(value) } catch { raw = String(value) }
  }
  if (typeof raw !== "string") return { text: null, truncated: false }
  return raw.length > TOOL_SUMMARY_LIMIT
    ? { text: raw.slice(0, TOOL_SUMMARY_LIMIT), truncated: true }
    : { text: raw, truncated: false }
}

function transcriptToolCalls(message) {
  const tools = (Array.isArray(message?.parts) ? message.parts : []).filter((part) => part?.type === "tool")
  let budget = TOOL_SUMMARY_BUDGET_BYTES
  return tools.slice(0, TOOL_CALLS_PER_MESSAGE_LIMIT).map((part) => {
    const input = boundedSummary(part.toolInput)
    const output = boundedSummary(part.toolOutput)
    const error = boundedSummary(part.toolError)
    const call = {
      id: String(part.id ?? "").slice(0, 240),
      name: String(part.tool ?? "").slice(0, 240),
      status: typeof part.toolStatus === "string" ? part.toolStatus.slice(0, 60) : null,
      input: input.text,
      output: output.text,
      error: error.text,
      truncated: input.truncated || output.truncated || error.truncated,
    }
    const size = jsonBytes(call)
    if (size > budget) {
      budget = 0
      const listed = { ...call, input: null, output: null, error: null }
      return { ...listed, truncated: listed.truncated || call.input !== null || call.output !== null || call.error !== null }
    }
    budget -= size
    return call
  })
}

function transcriptMessage(message) {
  const text = messageText(message)
  const failure = message?.error ? classifyRemoteSessionError(message.error) : null
  const toolCount = (Array.isArray(message?.parts) ? message.parts : []).filter((part) => part?.type === "tool").length
  return {
    id: String(message.id ?? "").slice(0, 240),
    role: message.role,
    createdAt: Number.isSafeInteger(message?.createdAt) && message.createdAt >= 0 ? message.createdAt : null,
    text: text.slice(0, TRANSCRIPT_TEXT_LIMIT),
    truncated: text.length > TRANSCRIPT_TEXT_LIMIT || toolCount > TOOL_CALLS_PER_MESSAGE_LIMIT,
    toolCalls: transcriptToolCalls(message),
    error: failure
      ? { code: failure.code.slice(0, 60), message: (failure.message || "The turn failed").slice(0, REMOTE_SESSION_MESSAGE_LIMIT) }
      : null,
  }
}

function invalidCursorError(cursor) {
  const error = new Error(`No message ${cursor} in this session; read again without a cursor.`)
  Object.defineProperty(error, "code", { value: "invalid_cursor" })
  return error
}

/**
 * One transcript page. Cursors are message ids, so a page stays stable while
 * the session grows: from "start" pages forward after the cursor, from "end"
 * pages backward before it. Pages hold at most `limit` messages and stop early
 * to stay within Den's result size.
 */
export function remoteSessionTranscriptPage(snapshot, input, waitingFor) {
  const messages = (Array.isArray(snapshot?.messages) ? snapshot.messages : [])
    .filter((message) => message?.role === "user" || message?.role === "assistant")
  const cursorIndex = input.cursor ? messages.findIndex((message) => message.id === input.cursor) : -1
  if (input.cursor && cursorIndex < 0) throw invalidCursorError(input.cursor)
  const forward = input.from === "start"
  const page = []
  let bytes = 0
  let index = forward ? (input.cursor ? cursorIndex + 1 : 0) : (input.cursor ? cursorIndex - 1 : messages.length - 1)
  while (index >= 0 && index < messages.length && page.length < input.limit) {
    const mapped = transcriptMessage(messages[index])
    const size = jsonBytes(mapped)
    if (page.length > 0 && bytes + size > TRANSCRIPT_PAGE_BUDGET_BYTES) break
    page.push(mapped)
    bytes += size
    index += forward ? 1 : -1
  }
  const more = index >= 0 && index < messages.length
  if (!forward) page.reverse()
  const observation = remoteSessionObservation(snapshot, waitingFor)
  const status = observation.status === "silent" ? "idle" : observation.status
  return {
    title: typeof snapshot?.title === "string" ? snapshot.title.slice(0, 240) : null,
    status,
    waitingFor: status === "waiting" ? observation.waitingFor ?? null : null,
    lastError: observation.error ?? null,
    messageCount: messages.length,
    from: forward ? "start" : "end",
    messages: page,
    nextCursor: more && page.length ? (forward ? page.at(-1).id : page[0].id) : null,
  }
}

function modelInputFromAssignment(model) {
  return model
    ? { providerId: model.providerId, modelId: model.modelId, ...(model.variant ? { variant: model.variant } : {}) }
    : undefined
}

/**
 * Runs one Den request against the local session it names. The caller bounds
 * it with `options.signal`. A follow-up returns the turn the progress watcher
 * should wait for.
 */
export async function executeRemoteSessionRequest(assignment, options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const local = await options.getLocalRuntime()
  if (!local?.baseUrl || !local?.token) {
    const error = new Error("The desktop runtime is unavailable")
    Object.defineProperty(error, "code", { value: "runtime_unavailable" })
    throw error
  }
  const client = createWorkspaceSessionClient(local, assignment.workspaceId, fetchImpl)
  if (assignment.action === "read") {
    const snapshot = await client.getThreadSnapshot(assignment.sessionId, { signal: options.signal })
    const running = snapshot?.status?.type === "busy" || snapshot?.status?.type === "retry"
    const waitingFor = running
      ? await readRemoteSessionWaitingFor(local, assignment.workspaceId, assignment.sessionId, assignment.engine ?? undefined, fetchImpl, options.signal)
      : null
    return { action: "read", result: remoteSessionTranscriptPage(snapshot, assignment.input, waitingFor ?? null) }
  }
  if (assignment.action === "send") {
    const model = modelInputFromAssignment(assignment.input.model)
    const before = assignment.input.messageId
      ? null
      : await client.getThreadSnapshot(assignment.sessionId, { signal: options.signal, limit: 50 })
    const accepted = await client.sendTurn(assignment.sessionId, {
      prompt: assignment.input.prompt,
      ...(assignment.input.messageId ? { messageId: assignment.input.messageId } : {}),
      ...(model ? { model } : {}),
      signal: options.signal,
    })
    return {
      action: "send",
      result: { messageId: accepted.messageId ?? null, alreadyPresent: accepted.alreadyPresent === true },
      turn: { messageId: accepted.messageId ?? null, previousUserMessageId: before ? lastUserMessageId(before) : null },
      model,
    }
  }
  if (assignment.action === "stop") {
    if (assignment.input.messageId) {
      const snapshot = await client.getThreadSnapshot(assignment.sessionId, { signal: options.signal, limit: 50 })
      if (lastUserMessageId(snapshot) !== assignment.input.messageId) {
        return { action: "stop", result: { stopped: false, reason: "different_turn" } }
      }
    }
    const aborted = await client.abortThread(assignment.sessionId, { signal: options.signal })
    return { action: "stop", result: { stopped: aborted.accepted === true, reason: null } }
  }
  const error = new Error(`Unsupported remote-session request ${String(assignment.action)}`)
  Object.defineProperty(error, "code", { value: "unsupported_request" })
  throw error
}

/** The failure Den stores for a request; never echoes more than 2,000 characters. */
export function classifyRemoteSessionRequestError(error, timedOut) {
  if (timedOut) {
    return { code: "desktop_timeout", message: "The desktop did not finish the request in time." }
  }
  if (error?.status === 404) {
    return { code: "unknown_session", message: "The local session is no longer available." }
  }
  if (["invalid_cursor", "runtime_unavailable", "unsupported_request"].includes(error?.code)) {
    return { code: error.code, message: serializedError(error).slice(0, REMOTE_SESSION_MESSAGE_LIMIT) }
  }
  return {
    code: "request_failed",
    message: (serializedError(error) || "The desktop request failed").slice(0, REMOTE_SESSION_MESSAGE_LIMIT),
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason instanceof Error ? signal.reason : new Error("Automation run cancelled"))
    }
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
  })
}

async function requestJson(fetchImpl, baseUrl, token, requestPath, options = {}) {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}${requestPath}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  })
  const text = await response.text()
  let payload = null
  try { payload = text ? JSON.parse(text) : null } catch { /* handled below */ }
  if (!response.ok) {
    const error = new Error(String(payload?.message ?? payload?.error ?? `Request returned ${response.status}`))
    Object.defineProperty(error, "status", { value: response.status })
    throw error
  }
  return payload
}

function createWorkspaceSessionClient(local, workspaceId, fetchImpl) {
  return createHeadlessThreadClient({
    baseUrl: local.baseUrl,
    workspaceId,
    token: local.token,
    // Automation run receipts own recovery; desktop restart must not independently
    // resume an occurrence that its scheduler may already have settled or retried.
    fetch: (input, init) => {
      const headers = new Headers(init?.headers)
      headers.set("x-openwork-task-recovery", "off")
      return fetchImpl(input, { ...init, headers })
    },
    requestTimeoutMs: 0,
  })
}

function assistantResult(snapshot) {
  const assistants = Array.isArray(snapshot?.messages)
    ? snapshot.messages.filter((message) => message?.role === "assistant")
    : []
  let resultSummary = null
  let inputTokens = 0
  let outputTokens = 0
  let sawInput = false
  let sawOutput = false
  let sawCompletedTool = false
  for (const message of assistants) {
    const usage = message?.usage
    if (Number.isFinite(usage?.inputTokens)) { inputTokens += Number(usage.inputTokens); sawInput = true }
    if (Number.isFinite(usage?.outputTokens)) { outputTokens += Number(usage.outputTokens); sawOutput = true }
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        resultSummary = part.text.trim().slice(0, 20_000)
      }
      if (part?.type === "tool" && part?.toolStatus === "completed") {
        sawCompletedTool = true
      }
    }
  }
  return {
    resultSummary,
    hasCompletedOutput: Boolean(resultSummary) || sawCompletedTool,
    usage: {
      inputTokens: sawInput ? inputTokens : null,
      outputTokens: sawOutput ? outputTokens : null,
      costMicros: null,
    },
  }
}

function assistantFailure(snapshot) {
  const messages = Array.isArray(snapshot?.messages) ? snapshot.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== "assistant" || !message.error) continue
    return classifyAutomationExecutionError(message.error)
  }
  return null
}

/**
 * Picks the assignment's target workspace.
 *
 * A pinned workspace must exist locally: running the Automation in whatever
 * workspace happens to be active would silently retarget it, which is the
 * exact bug pinning exists to prevent. Unpinned (legacy) assignments keep the
 * historical active-workspace fallback.
 */
export function resolveAssignmentWorkspace(listed, pinnedWorkspaceId) {
  const workspaces = Array.isArray(listed?.items) ? listed.items : []
  if (pinnedWorkspaceId) {
    const pinned = workspaces.find((item) => item?.id === pinnedWorkspaceId)
    if (!pinned?.id) {
      const error = new Error(`The Automation's pinned workspace is not available on this desktop`)
      Object.defineProperty(error, "code", { value: "execution_runtime_unavailable" })
      throw error
    }
    return pinned
  }
  const workspace = workspaces.find((item) => item?.id === listed?.activeId) ?? workspaces[0]
  if (!workspace?.id) throw new Error("No local workspace is available")
  return workspace
}

/**
 * Ids of the workspaces this desktop has, or null when the local runtime
 * cannot say (it is starting, or unreachable).
 */
export async function listLocalWorkspaceIds(options) {
  const local = await options.getLocalRuntime()
  if (!local?.baseUrl || !local?.token) return null
  const listed = await requestJson(options.fetchImpl ?? fetch, local.baseUrl, local.token, "/workspaces", { signal: options.signal })
  const items = Array.isArray(listed?.items) ? listed.items : []
  return new Set(items.flatMap((item) => (typeof item?.id === "string" && item.id ? [item.id] : [])))
}

/**
 * Picks the first work item this desktop can run. A member may have many
 * desktops and every one of them sees the same work, so a run pinned to a
 * workspace this desktop lacks is left for the desktop that has it rather
 * than claimed and failed here. Local workspaces are listed only when a pinned
 * item appears; when they cannot be listed, pinned items wait for the next poll.
 */
export async function selectRunnableWorkItem(items, listWorkspaceIds) {
  let workspaceIds
  for (const item of Array.isArray(items) ? items : []) {
    if (item?.kind === "remote_session_create") {
      if (item.commandId) return item
      continue
    }
    if (!item?.runId) continue
    if (!item.workspaceId) return item
    if (workspaceIds === undefined) workspaceIds = await listWorkspaceIds().catch(() => null)
    if (workspaceIds?.has(item.workspaceId)) return item
  }
  return null
}

/** Runs the assignment as a normal visible local OpenWork thread. */
export async function executeDesktopAutomation(assignment, options) {
  const local = await options.getLocalRuntime()
  if (!local?.baseUrl || !local?.token) throw new Error("The desktop runtime is unavailable")
  const localRequest = (requestPath, request = {}) => requestJson(
    options.fetchImpl ?? fetch,
    local.baseUrl,
    local.token,
    requestPath,
    { ...request, signal: options.signal },
  )
  const listed = await localRequest("/workspaces")
  const workspace = resolveAssignmentWorkspace(listed, assignment.workspaceId ?? null)
  const workspaceId = String(workspace.id)
  const client = createWorkspaceSessionClient(local, workspaceId, options.fetchImpl ?? fetch)
  const created = await client.createThread({
    title: `Automation: ${assignment.automationName}`.slice(0, 120),
    ...(assignment.instructions ? { prompt: assignment.instructions } : {}),
    model: assignment.model,
    signal: options.signal,
  })
  const sessionId = created.id
  // The assignment signal is already aborted when this listener runs. Do not
  // pass it to the cleanup request or fetch can reject before reaching OpenCode.
  const abort = () => void client.abortThread(sessionId).catch(() => undefined)
  options.signal.addEventListener("abort", abort, { once: true })
  try {
    const startedAt = Date.now()
    const deadlineAt = startedAt + assignment.timeoutMs
    while (true) {
      if (Date.now() > deadlineAt) throw new Error("Desktop Automation execution timed out")
      // The wall-clock check above only runs between awaits. A machine that
      // suspends mid-request can leave this socket half-open with no error,
      // which would make the assignment timeout unreachable: bound each poll
      // by the remaining execution budget so the deadline always fires.
      const timeoutSignal = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()))
      let snapshot
      try {
        snapshot = await client.getThreadSnapshot(sessionId, {
          signal: AbortSignal.any([options.signal, timeoutSignal]),
          limit: 200,
        })
      } catch (error) {
        if (!options.signal.aborted && (timeoutSignal.aborted || Date.now() >= deadlineAt)) throw new Error("Desktop Automation execution timed out")
        throw error
      }
      const output = assistantResult(snapshot)
      const snapshotError = assistantFailure(snapshot)
      if (snapshotError) {
        const error = new Error(snapshotError.message)
        Object.defineProperty(error, "code", { value: snapshotError.code })
        throw error
      }
      if (snapshot?.status?.type === "idle" && output.hasCompletedOutput) {
        return {
          sessionId,
          workspaceId,
          resultSummary: output.resultSummary,
          usage: output.usage,
        }
      }
      if (snapshot?.status?.type === "idle" && Date.now() - startedAt > 10_000) {
        throw new Error("Desktop Automation finished without an assistant result")
      }
      await sleep(500, options.signal)
    }
  } catch (error) {
    const contextualError = error instanceof Error ? error : new Error(serializedError(error))
    if (Reflect.get(contextualError, "sessionId") === undefined) {
      Object.defineProperty(contextualError, "sessionId", { value: sessionId })
    }
    if (Reflect.get(contextualError, "workspaceId") === undefined) {
      Object.defineProperty(contextualError, "workspaceId", { value: workspaceId })
    }
    throw contextualError
  } finally {
    options.signal.removeEventListener("abort", abort)
  }
}

function trimmedText(value, limit) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null
}

/** Runs `task` over `items` with at most `limit` in flight, preserving order. */
async function mapBounded(items, limit, task) {
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function modelsFromV1Providers(payload) {
  const providers = Array.isArray(payload?.all) ? payload.all : []
  const connected = Array.isArray(payload?.connected) ? new Set(payload.connected) : null
  const models = []
  for (const provider of providers) {
    const providerId = trimmedText(provider?.id, 160)
    if (!providerId || (connected && !connected.has(providerId))) continue
    const entries = provider?.models && typeof provider.models === "object" ? Object.entries(provider.models) : []
    for (const [key, model] of entries) {
      const modelId = trimmedText(model?.id, 160) ?? trimmedText(key, 160)
      if (!modelId) continue
      models.push({ providerId, modelId, name: trimmedText(model?.name, 200) ?? modelId })
    }
  }
  return models
}

function modelsFromV2Catalog(payload) {
  const items = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : []
  return items.flatMap((model) => {
    const providerId = trimmedText(model?.providerID, 160)
    const modelId = trimmedText(model?.id, 160)
    if (!providerId || !modelId) return []
    return [{ providerId, modelId, name: trimmedText(model?.name, 200) ?? modelId }]
  })
}

function defaultModelFrom(payload) {
  const model = payload?.model
  const providerId = trimmedText(model?.providerID, 160)
  const modelId = trimmedText(model?.modelID, 160)
  if (!providerId || !modelId) return null
  const variant = trimmedText(model?.variant, 60)
  return { providerId, modelId, ...(variant ? { variant } : {}) }
}

/**
 * What this desktop has for remote-session callers: a friendly computer
 * label and, per workspace, its engine, default model and usable models.
 * Every source is optional: an endpoint this openwork-server lacks (404) or
 * that fails reads as "nothing known" rather than failing the report. Returns
 * null when the local runtime is not up yet.
 */
export async function collectDesktopInventory(options) {
  const local = await options.getLocalRuntime()
  if (!local?.baseUrl || !local?.token) return null
  const computer = await options.describeComputer()
  const localRequest = (requestPath) => requestJson(options.fetchImpl ?? fetch, local.baseUrl, local.token, requestPath, {
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(INVENTORY_REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(INVENTORY_REQUEST_TIMEOUT_MS),
  })
  const optional = (requestPath) => localRequest(requestPath).catch(() => null)
  const listed = await localRequest("/workspaces")
  const status = await optional("/experimental/engine-v2-preview/status")
  const engine = status?.enabled === true && status?.chatRouting === true ? "v2" : "v1"
  const items = (Array.isArray(listed?.items) ? listed.items : [])
    .filter((item) => typeof item?.id === "string" && item.id)
    .slice(0, INVENTORY_WORKSPACE_LIMIT)
  const workspaces = await mapBounded(items, INVENTORY_CONCURRENCY, async (item) => {
    const base = `/workspace/${encodeURIComponent(item.id)}`
    const [defaults, catalog] = await Promise.all([
      optional(`${base}/default-model`),
      optional(engine === "v2" ? `${base}/opencode2/api/model` : `${base}/opencode/provider`),
    ])
    const models = engine === "v2" ? modelsFromV2Catalog(catalog) : modelsFromV1Providers(catalog)
    return {
      workspaceId: String(item.id).slice(0, 240),
      name: trimmedText(item.displayName, 120) ?? trimmedText(item.name, 120) ?? "Workspace",
      active: item.id === listed?.activeId,
      engine,
      defaultModel: defaultModelFrom(defaults),
      models: models.slice(0, INVENTORY_MODEL_LIMIT),
    }
  })
  return {
    computer: {
      label: trimmedText(computer?.label, 120) ?? "Computer",
      platform: computer.platform,
      appVersion: trimmedText(computer?.appVersion, 80) ?? "unknown",
    },
    workspaces,
  }
}

/**
 * Describes this computer for remote-session callers. macOS has a
 * user-visible computer name (System Settings > General > Sharing); other
 * platforms, and a Mac whose name cannot be read, use the host name.
 */
export function createComputerDescriber(options) {
  return async () => {
    const named = options.platform === "darwin" && options.readComputerName
      ? trimmedText(await options.readComputerName().catch(() => null), 120)
      : null
    let hostname = null
    try { hostname = trimmedText(options.hostname(), 120) } catch { /* unnamed host */ }
    return {
      label: named ?? hostname ?? "Computer",
      platform: options.platform,
      appVersion: options.appVersion,
    }
  }
}

function workspaceUnavailable(workspaceId) {
  const error = new Error(`Workspace ${workspaceId} is not available on this desktop`)
  Object.defineProperty(error, "code", { value: "workspace_unavailable" })
  return error
}

/** Delivers a remote command as a normal visible local OpenWork session. */
export async function executeDesktopRemoteSession(assignment, options) {
  const local = await options.getLocalRuntime()
  if (!local?.baseUrl || !local?.token) throw new Error("The desktop runtime is unavailable")
  const localRequest = (requestPath, request = {}) => requestJson(
    options.fetchImpl ?? fetch,
    local.baseUrl,
    local.token,
    requestPath,
    { ...request, signal: options.signal },
  )
  const listed = await localRequest("/workspaces")
  let workspace
  try {
    // The caller's chosen workspace must exist here, exactly like an
    // Automation's pinned workspace; never fall back to the active one.
    workspace = resolveAssignmentWorkspace(listed, assignment.workspaceId ?? null)
  } catch (error) {
    if (assignment.workspaceId) throw workspaceUnavailable(assignment.workspaceId)
    throw error
  }
  const workspaceId = String(workspace.id)
  const client = createWorkspaceSessionClient(local, workspaceId, options.fetchImpl ?? fetch)
  let sessionId = null
  try {
    const created = await client.createThread({
      title: assignment.title,
      ...(assignment.prompt ? { prompt: assignment.prompt } : {}),
      ...(assignment.model ? { model: assignment.model } : {}),
      signal: options.signal,
    })
    sessionId = created.id
    const started = created.started
    const firstTurn = started
      ? await observeRemoteSessionFirstTurn(client, sessionId, workspaceId, options)
      : { outcome: "not_started" }
    return { sessionId, workspaceId, started, firstTurn, ...remoteSessionThreadIdentity(created) }
  } catch (error) {
    const contextualError = error instanceof Error ? error : new Error(serializedError(error))
    if (sessionId && Reflect.get(contextualError, "sessionId") === undefined) {
      Object.defineProperty(contextualError, "sessionId", { value: sessionId })
    }
    if (Reflect.get(contextualError, "workspaceId") === undefined) {
      Object.defineProperty(contextualError, "workspaceId", { value: workspaceId })
    }
    throw contextualError
  }
}

/**
 * The runner sends its bearer token to whatever base URL it is configured
 * with, and the configuration arrives over IPC from the renderer. A
 * compromised renderer must not be able to point the token at an arbitrary
 * endpoint: only https origins are accepted, with plain http reserved for
 * loopback development hosts.
 */
export function normalizeRunnerBaseUrl(value) {
  let parsed
  try { parsed = new URL(String(value)) } catch { return null }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)
    || parsed.hostname.endsWith(".localhost")
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null
  if (parsed.username || parsed.password) return null
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "")
}

/**
 * Runner credentials are opaque to the renderer but carry a server-signed
 * audience in their payload. The main process does not need the Den signing
 * key here: changing the audience also changes the token, so a renderer cannot
 * redirect an intact credential without failing this binding check.
 */
function runnerTokenBinding(token) {
  try {
    const [payload, signature, extra] = String(token).split(".")
    if (!payload || !signature || extra) return null
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    const scope = [decoded?.o, decoded?.m, decoded?.r].every((value) => typeof value === "string")
      ? `${decoded.o}\n${decoded.m}\n${decoded.r}`
      : null
    // Den signs the capabilities it accepted at registration into the token.
    const capabilities = Array.isArray(decoded?.c) ? decoded.c.filter((value) => typeof value === "string") : []
    if (decoded?.v === 1) return { version: 1, audience: null, scope, capabilities }
    if (decoded?.v !== 2 || typeof decoded.a !== "string") return null
    const audience = normalizeRunnerBaseUrl(decoded.a)
    return audience ? { version: 2, audience, scope, capabilities } : null
  } catch {
    return null
  }
}

export function runnerTokenAudience(token) {
  return runnerTokenBinding(token)?.audience ?? null
}

const RUNNER_OFF_VALUES = new Set(["off", "0", "false", "disabled"])

/**
 * `OPENWORK_AUTOMATION_RUNNER=off` keeps this desktop from claiming any
 * Automation run or remote-session command. Eval desktops set it by default:
 * Den hands a member's work to any of that member's runners, so a test
 * desktop signed in to a real account would otherwise take real work.
 */
export function automationRunnerDisabledReason(env) {
  const value = String(env?.OPENWORK_AUTOMATION_RUNNER ?? "").trim().toLowerCase()
  return RUNNER_OFF_VALUES.has(value) ? `OPENWORK_AUTOMATION_RUNNER=${value}` : null
}

export function createDesktopAutomationRunner(options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const random = options.random ?? Math.random
  const waitBeforeReconnect = options.waitBeforeReconnect ?? sleep
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 10_000
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 8_000
  const heartbeatMissLimit = options.heartbeatMissLimit ?? 3
  const workPollTimeoutMs = options.workPollTimeoutMs ?? 30_000
  const lifecycleRequestTimeoutMs = options.lifecycleRequestTimeoutMs ?? 30_000
  const requestPoll = { ...REMOTE_SESSION_REQUEST_POLL, ...options.remoteSessionRequestPoll }
  const remoteRequestTimeoutMs = options.remoteSessionRequestTimeoutMs ?? REMOTE_SESSION_REQUEST_TIMEOUT_MS
  const legacyBaseUrls = new Set((options.legacyBaseUrls ?? [])
    .map((value) => normalizeRunnerBaseUrl(value))
    .filter(Boolean))
  let generation = 0
  let current = null
  let pendingConfiguration = null
  let stopped = false
  const rejectedCredentials = new Set()

  const inventoryMinIntervalMs = options.inventoryMinIntervalMs ?? INVENTORY_MIN_INTERVAL_MS
  const now = options.now ?? Date.now

  /**
   * Tells Den what this desktop has, so remote-session callers can choose a
   * computer, workspace and model. Sent once per credential (registration)
   * and then only when it changed, gathered at most once per interval. Den
   * versions without the endpoint answer 404 and are not asked again under
   * this credential. A failure never affects polling for work.
   */
  const reportInventory = (state) => {
    if (!options.describeComputer || state.inventoryUnsupported || state.inventoryInFlight || !isCurrent(state)) return
    if (state.inventoryCheckedAt !== null && now() - state.inventoryCheckedAt < inventoryMinIntervalMs) return
    state.inventoryCheckedAt = now()
    state.inventoryInFlight = (async () => {
      try {
        const inventory = await collectDesktopInventory({
          getLocalRuntime: options.getLocalRuntime,
          describeComputer: options.describeComputer,
          fetchImpl,
          signal: state.controller.signal,
        })
        if (!inventory || !isCurrent(state)) {
          // The local runtime is still starting: try again on the next poll.
          if (!inventory) state.inventoryCheckedAt = null
          return
        }
        const key = JSON.stringify(inventory)
        if (key === state.inventoryKey) return
        await runnerRequest(state, "/v1/automation-runner/inventory", {
          method: "PUT",
          body: inventory,
          signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
        })
        state.inventoryKey = key
      } catch (error) {
        if (error?.status === 404) state.inventoryUnsupported = true
        else options.log?.(`runner inventory report failed: ${serializedError(error)}`)
      } finally {
        state.inventoryInFlight = null
        options.onInventoryReported?.()
      }
    })()
  }

  const credentialKey = (configuration) => `${configuration.baseUrl}\n${configuration.token}`
  const isCurrent = (state) => !stopped
    && current === state
    && current.generation === state.generation
    && !state.retired
  const retire = (state, reason) => {
    if (state.retired) return
    state.retired = true
    state.controller.abort(reason)
    state.active?.controller.abort(reason)
    if (current === state) current = null
  }

  const rejectCredential = (state, status) => {
    if (state.credentialRejected) return
    state.credentialRejected = true
    const key = credentialKey(state.configuration)
    rejectedCredentials.add(key)
    const affectedCurrent = current === state || (current && credentialKey(current.configuration) === key)
      ? current
      : null
    retire(state, new Error(`Automation runner credential rejected with HTTP ${status}`))
    if (affectedCurrent && affectedCurrent !== state) {
      affectedCurrent.credentialRejected = true
      retire(affectedCurrent, new Error(`Automation runner credential rejected with HTTP ${status}`))
    }
    if (pendingConfiguration && credentialKey(pendingConfiguration) === key) pendingConfiguration = null
    options.log?.(`runner credential rejected with HTTP ${status}`)
    if (affectedCurrent) options.onCredentialRejected?.()
    if (affectedCurrent && pendingConfiguration) {
      const next = pendingConfiguration
      pendingConfiguration = null
      activateConfiguration(next)
    }
  }

  const runnerRequest = async (state, requestPath, request = {}) => {
    if (!isCurrent(state)) {
      throw state.controller.signal.reason ?? new Error("Automation runner generation retired")
    }
    try {
      return await requestJson(
        fetchImpl,
        state.configuration.baseUrl,
        state.configuration.token,
        requestPath,
        {
          ...request,
          signal: request.signal
            ? AbortSignal.any([state.controller.signal, request.signal])
            : state.controller.signal,
        },
      )
    } catch (error) {
      if ([401, 403].includes(error?.status)) rejectCredential(state, error.status)
      throw error
    }
  }

  const heartbeat = async (state, active) => {
    if (state.active !== active || !isCurrent(state)) return
    const response = await runnerRequest(
      state,
      `/v1/automation-runs/${encodeURIComponent(active.assignment.runId)}/heartbeat`,
      {
        method: "POST",
        body: { attempt: active.assignment.attempt },
        // Bounded below the interval so a hung probe settles before the next
        // one is due instead of pinning the lease refresh on a dead socket.
        signal: AbortSignal.timeout(heartbeatTimeoutMs),
      },
    )
    if (state.active === active && (response.cancelRequested || response.leaseValid !== true)) {
      active.controller.abort(new Error("Automation run cancelled or lease lost"))
    }
  }

  let activateConfiguration

  const runAssignment = async (state, assignment) => {
    const controller = new AbortController()
    const active = { assignment, controller }
    state.active = active
    let sequence = 0
    const event = (type, payload) => runnerRequest(
      state,
      `/v1/automation-runs/${encodeURIComponent(assignment.runId)}/events`,
      {
        method: "POST",
        body: { attempt: assignment.attempt, sequence: ++sequence, type, payload, createdAt: Date.now() },
        signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
      },
    )
    // Self-scheduling instead of setInterval: the next probe is armed only
    // after the current one settles, so a slow heartbeat can never overlap
    // the next tick. One transient failure must not kill a healthy run, so
    // the run aborts only after consecutive misses outlast the lease.
    let heartbeatTimer = null
    let heartbeatStopped = false
    let heartbeatMisses = 0
    const heartbeatTick = async () => {
      try {
        await heartbeat(state, active)
        heartbeatMisses = 0
      } catch (error) {
        heartbeatMisses += 1
        if (heartbeatMisses >= heartbeatMissLimit) {
          controller.abort(new Error(`Automation run heartbeat failed ${heartbeatMisses} times: ${serializedError(error)}`))
          return
        }
        options.log?.(`runner heartbeat missed (${heartbeatMisses}/${heartbeatMissLimit}): ${serializedError(error)}`)
      }
      if (!heartbeatStopped && state.active === active && !controller.signal.aborted) scheduleHeartbeat()
    }
    const scheduleHeartbeat = () => {
      heartbeatTimer = setTimeout(() => void heartbeatTick(), heartbeatIntervalMs)
    }
    scheduleHeartbeat()
    let result
    try {
      await event("user", { text: assignment.instructions, executionTarget: "desktop" })
      const output = await executeDesktopAutomation(assignment, {
        getLocalRuntime: options.getLocalRuntime,
        fetchImpl,
        signal: controller.signal,
      })
      if (output.resultSummary) await event("assistant", {
        text: output.resultSummary,
        sessionId: output.sessionId,
        workspaceId: output.workspaceId,
      })
      await event("usage", output.usage)
      result = { status: "succeeded", ...output, error: null }
    } catch (error) {
      const cancelled = controller.signal.aborted && String(controller.signal.reason).toLowerCase().includes("cancel")
      const classified = classifyAutomationExecutionError(error)
      result = {
        status: cancelled ? "cancelled" : "failed",
        sessionId: typeof error?.sessionId === "string" ? error.sessionId : null,
        workspaceId: typeof error?.workspaceId === "string" ? error.workspaceId : null,
        resultSummary: null,
        usage: EMPTY_USAGE,
        error: {
          code: cancelled ? "cancelled" : classified.code,
          message: cancelled
            ? (error instanceof Error ? error.message : "Automation run cancelled")
            : classified.message,
          retryable: false,
        },
      }
    } finally {
      heartbeatStopped = true
      clearTimeout(heartbeatTimer)
    }
    // Terminal delivery must terminate: reconcile (and with it the whole
    // runner) waits on this step, so a hung or transiently failing request
    // here would otherwise wedge the desktop until the app restarts. Each
    // request gets its own deadline plus one retry, and a failed terminal
    // event never skips the completion POST.
    const deliver = async (label, send) => {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          await send()
          return
        } catch (error) {
          const retry = attempt === 1 && isCurrent(state)
          options.log?.(`runner ${label} delivery failed${retry ? ", retrying" : ""}: ${serializedError(error)}`)
          if (!retry) return
        }
      }
    }
    try {
      await deliver("terminal event", () => event("terminal", {
        status: result.status,
        executionTarget: "desktop",
        sessionId: result.sessionId,
      }))
      await deliver("completion", () => runnerRequest(state, `/v1/automation-runs/${encodeURIComponent(assignment.runId)}/complete`, {
        method: "POST",
        body: { ...result, attempt: assignment.attempt },
        signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
      }))
    } finally {
      if (state.active === active) state.active = null
      if (isCurrent(state) && pendingConfiguration) {
        const next = pendingConfiguration
        pendingConfiguration = null
        activateConfiguration(next)
      }
    }
  }

  const runRemoteSessionCommand = async (state, assignment) => {
    const controller = new AbortController()
    const active = { assignment, controller }
    state.active = active
    let result
    let delivered = null
    try {
      const output = await executeDesktopRemoteSession(assignment, {
        getLocalRuntime: options.getLocalRuntime,
        fetchImpl,
        signal: controller.signal,
        firstTurnWindowMs: options.remoteSessionFirstTurnWindowMs,
        idleGraceMs: options.remoteSessionIdleGraceMs,
        pollIntervalMs: options.remoteSessionPollIntervalMs,
      })
      // Released Den rejects session ids on a failed completion, so the
      // failure message carries them for a person to find the local session.
      result = output.firstTurn.outcome === "failed"
        ? { status: "failed", error: { code: output.firstTurn.code, message: output.firstTurn.message } }
        : {
          status: "delivered",
          sessionId: output.sessionId,
          workspaceId: output.workspaceId,
          resultSummary: "Remote session created",
        }
      // A session without a first turn has nothing to follow.
      if (result.status === "delivered" && output.started) delivered = output
    } catch (error) {
      result = {
        status: "failed",
        error: {
          code: error?.code === "workspace_unavailable" ? "workspace_unavailable" : "execution_failed",
          message: (serializedError(error) || "Remote session creation failed").slice(0, 2_000),
        },
      }
    }
    try {
      await runnerRequest(state, `/v1/remote-session-commands/${encodeURIComponent(assignment.commandId)}/complete`, {
        method: "POST",
        body: result,
        signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
      })
      if (result.status === "delivered") state.lastRemoteActivityAt = Date.now()
      if (delivered) {
        startRemoteSessionWatch(state, assignment.commandId, {
          sessionId: delivered.sessionId,
          workspaceId: delivered.workspaceId,
          engine: delivered.engine,
          model: delivered.model ?? modelInputFromAssignment(assignment.model),
        })
      }
    } finally {
      if (state.active === active) state.active = null
      if (isCurrent(state) && pendingConfiguration) {
        const next = pendingConfiguration
        pendingConfiguration = null
        activateConfiguration(next)
      }
    }
  }

  /**
   * Follows a delivered session in the background. It holds no runner slot,
   * so the work loop keeps claiming; retiring the generation (configuration
   * change, credential rejection, or stop) aborts it. Watchers live only in
   * memory: a desktop restart stops reporting. A follow-up restarts the
   * command's watcher for the new turn.
   */
  const startRemoteSessionWatch = (state, commandId, session, turn = null) => {
    const commandPath = `/v1/remote-session-commands/${encodeURIComponent(commandId)}/session`
    state.watchControllers.get(commandId)?.abort(new Error("Remote session watch restarted"))
    const controller = new AbortController()
    state.watchControllers.set(commandId, controller)
    const watch = watchRemoteSession({
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      ...(session.engine ? { engine: session.engine } : {}),
      ...(session.model ? { model: session.model } : {}),
      ...(turn ? { turn } : {}),
      getLocalRuntime: options.getLocalRuntime,
      fetchImpl,
      signal: AbortSignal.any([state.controller.signal, controller.signal]),
      timing: options.remoteSessionWatch,
      log: options.log,
      report: async (body) => {
        try {
          await runnerRequest(state, commandPath, {
            method: "POST",
            body,
            signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
          })
          return true
        } catch (error) {
          // An older Den without this route, or a command that is no longer
          // delivered: stop reporting rather than retrying forever.
          if (error?.status === 404 || error?.status === 409) return false
          throw error
        }
      },
    })
    state.watchers.add(watch)
    watch
      .then((outcome) => options.log?.(`remote session ${commandId} watch ended: ${outcome}`))
      .catch((error) => options.log?.(`remote session ${commandId} watch failed: ${serializedError(error)}`))
      .finally(() => {
        state.watchers.delete(watch)
        if (state.watchControllers.get(commandId) === controller) state.watchControllers.delete(commandId)
        // Remote use keeps request polling fast for a while after the watch ends.
        state.lastRemoteActivityAt = Math.max(state.lastRemoteActivityAt, Date.now())
      })
  }

  /** Claims, runs, and answers one Den request without taking the runner slot. */
  const runRemoteSessionRequest = async (state, requestId) => {
    const requestPath = `/v1/remote-session-requests/${encodeURIComponent(requestId)}`
    let claimed
    try {
      claimed = await runnerRequest(state, `${requestPath}/claim`, {
        method: "POST",
        body: {},
        signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
      })
    } catch (error) {
      if (error?.status === 409) return
      throw error
    }
    const assignment = claimed?.assignment
    if (!assignment?.requestId) return
    state.lastRemoteActivityAt = Date.now()
    const remainingMs = Number(assignment.expiresAt) - Date.now()
    let body
    let followUp = null
    if (!(remainingMs > 0)) {
      // Never act on a stale request, least of all a follow-up nobody awaits.
      body = { status: "failed", error: { code: "request_expired", message: "The request expired before the desktop ran it." } }
    } else {
      const timeout = AbortSignal.timeout(Math.min(remoteRequestTimeoutMs, remainingMs))
      try {
        const outcome = await executeRemoteSessionRequest(assignment, {
          getLocalRuntime: options.getLocalRuntime,
          fetchImpl,
          signal: AbortSignal.any([state.controller.signal, timeout]),
        })
        body = { status: "done", outcome: { action: outcome.action, result: outcome.result } }
        if (outcome.action === "send" && !outcome.result.alreadyPresent) followUp = outcome
      } catch (error) {
        if (!isCurrent(state)) return
        body = { status: "failed", error: classifyRemoteSessionRequestError(error, timeout.aborted) }
      }
    }
    const complete = (payload) => runnerRequest(state, `${requestPath}/complete`, {
      method: "POST",
      body: payload,
      signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
    })
    try {
      await complete(body)
    } catch (error) {
      if (error?.status !== 400 || body.status !== "done") throw error
      // Den rejected the result itself (for example its size): report why.
      await complete({ status: "failed", error: { code: "result_rejected", message: "Den rejected the desktop's result." } })
    }
    // Den marks the command running again on completion; only then may the
    // watcher report, so it cannot be overwritten.
    if (followUp) {
      startRemoteSessionWatch(state, assignment.commandId, {
        sessionId: assignment.sessionId,
        workspaceId: assignment.workspaceId,
        engine: assignment.engine ?? undefined,
        model: followUp.model,
      }, followUp.turn)
    }
  }

  const drainRemoteSessionRequests = (state) => {
    if (!state.controlCapable || !isCurrent(state)) return Promise.resolve()
    if (state.requestDrain) return state.requestDrain
    const promise = (async () => {
      const attempted = new Set()
      while (isCurrent(state)) {
        const response = await runnerRequest(state, "/v1/remote-session-requests/pending", {
          signal: AbortSignal.timeout(workPollTimeoutMs),
        })
        const ids = (Array.isArray(response?.items) ? response.items : [])
          .filter((item) => item?.kind === "remote_session_request" && typeof item.requestId === "string")
          .map((item) => item.requestId)
          .filter((id) => !attempted.has(id))
        if (!ids.length) return
        for (const id of ids) {
          if (!isCurrent(state)) return
          attempted.add(id)
          try {
            await runRemoteSessionRequest(state, id)
          } catch (error) {
            if (!isCurrent(state)) return
            if ([401, 403].includes(error?.status)) return
            options.log?.(`remote session request ${id} failed: ${serializedError(error)}`)
          }
        }
      }
    })().finally(() => {
      if (state.requestDrain === promise) state.requestDrain = null
    })
    state.requestDrain = promise
    return promise
  }

  /**
   * Requests are polled every few seconds only while the desktop is in
   * active remote use: a session is being watched, or one was delivered or
   * asked about recently. Otherwise the regular work poll picks them up.
   */
  const remoteSessionRequestLoop = async (state) => {
    while (isCurrent(state)) {
      const active = state.watchers.size > 0
        || Date.now() - state.lastRemoteActivityAt < requestPoll.activeWindowMs
      if (active) {
        try {
          await drainRemoteSessionRequests(state)
        } catch (error) {
          if (!isCurrent(state)) return
          options.log?.(`remote session request poll failed: ${serializedError(error)}`)
        }
      }
      try {
        await sleep(requestPoll.pollMs, state.controller.signal)
      } catch {
        return
      }
    }
  }

  const reconcile = (state) => {
    if (!isCurrent(state)) return Promise.resolve()
    if (state.reconcilePromise) return state.reconcilePromise
    const promise = (async () => {
      while (isCurrent(state)) {
        // A machine that suspends mid-request can leave this socket half-open
        // with no error, which would park the loop until the process restarts.
        // Bounding the idle poll turns that into an ordinary retry.
        const response = await runnerRequest(state, "/v1/automation-runner/work", {
          signal: AbortSignal.timeout(workPollTimeoutMs),
        })
        if (!isCurrent(state)) break
        const items = Array.isArray(response?.items) ? response.items : []
        // Session requests run beside the slot; the loop continues with the
        // first item that needs it.
        if (items.some((entry) => entry?.kind === "remote_session_request")) {
          drainRemoteSessionRequests(state).catch((error) => {
            options.log?.(`remote session request drain failed: ${serializedError(error)}`)
          })
        }
        // A run pinned to a workspace this desktop lacks is left for the
        // owner's desktop that has it; request items are never selected here.
        const item = await selectRunnableWorkItem(items, () => listLocalWorkspaceIds({
          getLocalRuntime: options.getLocalRuntime,
          fetchImpl,
          signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(workPollTimeoutMs)]),
        }))
        if (!isCurrent(state) || !item) break
        if (item.kind === "remote_session_create") {
          state.claimInFlight = true
          let claimed
          try {
            claimed = await runnerRequest(
              state,
              `/v1/remote-session-commands/${encodeURIComponent(item.commandId)}/claim`,
              { method: "POST", body: {}, signal: AbortSignal.timeout(lifecycleRequestTimeoutMs) },
            )
          } catch (error) {
            if (error?.status === 409) continue
            throw error
          } finally {
            state.claimInFlight = false
          }
          if (!claimed?.assignment) break
          await runRemoteSessionCommand(state, claimed.assignment)
          continue
        }
        state.claimInFlight = true
        let claimed
        try {
          claimed = await runnerRequest(state, `/v1/automation-runs/${encodeURIComponent(item.runId)}/claim`, {
            method: "POST",
            body: {},
            signal: AbortSignal.timeout(lifecycleRequestTimeoutMs),
          })
        } finally {
          state.claimInFlight = false
        }
        if (!claimed?.assignment) break
        await runAssignment(state, claimed.assignment)
      }
    })().finally(() => {
      if (state.reconcilePromise === promise) state.reconcilePromise = null
      if (isCurrent(state) && pendingConfiguration && !state.active) {
        const next = pendingConfiguration
        pendingConfiguration = null
        activateConfiguration(next)
      }
    })
    state.reconcilePromise = promise
    return promise
  }

  const connectLoop = async (state) => {
    let reconnectAttempt = 0
    while (isCurrent(state)) {
      reportInventory(state)
      try {
        await reconcile(state)
        reconnectAttempt = 0
        await waitBeforeReconnect(RUNNER_WORK_POLL_MS, state.controller.signal)
      } catch (error) {
        if (!isCurrent(state)) return
        if ([401, 403].includes(error?.status)) return
        options.log?.(`runner polling failed: ${error instanceof Error ? error.message : String(error)}`)
        const backoff = Math.min(30_000, 500 * (2 ** reconnectAttempt++))
        try {
          await waitBeforeReconnect(Math.round(backoff * (0.5 + random())), state.controller.signal)
        } catch (waitError) {
          if (!isCurrent(state)) return
          options.log?.(`runner polling wait failed: ${waitError instanceof Error ? waitError.message : String(waitError)}`)
        }
      }
    }
  }

  activateConfiguration = (configuration) => {
    const previous = current
    generation += 1
    if (previous) retire(previous, new Error("Automation runner configuration changed"))
    if (!configuration || stopped) return
    const state = {
      generation,
      configuration,
      controller: new AbortController(),
      reconcilePromise: null,
      claimInFlight: false,
      active: null,
      watchers: new Set(),
      watchControllers: new Map(),
      controlCapable: (runnerTokenBinding(configuration.token)?.capabilities ?? []).includes(REMOTE_SESSION_CONTROL_CAPABILITY),
      requestDrain: null,
      lastRemoteActivityAt: 0,
      retired: false,
      credentialRejected: false,
      inventoryKey: null,
      inventoryCheckedAt: null,
      inventoryInFlight: null,
      inventoryUnsupported: false,
    }
    current = state
    void connectLoop(state)
    if (state.controlCapable) void remoteSessionRequestLoop(state)
  }

  const disabledReason = options.disabledReason ?? null
  let loggedDisabled = false

  return {
    configure(next) {
      if (disabledReason) {
        if (next && !loggedDisabled) {
          loggedDisabled = true
          options.log?.(`ignoring runner configuration: disabled by ${disabledReason}; this desktop will not claim Automation runs or remote-session commands`)
        }
        return { connected: false }
      }
      const baseUrl = next ? normalizeRunnerBaseUrl(next.baseUrl) : null
      const token = next?.token ? String(next.token) : ""
      const binding = token ? runnerTokenBinding(token) : null
      const destinationAllowed = baseUrl && (
        (binding?.version === 2 && binding.audience === baseUrl)
        || (binding?.version === 1 && legacyBaseUrls.has(baseUrl))
      )
      const normalized = destinationAllowed && token && next?.runnerId
        ? { baseUrl, token, runnerId: String(next.runnerId) }
        : null
      if (next && !normalized) {
        // Without this the desktop stays quiet while every scheduled run is
        // recorded as missed, which reads as a scheduler fault rather than a
        // credential bound to a different Den route than this desktop uses.
        options.log?.(`rejected runner credential for ${baseUrl ?? "an unusable base URL"}`
          + `: token audience ${binding?.audience ?? (binding ? "v1 (untrusted here)" : "unreadable")}`)
      }
      if (normalized && rejectedCredentials.has(credentialKey(normalized))) {
        return { connected: false }
      }
      if (
        normalized
        && current?.configuration.baseUrl === normalized.baseUrl
        && current.configuration.token === normalized.token
      ) {
        pendingConfiguration = null
        return { connected: !current.controller.signal.aborted }
      }
      if (normalized && (current?.active || current?.claimInFlight)) {
        pendingConfiguration = normalized
        return { connected: !current.controller.signal.aborted }
      }
      pendingConfiguration = null
      activateConfiguration(normalized)
      return { connected: false }
    },
    /**
     * A sleeping machine parks the loop mid-wait, so a due occurrence can sit
     * queued for most of a poll interval after the desktop is already back.
     * Waking the machine polls for work now. The reconcile guard reuses an
     * in-flight cycle, so a run already holding its lease is left alone and no
     * second claim loop starts.
     */
    wake() {
      const state = current
      if (stopped || !state || !isCurrent(state)) return { polled: false }
      reportInventory(state)
      reconcile(state).catch((error) => {
        options.log?.(`runner wake poll failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      return { polled: true }
    },
    stop() {
      stopped = true
      generation += 1
      pendingConfiguration = null
      if (current) retire(current, new Error("Desktop is shutting down"))
    },
  }
}
