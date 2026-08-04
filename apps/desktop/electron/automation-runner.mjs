const EMPTY_USAGE = { inputTokens: null, outputTokens: null, costMicros: null }

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
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

function assistantResult(snapshot) {
  const assistants = Array.isArray(snapshot?.messages)
    ? snapshot.messages.filter((message) => message?.info?.role === "assistant")
    : []
  let resultSummary = null
  let inputTokens = 0
  let outputTokens = 0
  let sawInput = false
  let sawOutput = false
  for (const message of assistants) {
    const tokens = message?.info?.tokens
    if (Number.isFinite(tokens?.input)) { inputTokens += Number(tokens.input); sawInput = true }
    if (Number.isFinite(tokens?.output)) { outputTokens += Number(tokens.output); sawOutput = true }
    for (const part of Array.isArray(message?.parts) ? message.parts : []) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        resultSummary = part.text.trim().slice(0, 20_000)
      }
    }
  }
  return {
    resultSummary,
    usage: {
      inputTokens: sawInput ? inputTokens : null,
      outputTokens: sawOutput ? outputTokens : null,
      costMicros: null,
    },
  }
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
  const workspaces = Array.isArray(listed?.items) ? listed.items : []
  const workspace = workspaces.find((item) => item?.id === listed?.activeId) ?? workspaces[0]
  if (!workspace?.id) throw new Error("No local workspace is available")
  const workspaceId = String(workspace.id)
  const created = await localRequest(`/workspace/${encodeURIComponent(workspaceId)}/sessions`, {
    method: "POST",
    body: {
      title: `Automation: ${assignment.automationName}`.slice(0, 120),
      prompt: assignment.instructions,
      providerId: assignment.model.providerId,
      modelId: assignment.model.modelId,
    },
  })
  const sessionId = typeof created?.item?.id === "string" ? created.item.id : null
  if (!sessionId) throw new Error("The desktop runtime returned no thread")
  const abort = () => void localRequest(
    `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/abort`,
    { method: "POST", body: {} },
  ).catch(() => undefined)
  options.signal.addEventListener("abort", abort, { once: true })
  try {
    const startedAt = Date.now()
    while (true) {
      if (Date.now() - startedAt > assignment.timeoutMs) throw new Error("Desktop Automation execution timed out")
      const response = await localRequest(
        `/workspace/${encodeURIComponent(workspaceId)}/sessions/${encodeURIComponent(sessionId)}/snapshot?limit=200`,
      )
      const snapshot = response?.item
      const output = assistantResult(snapshot)
      if (snapshot?.status?.type === "idle" && output.resultSummary) {
        return { sessionId, workspaceId, ...output }
      }
      if (snapshot?.status?.type === "idle" && Date.now() - startedAt > 10_000) {
        throw new Error("Desktop Automation finished without an assistant result")
      }
      await sleep(500, options.signal)
    }
  } finally {
    options.signal.removeEventListener("abort", abort)
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

export function createDesktopAutomationRunner(options) {
  const fetchImpl = options.fetchImpl ?? fetch
  let configuration = null
  let connectionController = null
  let generation = 0
  let lastEventId = 0
  let reconcilePromise = null
  let active = null
  let stopped = false

  const runnerRequest = (requestPath, request = {}) => requestJson(
    fetchImpl,
    configuration.baseUrl,
    configuration.token,
    requestPath,
    request,
  )

  const heartbeat = async () => {
    if (!active) return
    const response = await runnerRequest(
      `/v1/automation-runs/${encodeURIComponent(active.assignment.runId)}/heartbeat`,
      { method: "POST", body: { attempt: active.assignment.attempt } },
    )
    if (response.cancelRequested || response.leaseValid !== true) {
      active.controller.abort(new Error("Automation run cancelled or lease lost"))
    }
  }

  const runAssignment = async (assignment) => {
    const controller = new AbortController()
    active = { assignment, controller }
    let sequence = 0
    const event = (type, payload) => runnerRequest(
      `/v1/automation-runs/${encodeURIComponent(assignment.runId)}/events`,
      { method: "POST", body: { attempt: assignment.attempt, sequence: ++sequence, type, payload, createdAt: Date.now() } },
    )
    const heartbeatTimer = setInterval(() => void heartbeat().catch((error) => controller.abort(error)), 10_000)
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
      result = {
        status: cancelled ? "cancelled" : "failed",
        sessionId: null,
        workspaceId: null,
        resultSummary: null,
        usage: EMPTY_USAGE,
        error: {
          code: cancelled ? "cancelled" : "execution_failed",
          message: error instanceof Error ? error.message : "Desktop Automation execution failed",
          retryable: false,
        },
      }
    } finally {
      clearInterval(heartbeatTimer)
    }
    try {
      await event("terminal", { status: result.status, executionTarget: "desktop", sessionId: result.sessionId })
      await runnerRequest(`/v1/automation-runs/${encodeURIComponent(assignment.runId)}/complete`, {
        method: "POST",
        body: { ...result, attempt: assignment.attempt },
      })
    } finally {
      active = null
    }
  }

  const reconcile = () => {
    if (!configuration || stopped) return Promise.resolve()
    if (reconcilePromise) return reconcilePromise
    reconcilePromise = (async () => {
      while (configuration && !stopped) {
        const response = await runnerRequest("/v1/automation-runner/work")
        const item = response?.items?.[0]
        if (!item?.runId) break
        const claimed = await runnerRequest(`/v1/automation-runs/${encodeURIComponent(item.runId)}/claim`, { method: "POST", body: {} })
        if (!claimed?.assignment) break
        await runAssignment(claimed.assignment)
      }
    })().catch((error) => options.log?.(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { reconcilePromise = null })
    return reconcilePromise
  }

  const consumeSse = async (response, localGeneration) => {
    if (!response.ok || !response.body) throw new Error(`SSE returned ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (!stopped && localGeneration === generation) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
      let boundary
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let eventType = "message"
        let eventData = null
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) {
            const value = Number(line.slice(3).trim())
            if (Number.isSafeInteger(value) && value > lastEventId) lastEventId = value
          }
          if (line.startsWith("event:")) eventType = line.slice(6).trim()
          if (line.startsWith("data:")) {
            try { eventData = JSON.parse(line.slice(5).trim()) } catch { eventData = null }
          }
        }
        await heartbeat().catch(() => undefined)
        if (
          eventType !== "keepalive"
          && eventData?.cursor === String(lastEventId)
          && ["automation_work_available", "automation_cancellation_available"].includes(eventData?.type)
        ) void reconcile()
      }
    }
  }

  const connectLoop = async (localGeneration) => {
    let reconnectAttempt = 0
    while (!stopped && configuration && localGeneration === generation) {
      connectionController = new AbortController()
      void reconcile()
      try {
        const response = await fetchImpl(`${configuration.baseUrl.replace(/\/+$/, "")}/v1/automation-runners/events`, {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${configuration.token}`,
            ...(lastEventId > 0 ? { "Last-Event-ID": String(lastEventId) } : {}),
          },
          signal: connectionController.signal,
        })
        options.log?.("SSE connected")
        reconnectAttempt = 0
        await consumeSse(response, localGeneration)
      } catch (error) {
        if (stopped || localGeneration !== generation) return
        options.log?.(`SSE reconnecting: ${error instanceof Error ? error.message : String(error)}`)
      }
      const backoff = Math.min(30_000, 500 * (2 ** reconnectAttempt++))
      await sleep(Math.round(backoff * (0.5 + Math.random())), new AbortController().signal)
    }
  }

  return {
    configure(next) {
      const baseUrl = next ? normalizeRunnerBaseUrl(next.baseUrl) : null
      const normalized = baseUrl && next?.token && next?.runnerId
        ? { baseUrl, token: String(next.token), runnerId: String(next.runnerId) }
        : null
      if (configuration?.baseUrl === normalized?.baseUrl && configuration?.token === normalized?.token) {
        return { connected: Boolean(connectionController && !connectionController.signal.aborted) }
      }
      configuration = normalized
      generation += 1
      connectionController?.abort()
      connectionController = null
      if (!configuration) active?.controller.abort(new Error("Automation runner disconnected"))
      if (configuration && !stopped) void connectLoop(generation)
      return { connected: false }
    },
    stop() {
      stopped = true
      generation += 1
      connectionController?.abort()
      active?.controller.abort(new Error("Desktop is shutting down"))
    },
  }
}
