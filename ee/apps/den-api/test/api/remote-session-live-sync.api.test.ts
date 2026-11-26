import assert from "node:assert/strict"
import { after, test } from "node:test"
import { eq } from "@openwork-ee/den-db/drizzle"
import { RemoteSessionTailTable } from "@openwork-ee/den-db/schema/remote-session-commands"
import { automationRunnerWorkResponseSchema, remoteSessionCommandClaimResponseSchema } from "@openwork/types/automations"
import { boundRemoteSessionsResponseSchema, remoteSessionTailResponseSchema } from "@openwork/types/den/remote-sessions"
import { bootDen, field, list, summary, text, type Member } from "./harness.js"

const den = await bootDen()
after(() => den.close())
const { db } = await import("../../src/db.js")
const { automationRunnerRowId } = await import("../../src/automations/repository.js")
const { REMOTE_SESSION_TAIL_MAX_BYTES, REMOTE_SESSION_TAIL_MAX_MESSAGES, sweepExpiredRemoteSessionTails } = await import("../../src/remote-sessions/tails.js")

const { orgId, owner } = await den.createOrg(await den.signUp("Rina Owner"), "Live sync organization")
const asOwner = den.as(owner, orgId)
const WORKSPACE = "ws_remote_studio"
const PARENT_SESSION = "ses_parent_origin_1"
const PARENT_WORKSPACE = "ws_parent_laptop_1"
const CAPABILITIES = ["remote_session_v1", "remote_session_only_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1"]

async function connectComputer(person: Member, runnerId: string, label: string) {
  const minted = await den.as(person, orgId)("POST", "/v1/session-runners/token", {
    runnerId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.6.0", platform: "darwin", concurrency: 1, capabilities: CAPABILITIES,
  })
  assert.equal(minted.status, 200, summary(minted))
  const token = text(field(minted.body, "token"), "runner token")
  const computerId = automationRunnerRowId({ organizationId: orgId, ownerMemberId: person.memberId, runnerId })
  const call = (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => den.request(token, method, path, body === undefined ? {} : { body })
  const inv = await call("PUT", "/v1/session-runners/inventory", {
    computer: { label, platform: "darwin", appVersion: "1.6.0" },
    workspaces: [{ workspaceId: WORKSPACE, name: "Studio", active: true, engine: "v2", defaultModel: null, models: [] }],
  })
  assert.equal(inv.status, 200, summary(inv))
  return { computerId, runnerId, token, call }
}

function makeMessages(count: number, padding = 100) {
  return Array.from({ length: count }, (_, index) => ({
    id: `msg_${index}`,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    createdAt: 1_000 + index * 100,
    completedAt: 1_050 + index * 100,
    text: `Message ${index} ${"x".repeat(padding)}`,
    truncated: false,
    toolCalls: [],
    error: null,
  }))
}

async function readNextSseEvent(reader: ReadableStreamDefaultReader<Uint8Array>, expectedEvent: string, timeoutMs = 5_000) {
  const decoder = new TextDecoder()
  let buffer = ""
  let eventName = ""
  let dataLines: string[] = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const remaining = Math.max(50, deadline - Date.now())
    const chunk = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
    ])
    if (chunk === null) break
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    for (;;) {
      const nl = buffer.indexOf("\n")
      if (nl < 0) break
      const line = buffer.slice(0, nl).replace(/\r$/, "")
      buffer = buffer.slice(nl + 1)
      if (line === "") {
        if (dataLines.length > 0 && eventName === expectedEvent) {
          return JSON.parse(dataLines.join("\n")) as Record<string, unknown>
        }
        eventName = ""
        dataLines = []
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim()
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""))
      }
    }
  }
  throw new Error(`Timed out waiting for SSE event ${expectedEvent}`)
}

