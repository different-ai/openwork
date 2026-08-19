const EMPTY_USAGE = { inputTokens: null, outputTokens: null, costMicros: null }

function serializedError(value) {
  if (value instanceof Error) return value.message
  if (typeof value === "string") return value
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
      ...(assignment.model.variant ? { variant: assignment.model.variant } : {}),
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
      const snapshotError = classifyAutomationExecutionError(snapshot)
      if (snapshotError.code === "model_access_lost") {
        const error = new Error(snapshotError.message)
        Object.defineProperty(error, "code", { value: snapshotError.code })
        throw error
      }
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
    if (decoded?.v === 1) return { version: 1, audience: null, scope }
    if (decoded?.v !== 2 || typeof decoded.a !== "string") return null
    const audience = normalizeRunnerBaseUrl(decoded.a)
    return audience ? { version: 2, audience, scope } : null
  } catch {
    return null
  }
}

export function runnerTokenAudience(token) {
  return runnerTokenBinding(token)?.audience ?? null
}

export function createDesktopAutomationRunner(options) {
  const fetchImpl = options.fetchImpl ?? fetch
  const random = options.random ?? Math.random
  const waitBeforeReconnect = options.waitBeforeReconnect ?? sleep
  const legacyBaseUrls = new Set((options.legacyBaseUrls ?? [])
    .map((value) => normalizeRunnerBaseUrl(value))
    .filter(Boolean))
  let generation = 0
  let current = null
  let pendingConfiguration = null
  let rejectedCursor = null
  let stopped = false
  const rejectedCredentials = new Set()

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
    if (affectedCurrent) {
      const affectedBinding = runnerTokenBinding(affectedCurrent.configuration.token)
      rejectedCursor = affectedBinding?.scope
        ? {
            baseUrl: affectedCurrent.configuration.baseUrl,
            scope: affectedBinding.scope,
            lastEventId: affectedCurrent.lastEventId,
          }
        : null
    }
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
        { ...request, signal: state.controller.signal },
      )
    } catch (error) {
      if ([401, 403].includes(error?.status)) rejectCredential(state, error.status)
      throw error
    }
  }

  const heartbeat = async (state) => {
    const active = state.active
    if (!active || !isCurrent(state)) return
    const response = await runnerRequest(
      state,
      `/v1/automation-runs/${encodeURIComponent(active.assignment.runId)}/heartbeat`,
      { method: "POST", body: { attempt: active.assignment.attempt } },
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
      { method: "POST", body: { attempt: assignment.attempt, sequence: ++sequence, type, payload, createdAt: Date.now() } },
    )
    const heartbeatTimer = setInterval(() => void heartbeat(state).catch((error) => controller.abort(error)), 10_000)
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
        sessionId: null,
        workspaceId: null,
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
      clearInterval(heartbeatTimer)
    }
    try {
      await event("terminal", { status: result.status, executionTarget: "desktop", sessionId: result.sessionId })
      await runnerRequest(state, `/v1/automation-runs/${encodeURIComponent(assignment.runId)}/complete`, {
        method: "POST",
        body: { ...result, attempt: assignment.attempt },
      })
    } finally {
      if (state.active === active) state.active = null
      if (isCurrent(state) && pendingConfiguration) {
        const next = pendingConfiguration
        pendingConfiguration = null
        activateConfiguration(next)
      }
    }
  }

  const reconcile = (state) => {
    if (!isCurrent(state)) return Promise.resolve()
    if (state.reconcilePromise) return state.reconcilePromise
    const promise = (async () => {
      while (isCurrent(state)) {
        const response = await runnerRequest(state, "/v1/automation-runner/work")
        if (!isCurrent(state)) break
        const item = response?.items?.[0]
        if (!item?.runId) break
        state.claimInFlight = true
        let claimed
        try {
          claimed = await runnerRequest(state, `/v1/automation-runs/${encodeURIComponent(item.runId)}/claim`, { method: "POST", body: {} })
        } finally {
          state.claimInFlight = false
        }
        if (!claimed?.assignment) break
        await runAssignment(state, claimed.assignment)
      }
    })().catch((error) => options.log?.(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
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

  const consumeSse = async (state, response, onHealthy) => {
    if (!response.ok || !response.body) throw new Error(`SSE returned ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let healthy = false
    while (isCurrent(state)) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
      let boundary
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        let eventType = "message"
        let eventData = null
        let parsedData = false
        for (const line of block.split("\n")) {
          if (line.startsWith("id:")) {
            const value = Number(line.slice(3).trim())
            if (Number.isSafeInteger(value) && value > state.lastEventId) state.lastEventId = value
          }
          if (line.startsWith("event:")) eventType = line.slice(6).trim()
          if (line.startsWith("data:")) {
            try { eventData = JSON.parse(line.slice(5).trim()); parsedData = true } catch { eventData = null }
          }
        }
        if (parsedData && !healthy) { healthy = true; onHealthy() }
        await heartbeat(state).catch(() => undefined)
        if (
          eventType !== "keepalive"
          && eventData?.cursor === String(state.lastEventId)
          && ["automation_work_available", "automation_cancellation_available"].includes(eventData?.type)
        ) void reconcile(state)
      }
    }
  }

  const connectLoop = async (state) => {
    let reconnectAttempt = 0
    while (isCurrent(state)) {
      void reconcile(state)
      try {
        const response = await fetchImpl(`${state.configuration.baseUrl.replace(/\/+$/, "")}/v1/automation-runners/events`, {
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${state.configuration.token}`,
            ...(state.lastEventId > 0 ? { "Last-Event-ID": String(state.lastEventId) } : {}),
          },
          signal: state.controller.signal,
        })
        if ([401, 403].includes(response.status)) {
          rejectCredential(state, response.status)
          return
        }
        options.log?.("SSE connected")
        await consumeSse(state, response, () => { reconnectAttempt = 0 })
      } catch (error) {
        if (!isCurrent(state)) return
        options.log?.(`SSE reconnecting: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!isCurrent(state)) return
      const backoff = Math.min(30_000, 500 * (2 ** reconnectAttempt++))
      try {
        await waitBeforeReconnect(Math.round(backoff * (0.5 + random())), state.controller.signal)
      } catch (error) {
        if (!isCurrent(state)) return
        options.log?.(`SSE reconnect wait failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  activateConfiguration = (configuration) => {
    const previous = current
    const previousBinding = previous ? runnerTokenBinding(previous.configuration.token) : null
    const nextBinding = configuration ? runnerTokenBinding(configuration.token) : null
    const cursor = previousBinding?.scope
      ? { baseUrl: previous.configuration.baseUrl, scope: previousBinding.scope, lastEventId: previous.lastEventId }
      : rejectedCursor
    const lastEventId = cursor?.scope && cursor.scope === nextBinding?.scope && cursor.baseUrl === configuration?.baseUrl
      ? cursor.lastEventId
      : 0
    rejectedCursor = null
    generation += 1
    if (previous) retire(previous, new Error("Automation runner configuration changed"))
    if (!configuration || stopped) return
    const state = {
      generation,
      configuration,
      controller: new AbortController(),
      lastEventId,
      reconcilePromise: null,
      claimInFlight: false,
      active: null,
      retired: false,
      credentialRejected: false,
    }
    current = state
    void connectLoop(state)
  }

  return {
    configure(next) {
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
      if (!normalized) rejectedCursor = null
      activateConfiguration(normalized)
      return { connected: false }
    },
    stop() {
      stopped = true
      generation += 1
      pendingConfiguration = null
      rejectedCursor = null
      if (current) retire(current, new Error("Desktop is shutting down"))
    },
  }
}