test("remoteSessionLiveSync is gated off by default, binds parent sessions, enforces tail caps, streams live updates, keeps tails on sign-out, sweeps expiry, and clears on disconnect", async () => {
  const offBound = await asOwner("GET", "/v1/remote-sessions/bound")
  assert.equal(offBound.status, 404, summary(offBound))
  const offTail = await asOwner("GET", "/v1/remote-sessions/tail/command%3Arsc_none")
  assert.equal(offTail.status, 404, summary(offTail))

  const enabled = await den.setFeature(orgId, "remoteSessionLiveSync", true)
  assert.equal(enabled.status, 200, summary(enabled))

  const studio = await connectComputer(owner, "runner_live_sync_1", "Studio Mac")
  const mcpToken = await den.mintMcpToken(owner, orgId, ["mcp:read", "mcp:write"])
  const created = await den.callMcpTool(mcpToken, "execute_capability", {
    name: "remote-session:create",
    body: {
      target: "registered",
      computerId: studio.computerId,
      workspaceId: WORKSPACE,
      title: "Build launch deck",
      prompt: "Create the launch deck outline.",
      originSessionId: PARENT_SESSION,
      originWorkspaceId: PARENT_WORKSPACE,
    },
  })
  assert.equal(created.isError, false, created.text)
  const commandId = text(field(created.body, "commandId"), "commandId")
  const threadKey = `command:${commandId}`

  const work = await studio.call("GET", "/v1/session-runners/work")
  assert.equal(work.status, 200, summary(work))
  const parsedWork = automationRunnerWorkResponseSchema.parse(work.body)
  assert.ok(parsedWork.items.some((item) => item.kind === "remote_session_create" && item.commandId === commandId))

  const claim = await studio.call("POST", `/v1/remote-session-commands/${commandId}/claim`, {})
  assert.equal(claim.status, 200, summary(claim))
  remoteSessionCommandClaimResponseSchema.parse(claim.body)

  const complete = await studio.call("POST", `/v1/remote-session-commands/${commandId}/complete`, {
    status: "delivered",
    sessionId: "ses_remote_deck",
    workspaceId: WORKSPACE,
  })
  assert.equal(complete.status, 200, summary(complete))

  const oversizedTail = {
    title: "Build launch deck",
    status: "running" as const,
    waitingFor: null,
    lastError: null,
    messageCount: 35,
    from: "end" as const,
    messages: makeMessages(35, 2_500),
    nextCursor: null,
  }
  const reported = await studio.call("POST", `/v1/remote-session-commands/${commandId}/session`, {
    status: "running",
    engine: "v2",
    messageCount: 35,
    latestStep: "Drafting slide 4",
    observedAt: Date.now(),
    tail: oversizedTail,
  })
  assert.equal(reported.status, 200, summary(reported))

  const bound = await asOwner("GET", `/v1/remote-sessions/bound?parentSessionId=${encodeURIComponent(PARENT_SESSION)}`)
  assert.equal(bound.status, 200, summary(bound))
  const parsedBound = boundRemoteSessionsResponseSchema.parse(bound.body)
  assert.equal(parsedBound.sessions.length, 1)
  assert.equal(parsedBound.sessions[0]?.commandId, commandId)
  assert.equal(parsedBound.sessions[0]?.parentSessionId, PARENT_SESSION)
  assert.equal(parsedBound.sessions[0]?.parentWorkspaceId, PARENT_WORKSPACE)
  assert.equal(parsedBound.sessions[0]?.status.computerLabel, "Studio Mac")
  assert.ok(parsedBound.sessions[0]?.tailUpdatedAt !== null)

  const tailRes = await asOwner("GET", `/v1/remote-sessions/tail/${encodeURIComponent(threadKey)}`)
  assert.equal(tailRes.status, 200, summary(tailRes))
  const parsedTail = remoteSessionTailResponseSchema.parse(tailRes.body)
  assert.ok(parsedTail.tail !== null)
  assert.ok(parsedTail.tail.messages.length <= REMOTE_SESSION_TAIL_MAX_MESSAGES)
  const [storedRow] = await db.$primary.select().from(RemoteSessionTailTable).where(eq(RemoteSessionTailTable.thread_key, threadKey)).limit(1)
  assert.ok(storedRow)
  assert.ok(storedRow.byte_size <= REMOTE_SESSION_TAIL_MAX_BYTES)

  const streamAbort = new AbortController()
  const streamRes = await den.app.fetch(new Request("http://127.0.0.1/v1/remote-sessions/stream", {
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${owner.token}`,
      "X-OpenWork-Organization-Id": orgId,
    },
    signal: streamAbort.signal,
  }))
  assert.equal(streamRes.status, 200)
  assert.ok(streamRes.body)
  const reader = streamRes.body.getReader()
  try {
    const snap = await readNextSseEvent(reader, "snapshot")
    assert.equal(list(snap.sessions, "sessions").length, 1)

    const updatePromise = readNextSseEvent(reader, "update")
    const secondReport = await studio.call("POST", `/v1/remote-session-commands/${commandId}/session`, {
      status: "idle",
      engine: "v2",
      messageCount: 36,
      finalText: "Launch deck is ready.",
      observedAt: Date.now() + 500,
      tail: {
        title: "Build launch deck",
        status: "idle",
        waitingFor: null,
        lastError: null,
        messageCount: 36,
        from: "end",
        messages: makeMessages(2, 20),
        nextCursor: null,
      },
    })
    assert.equal(secondReport.status, 200, summary(secondReport))
    const update = await updatePromise
    assert.equal(update.type, "update")
    const tails = field(update, "tails")
    assert.ok(tails && typeof tails === "object" && threadKey in tails)
  } finally {
    streamAbort.abort()
    await reader.cancel().catch(() => undefined)
  }

  const secondSession = await den.signIn(owner.email)
  const secondToken = text(field(secondSession.body, "token"), "second sign-in token")
  const signedOut = await den.request(secondToken, "POST", "/api/auth/sign-out", { body: {} })
  assert.equal(signedOut.status, 200, summary(signedOut))
  const afterSignOutTail = await asOwner("GET", `/v1/remote-sessions/tail/${encodeURIComponent(threadKey)}`)
  assert.equal(afterSignOutTail.status, 200, summary(afterSignOutTail))
  assert.ok(remoteSessionTailResponseSchema.parse(afterSignOutTail.body).tail !== null)

  const legacyCreated = await den.callMcpTool(mcpToken, "execute_capability", {
    name: "remote-session:create",
    body: {
      target: "registered",
      computerId: studio.computerId,
      workspaceId: WORKSPACE,
      title: "Legacy unbound task",
      prompt: "Start before binding existed.",
    },
  })
  assert.equal(legacyCreated.isError, false, legacyCreated.text)
  const legacyCommandId = text(field(legacyCreated.body, "commandId"), "legacy commandId")
  const legacyClaim = await studio.call("POST", `/v1/remote-session-commands/${legacyCommandId}/claim`, {})
  assert.equal(legacyClaim.status, 200, summary(legacyClaim))
  const legacyComplete = await studio.call("POST", `/v1/remote-session-commands/${legacyCommandId}/complete`, {
    status: "delivered",
    sessionId: "ses_remote_legacy",
    workspaceId: WORKSPACE,
  })
  assert.equal(legacyComplete.status, 200, summary(legacyComplete))
  const beforeBackfill = await asOwner("GET", "/v1/remote-sessions/bound?parentSessionId=ses_parent_backfill")
  assert.equal(boundRemoteSessionsResponseSchema.parse(beforeBackfill.body).sessions.length, 0)
  const backfillSendPromise = den.callMcpTool(mcpToken, "execute_capability", {
    name: "remote-session:send",
    body: {
      sessionId: "ses_remote_legacy",
      workspaceId: WORKSPACE,
      prompt: "Follow up from an existing chat",
      originSessionId: "ses_parent_backfill",
      originWorkspaceId: "ws_parent_backfill",
    },
  })
  let reqId: string | null = null
  for (let attempt = 0; attempt < 40 && !reqId; attempt += 1) {
    const pendingReqs = await studio.call("GET", "/v1/remote-session-requests/pending")
    const items = list(field(pendingReqs.body, "items"), "items")
    if (items[0]) reqId = text(field(items[0], "requestId"), "requestId")
    else await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.ok(reqId, "expected pending send request")
  await studio.call("POST", `/v1/remote-session-requests/${reqId}/claim`, {})
  await studio.call("POST", `/v1/remote-session-requests/${reqId}/complete`, {
    status: "done",
    outcome: { action: "send", result: { messageId: "msg_backfill1", alreadyPresent: false } },
  })
  await backfillSendPromise
  const afterBackfill = await asOwner("GET", "/v1/remote-sessions/bound?parentSessionId=ses_parent_backfill")
  const parsedBackfill = boundRemoteSessionsResponseSchema.parse(afterBackfill.body)
  assert.equal(parsedBackfill.sessions.length, 1)
  assert.equal(parsedBackfill.sessions[0]?.commandId, legacyCommandId)
  assert.equal(parsedBackfill.sessions[0]?.parentWorkspaceId, "ws_parent_backfill")

  await db.update(RemoteSessionTailTable)
    .set({ expires_at: new Date(Date.now() - 1_000) })
    .where(eq(RemoteSessionTailTable.thread_key, threadKey))
  const expiredRead = await asOwner("GET", `/v1/remote-sessions/tail/${encodeURIComponent(threadKey)}`)
  assert.equal(remoteSessionTailResponseSchema.parse(expiredRead.body).tail, null)
  const swept = await sweepExpiredRemoteSessionTails()
  assert.ok(swept >= 1)

  const repopulated = await studio.call("POST", `/v1/remote-session-commands/${commandId}/session`, {
    status: "idle",
    engine: "v2",
    messageCount: 37,
    finalText: "Updated deck.",
    observedAt: Date.now() + 2_000,
    tail: {
      title: "Build launch deck",
      status: "idle",
      waitingFor: null,
      lastError: null,
      messageCount: 37,
      from: "end",
      messages: makeMessages(2, 20),
      nextCursor: null,
    },
  })
  assert.equal(repopulated.status, 200, summary(repopulated))
  const devices = await asOwner("GET", "/v1/remote-devices")
  assert.equal(devices.status, 200, summary(devices))
  const deviceList = list(field(devices.body, "devices"), "devices")
  const studioDevice = deviceList.find((item) => field(item, "id") === studio.computerId || field(item, "installId") === studio.runnerId)
  if (studioDevice) {
    const deviceId = text(field(studioDevice, "id"), "deviceId")
    const disc = await asOwner("POST", `/v1/remote-devices/${deviceId}/disconnect`, {})
    assert.equal(disc.status, 200, summary(disc))
    const afterDisconnect = await asOwner("GET", `/v1/remote-sessions/tail/${encodeURIComponent(threadKey)}`)
    assert.equal(remoteSessionTailResponseSchema.parse(afterDisconnect.body).tail, null)
  }
})
