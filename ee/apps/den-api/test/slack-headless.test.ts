import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { isHeadlessRunMcpToken } from "../src/mcp/headless-run-token.js"
import {
  headlessRemoteCall,
  headlessRunnerConfig,
  listHeadlessModels,
  slackRuntimeForOrganization,
  stepLabel,
  type HeadlessDeps,
} from "../src/slack-assistant/headless.js"
import {
  advanceSlackRun,
  checkpointSchema,
  CHECK_IN_EVERY_MS,
  doneSummary,
  formatElapsed,
  LONG_TASK_LINE,
  LONG_TASK_QUIET_AFTER_MS,
  stopSlackStream,
  STREAM_CONTINUED_LINE,
  STREAM_ROTATE_AFTER_MS,
  WAITING_LINE,
  type RemoteCall,
} from "../src/slack-assistant/run.js"
import { buildSlackPrompt, SlackApiError } from "../src/slack-assistant/protocol.js"

const TOKEN = "t".repeat(40)
const env = { DEN_HEADLESS_RUNNER_URL: "http://headless-runner:8795", DEN_HEADLESS_RUNNER_TOKEN: TOKEN }
const actor = { userId: "usr_1", organizationId: "org_1" }

type Captured = { method: string; path: string; body: unknown; authorization: string | null }

function runner(responses: Array<{ status: number; body: unknown }>) {
  const calls: Captured[] = []
  let minted = 0
  const deps: HeadlessDeps = {
    config: { url: "http://headless-runner:8795", token: TOKEN },
    fetch: async (input, init) => {
      const url = new URL(String(input))
      calls.push({
        method: init?.method ?? "GET",
        path: `${url.pathname}${url.search}`,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      })
      const next = responses.shift() ?? { status: 500, body: {} }
      return new Response(JSON.stringify(next.body), { status: next.status })
    },
    mintToken: async () => ({ token: `ow_mcp_at_run_${++minted}` }),
  }
  return { deps, calls }
}

const snapshot = (turn: { status: string; error?: string | null }, messages: unknown[], finalAssistantText = "") => ({
  status: 200,
  body: { turns: [{ messageId: "msg_1", error: null, ...turn }], messages, finalAssistantText },
})

describe("headless runner configuration", () => {
  test("requires a URL and a strong service token; http only on internal hosts", () => {
    expect(headlessRunnerConfig(env)).toEqual({ url: "http://headless-runner:8795", token: TOKEN })
    expect(headlessRunnerConfig({ ...env, DEN_HEADLESS_RUNNER_URL: "https://runner.example.com/" })?.url).toBe("https://runner.example.com")
    expect(headlessRunnerConfig({ ...env, DEN_HEADLESS_RUNNER_URL: "http://runner.example.com" })).toBeNull()
    expect(headlessRunnerConfig({ ...env, DEN_HEADLESS_RUNNER_TOKEN: "short" })).toBeNull()
    expect(headlessRunnerConfig({})).toBeNull()
  })

  test("an organization uses the runner only with its capability on and a configured runner", () => {
    const on = { capabilities: { slackAssistant: true, slackAssistantHeadless: true } }
    expect(slackRuntimeForOrganization(on, env)).toBe("headless")
    expect(slackRuntimeForOrganization(JSON.stringify(on), env)).toBe("headless")
    expect(slackRuntimeForOrganization(on, {})).toBe("web")
    expect(slackRuntimeForOrganization({ capabilities: { slackAssistant: true } }, env)).toBe("web")
    expect(slackRuntimeForOrganization(null, env)).toBe("web")
  })
})

describe("headless remote calls", () => {
  test("create, send with a fresh member token, and stop", async () => {
    const { deps, calls } = runner([
      { status: 201, body: { id: "hs_1" } },
      { status: 202, body: {} },
      { status: 200, body: { accepted: true } },
    ])
    expect(await headlessRemoteCall(actor, "create", { title: "C1 · summarize", target: "cloud" }, deps)).toEqual({
      sessionId: "hs_1",
      workspaceId: "headless",
    })
    expect(await headlessRemoteCall(actor, "send", { sessionId: "hs_1", prompt: "summarize", messageId: "msg_1" }, deps)).toEqual({})
    expect(await headlessRemoteCall(actor, "stop", { sessionId: "hs_1", messageId: "msg_1" }, deps)).toEqual({ accepted: true })
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /v1/sessions",
      "POST /v1/sessions/hs_1/turns",
      "POST /v1/sessions/hs_1/abort",
    ])
    expect(calls.every((call) => call.authorization === `Bearer ${TOKEN}`)).toBe(true)
    expect(calls[1].body).toEqual({ messageId: "msg_1", prompt: "summarize", credentials: { mcpToken: "ow_mcp_at_run_1" } })
    expect(calls[2].body).toEqual({ messageId: "msg_1" })
  })

  test("the admin's model goes to the runner with the turn, and the model list comes from the runner", async () => {
    const { deps, calls } = runner([
      { status: 202, body: {} },
      { status: 200, body: { defaultModel: "gwm_fable", models: [{ id: "gwm_fable", name: "Claude Fable 5.1" }, { id: "gwm_opus", name: "Claude Opus 5.5" }] } },
    ])
    await headlessRemoteCall(actor, "send", { sessionId: "hs_1", prompt: "x", messageId: "msg_1", model: "gwm_opus" }, deps)
    expect(calls[0].body).toMatchObject({ model: "gwm_opus" })
    expect(await listHeadlessModels(deps)).toEqual({
      defaultModel: "gwm_fable",
      models: [{ id: "gwm_fable", name: "Claude Fable 5.1" }, { id: "gwm_opus", name: "Claude Opus 5.5" }],
    })
    expect(await listHeadlessModels(null)).toBeNull()
  })

  test("read maps a running turn to busy with labelled steps", async () => {
    const { deps, calls } = runner([
      snapshot({ status: "running" }, [
        { role: "user", text: "digest" },
        {
          role: "assistant",
          text: "Checking Slack.",
          toolCalls: [
            { id: "c1", name: "execute_capability", input: { name: "mcp:emc_1:slack_search_public" } },
            { id: "c2", name: "write_file", input: { path: "notes/digest.md" } },
          ],
        },
        { role: "tool", callId: "c1", name: "execute_capability", output: "3 messages", isError: false },
      ], "Checking Slack."),
    ])
    const read = await headlessRemoteCall(actor, "read", { sessionId: "hs_1", messageId: "msg_1", limit: 100 }, deps)
    // Polled every second for the whole run: tool outputs stay on the runner.
    expect(calls[0].path).toBe("/v1/sessions/hs_1?messageId=msg_1&limit=500&outputs=none")
    expect(read).toMatchObject({ status: "busy", finalAssistantText: "Checking Slack.", title: null })
    expect(z.object({ messages: z.array(z.object({ toolCalls: z.array(z.unknown()) })) }).parse(read).messages[1].toolCalls).toEqual([
      { id: "c1", name: "Using slack search public", status: "completed" },
      { id: "c2", name: "Writing notes/digest.md", status: "running" },
    ])
  })

  test("read reports finished, failed and empty answers so the Slack loop always ends", async () => {
    const done = runner([snapshot({ status: "completed" }, [], "Here is your digest.")])
    expect(await headlessRemoteCall(actor, "read", { sessionId: "hs_1", messageId: "msg_1" }, done.deps)).toMatchObject({
      status: "idle",
      finalAssistantText: "Here is your digest.",
    })
    const failed = runner([snapshot({ status: "failed", error: "model_http_500" }, [])])
    expect(await headlessRemoteCall(actor, "read", { sessionId: "hs_1", messageId: "msg_1" }, failed.deps)).toMatchObject({
      status: "idle",
      terminalError: { code: "model_http_500" },
    })
    const empty = runner([snapshot({ status: "completed" }, [], "")])
    expect(await headlessRemoteCall(actor, "read", { sessionId: "hs_1", messageId: "msg_1" }, empty.deps)).toMatchObject({
      status: "idle",
      finalAssistantText: "Done.",
    })
  })

  test("read returns the turn's last message on its own, for a long task's final answer", async () => {
    const { deps } = runner([
      snapshot(
        { status: "completed" },
        [
          { role: "user", text: "fix the PR" },
          { role: "assistant", text: "Looking at the checks.", toolCalls: [{ id: "c1", name: "execute_capability", input: {} }] },
          { role: "tool", callId: "c1", name: "execute_capability", isError: false },
          { role: "assistant", text: "Evidence preview fails on a missing env var.", toolCalls: [] },
        ],
        "Looking at the checks.\n\nEvidence preview fails on a missing env var.",
      ),
    ])
    expect(await headlessRemoteCall(actor, "read", { sessionId: "hs_1", messageId: "msg_1" }, deps)).toMatchObject({
      lastAssistantText: "Evidence preview fails on a missing env var.",
    })
  })

  test("an interrupted turn (runner restart) is resumed with a new token", async () => {
    const { deps, calls } = runner([snapshot({ status: "interrupted", error: "runner_restarted" }, []), { status: 202, body: {} }])
    const read = await headlessRemoteCall(actor, "read", { sessionId: "hs_1", messageId: "msg_1" }, deps)
    expect(read).toMatchObject({ status: "busy" })
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/v1/sessions/hs_1/turns",
      body: { messageId: "msg_1", credentials: { mcpToken: "ow_mcp_at_run_1" } },
    })
  })

  test("runner outages are retryable; a missing runner is not", async () => {
    const down = runner([{ status: 503, body: {} }])
    expect(await headlessRemoteCall(actor, "send", { sessionId: "hs_1", prompt: "x", messageId: "msg_1" }, down.deps)).toMatchObject({
      retryable: true,
    })
    expect(await headlessRemoteCall(actor, "create", {}, null)).toEqual({ error: "headless_runner_not_configured", retryable: false })
  })
})

describe("headless run MCP tokens", () => {
  const iat = 1_800_000_000
  test("are accepted without a session only while short-lived and sessionless", () => {
    const base = { client_id: "openwork-headless-run", iat, exp: iat + 3600 }
    expect(isHeadlessRunMcpToken(base, "opaque")).toBe(true)
    expect(isHeadlessRunMcpToken(base, "jwt")).toBe(false)
    expect(isHeadlessRunMcpToken({ ...base, client_id: "openwork-desktop" }, "opaque")).toBe(false)
    expect(isHeadlessRunMcpToken({ ...base, sid: "ses_1" }, "opaque")).toBe(false)
    expect(isHeadlessRunMcpToken({ ...base, exp: iat + 3601 }, "opaque")).toBe(false)
    expect(isHeadlessRunMcpToken({ ...base, exp: iat }, "opaque")).toBe(false)
    expect(isHeadlessRunMcpToken({ client_id: "openwork-headless-run" }, "opaque")).toBe(false)
  })
})

describe("Slack run loop on the headless runtime", () => {
  function slackRecorder() {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const slack = async (method: string, body: Record<string, unknown>) => {
      calls.push({ method, body })
      return { ok: true, ts: "2.0" }
    }
    return { calls, slack }
  }

  test("finishes without Web links and pings when a run took over a minute", async () => {
    const { calls, slack } = slackRecorder()
    const remote: RemoteCall = async () => ({})
    const checkpoint = checkpointSchema.parse({
      phase: "finish",
      channel: "C1",
      threadTs: "1.0",
      streamTs: "1.5",
      sessionId: "hs_1",
      recipientUserId: "U1",
      startedAt: 0,
      sentText: "## Digest\n- Launch moved to Tuesday",
    })
    await advanceSlackRun({ checkpoint, remote, slack, messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false, now: () => 200_000 })
    expect(JSON.stringify(calls)).not.toContain("OpenWork Web")
    expect(calls.at(-1)).toEqual({ method: "chat.postMessage", body: { channel: "C1", thread_ts: "1.0", text: "<@U1> Done: Digest" } })
  })

  test("the reply stream opens with the first step, not a placeholder", async () => {
    const { calls, slack } = slackRecorder()
    const remote: RemoteCall = async () => ({
      status: "busy",
      messageCount: 2,
      finalAssistantText: "",
      messages: [{ role: "assistant", toolCalls: [{ id: "c1", name: "Finding the right tool", status: "running" }] }],
    })
    const checkpoint = checkpointSchema.parse({ phase: "read", channel: "C1", threadTs: "1.0", sessionId: "hs_1", startedAt: 0 })
    await advanceSlackRun({ checkpoint, remote, slack, messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false, now: () => 5_000 })
    expect(calls.map((call) => call.method)).toEqual(["chat.startStream"])
    expect(JSON.stringify(calls[0].body)).toContain("Finding the right tool")
    expect(JSON.stringify(calls)).not.toContain("I'll reply here")
  })

  test("a quick answer streams straight away, with no 'still working' line", async () => {
    const { calls, slack } = slackRecorder()
    const remote: RemoteCall = async () => ({ status: "idle", messageCount: 2, finalAssistantText: "Hi there!", messages: [] })
    const checkpoint = checkpointSchema.parse({ phase: "read", channel: "C1", threadTs: "1.0", sessionId: "hs_1", startedAt: 0 })
    const result = await advanceSlackRun({ checkpoint, remote, slack, messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false, now: () => 3_000 })
    expect(calls[0]).toMatchObject({ method: "chat.startStream", body: { chunks: [{ type: "markdown_text", text: "Hi there!" }] } })
    expect(result.checkpoint.phase).toBe("finish")
  })

  test("after 20 seconds without an answer it says it is still working, once", async () => {
    const { calls, slack } = slackRecorder()
    const remote: RemoteCall = async () => ({ status: "busy", messageCount: 1, finalAssistantText: "", messages: [] })
    const checkpoint = checkpointSchema.parse({ phase: "read", channel: "C1", threadTs: "1.0", sessionId: "hs_1", startedAt: 0 })
    const input = { remote, slack, messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false, now: () => 25_000 }
    const first = await advanceSlackRun({ ...input, checkpoint })
    await advanceSlackRun({ ...input, checkpoint: first.checkpoint })
    expect(JSON.stringify(calls).match(/Still working on it/g)?.length).toBe(1)
  })

  test("stopping before anything streamed posts the note and clears the status", async () => {
    const { calls, slack } = slackRecorder()
    const checkpoint = checkpointSchema.parse({ channel: "C1", threadTs: "1.0" })
    await stopSlackStream(slack, { ...checkpoint, finalStatus: "suspended" }, { chunks: [{ type: "markdown_text", text: "\n\nStopped." }] })
    expect(calls).toEqual([
      { method: "chat.postMessage", body: { channel: "C1", thread_ts: "1.0", text: "Stopped." } },
      { method: "agents.sessions.setStatus", body: { channel_id: "C1", thread_ts: "1.0", status: "suspended" } },
    ])
  })

  test("the admin's model is sent with the turn; no model means the runner default", async () => {
    const bodies: Record<string, unknown>[] = []
    const remote: RemoteCall = async (_action, body) => {
      bodies.push(body)
      return {}
    }
    const { slack } = slackRecorder()
    const base = { remote, slack, messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false }
    await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse({ phase: "send", sessionId: "hs_1", prompt: "x" }), model: "gwm_opus" })
    await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse({ phase: "send", sessionId: "hs_1", prompt: "x" }) })
    expect(bodies[0]).toMatchObject({ model: "gwm_opus" })
    expect(bodies[1]).not.toHaveProperty("model")
  })

  test("quick runs get no extra ping", async () => {
    const { calls, slack } = slackRecorder()
    const checkpoint = checkpointSchema.parse({ phase: "finish", channel: "C1", threadTs: "1.0", streamTs: "1.5", recipientUserId: "U1", startedAt: 0 })
    await advanceSlackRun({ checkpoint, remote: async () => ({}), slack, messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false, now: () => 20_000 })
    expect(calls.some((call) => call.method === "chat.postMessage")).toBe(false)
  })

  test("task steps show the runner's labels", async () => {
    const { calls, slack } = slackRecorder()
    const remote: RemoteCall = async () => ({
      status: "busy",
      title: null,
      messageCount: 2,
      finalAssistantText: "",
      messages: [{ role: "assistant", toolCalls: [{ id: "c1", name: "Finding the right tool", status: "completed" }] }],
    })
    const checkpoint = checkpointSchema.parse({ phase: "read", channel: "C1", threadTs: "1.0", streamTs: "1.5", sessionId: "hs_1" })
    await advanceSlackRun({ checkpoint, remote, slack, messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false })
    expect(JSON.stringify(calls)).toContain("Finding the right tool")
  })
})

describe("long runs outlive Slack's five-minute stream", () => {
  const base = { messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false }
  const open = { phase: "read", channel: "C1", threadTs: "1.0", streamTs: "1.5", streamStartedAt: 0, sessionId: "hs_1" }
  const answer = (text: string, toolCalls: Array<{ id: string; name: string; status: string }> = []): RemoteCall =>
    async () => ({ status: "busy", messageCount: 2, finalAssistantText: text, messages: [{ role: "assistant", toolCalls }] })

  /** Slack that refuses appends and stops on the streams listed in `closed`. */
  function slackClosing(closed: string[]) {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const slack = async (method: string, body: Record<string, unknown>) => {
      calls.push({ method, body })
      if ((method === "chat.appendStream" || method === "chat.stopStream") && closed.includes(String(body.ts)))
        throw new SlackApiError("message_not_in_streaming_state")
      return { ok: true, ts: "2.0" }
    }
    return { calls, slack }
  }

  test("the reply stays in one message until four minutes, then continues in a new one", async () => {
    const early = slackClosing([])
    await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse(open), remote: answer("Checking."), slack: early.slack, now: () => STREAM_ROTATE_AFTER_MS - 1 })
    expect(early.calls.map((call) => call.method)).toEqual(["chat.appendStream"])

    const late = slackClosing([])
    const result = await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse(open), remote: answer("Checking."), slack: late.slack, now: () => STREAM_ROTATE_AFTER_MS })
    expect(late.calls).toEqual([
      { method: "chat.stopStream", body: { channel: "C1", ts: "1.5", session_status: "processing" } },
      {
        method: "chat.startStream",
        body: expect.objectContaining({
          thread_ts: "1.0",
          chunks: [{ type: "markdown_text", text: STREAM_CONTINUED_LINE }, { type: "markdown_text", text: "Checking." }],
        }),
      },
    ])
    expect(result.checkpoint).toMatchObject({ streamTs: "2.0", streamStartedAt: STREAM_ROTATE_AFTER_MS, sentText: "Checking." })
  })

  test("when Slack closes the stream early, text and steps continue in a new message instead of failing the run", async () => {
    const { calls, slack } = slackClosing(["1.5"])
    const remote = answer("Evidence preview failed on a missing env var.", [{ id: "c1", name: "Reading checks", status: "completed" }])
    const result = await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse(open), remote, slack, now: () => 60_000 })
    // Text and step changes travel in one call, so the new message carries both.
    expect(calls.map((call) => `${call.method} ${String(call.body.ts ?? "")}`)).toEqual(["chat.appendStream 1.5", "chat.startStream "])
    expect(JSON.stringify(calls[1].body.chunks)).toContain("Evidence preview failed")
    expect(JSON.stringify(calls[1].body.chunks)).toContain("Reading checks")
    expect(result.checkpoint).toMatchObject({ streamTs: "2.0", sentText: "Evidence preview failed on a missing env var.", steps: { c1: "completed" } })
  })

  test("a step update alone also recovers a stream Slack closed", async () => {
    const { calls, slack } = slackClosing(["1.5"])
    const result = await advanceSlackRun({
      ...base,
      checkpoint: checkpointSchema.parse(open),
      remote: answer("", [{ id: "c1", name: "Reading checks", status: "running" }]),
      slack,
      now: () => 60_000,
    })
    expect(calls.map((call) => call.method)).toEqual(["chat.appendStream", "chat.startStream"])
    expect(JSON.stringify(calls[1].body.chunks)).toContain("Reading checks")
    expect(result.checkpoint.streamTs).toBe("2.0")
  })

  test("closing text still reaches the thread when Slack already closed the stream", async () => {
    const checkpoint = checkpointSchema.parse({ channel: "C1", threadTs: "1.0", streamTs: "1.5", finalStatus: "suspended" })
    const closing = { chunks: [{ type: "markdown_text", text: "\n\nThis task stopped. Try again in a moment." }] }
    const expired = slackClosing(["1.5"])
    await stopSlackStream(expired.slack, checkpoint, closing)
    expect(expired.calls.slice(1)).toEqual([
      { method: "chat.postMessage", body: { channel: "C1", thread_ts: "1.0", text: "This task stopped. Try again in a moment." } },
      { method: "agents.sessions.setStatus", body: { channel_id: "C1", thread_ts: "1.0", status: "suspended" } },
    ])

    // A member who pressed Stop already sees the stream end; no extra reply.
    const calls: string[] = []
    await stopSlackStream(
      async (method) => {
        calls.push(method)
        if (method === "chat.stopStream") throw new SlackApiError("stopped_by_user")
        return { ok: true }
      },
      checkpoint,
      closing,
    )
    expect(calls).toEqual(["chat.stopStream", "agents.sessions.setStatus"])
  })

  for (const slackLifetimeMs of [5 * 60_000, 3 * 60_000])
    test(`a 12-minute run delivers its answer when Slack closes streams after ${slackLifetimeMs / 60_000} minutes`, async () => {
      let clock = 0
      const opened = new Map<string, number>()
      const methods: string[] = []
      const slack = async (method: string, body: Record<string, unknown>) => {
        methods.push(method)
        if (method === "chat.startStream") {
          const ts = `s${opened.size + 1}`
          opened.set(ts, clock)
          return { ok: true, ts }
        }
        if (method === "chat.appendStream" || method === "chat.stopStream") {
          const started = opened.get(String(body.ts))
          if (started === undefined || clock - started >= slackLifetimeMs) throw new SlackApiError("message_not_in_streaming_state")
        }
        return { ok: true }
      }
      let tick = 0
      const remote: RemoteCall = async () => {
        tick += 1
        return {
          status: tick >= 24 ? "idle" : "busy",
          messageCount: tick,
          finalAssistantText: Array.from({ length: tick }, (_, index) => `step ${index + 1}\n`).join(""),
          messages: [{ role: "assistant", toolCalls: [{ id: `c${tick}`, name: "Reading checks", status: "completed" }] }],
        }
      }
      let checkpoint = checkpointSchema.parse({ phase: "read", channel: "C1", threadTs: "1.0", sessionId: "hs_1", startedAt: 0, recipientUserId: "U1" })
      let done = false
      for (let poll = 0; poll < 40 && !done; poll += 1) {
        const result = await advanceSlackRun({ ...base, checkpoint, remote, slack, now: () => clock })
        checkpoint = result.checkpoint
        done = result.done === true
        clock += 30_000
      }
      expect(done).toBe(true)
      expect(checkpoint.sentText).toContain("step 24")
      expect(opened.size).toBeGreaterThanOrEqual(3)
      expect(methods.at(-1)).toBe("chat.postMessage")
    })
})

describe("long tasks go quiet and report back", () => {
  const base = { messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false, quietAfterMs: LONG_TASK_QUIET_AFTER_MS }
  const live = { phase: "read", channel: "C1", threadTs: "1.0", sessionId: "hs_1", recipientUserId: "U1", startedAt: 0 }
  const quiet = { ...live, quiet: true, lastCheckInAt: LONG_TASK_QUIET_AFTER_MS }
  function recorder() {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const slack = async (method: string, body: Record<string, unknown>) => {
      calls.push({ method, body })
      return { ok: true, ts: "9.0" }
    }
    return { calls, slack }
  }
  const busy = (text: string, toolCalls: Array<{ id: string; name: string; status: string }> = []): RemoteCall =>
    async () => ({ status: "busy", messageCount: 3, finalAssistantText: text, messages: [{ role: "assistant", toolCalls }] })

  test("after four minutes the live reply closes with one note; the session stays in progress so Stop still works", async () => {
    const { calls, slack } = recorder()
    const checkpoint = checkpointSchema.parse({ ...live, streamTs: "1.5", streamStartedAt: 5_000, sentText: "Looking at the PR.", steps: { c1: "running" } })
    const remote = busy("Looking at the PR.", [{ id: "c1", name: "Reading checks", status: "running" }])
    const early = await advanceSlackRun({ ...base, checkpoint, remote, slack, now: () => LONG_TASK_QUIET_AFTER_MS - 1 })
    expect(early.checkpoint.quiet).toBe(false)
    expect(calls).toHaveLength(0)

    const result = await advanceSlackRun({ ...base, checkpoint, remote, slack, now: () => LONG_TASK_QUIET_AFTER_MS })
    expect(calls).toEqual([
      {
        method: "chat.stopStream",
        body: { channel: "C1", ts: "1.5", session_status: "processing", chunks: [{ type: "markdown_text", text: `\n\n${LONG_TASK_LINE}` }] },
      },
    ])
    expect(result.checkpoint).toMatchObject({ quiet: true, streamTs: undefined, lastCheckInAt: LONG_TASK_QUIET_AFTER_MS })
  })

  test("a quiet task shows nothing new until its hourly check-in, and is read less often", async () => {
    const { calls, slack } = recorder()
    const remote = busy("Lots of progress notes.", [{ id: "c9", name: "Reading checks", status: "completed" }])
    const between = await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse(quiet), remote, slack, now: () => 30 * 60_000 })
    expect(calls).toHaveLength(0)
    expect(between.delayMs).toBe(5_000)

    const due = LONG_TASK_QUIET_AFTER_MS + CHECK_IN_EVERY_MS
    const result = await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse(quiet), remote, slack, now: () => due })
    expect(calls).toEqual([{ method: "chat.postMessage", body: { channel: "C1", thread_ts: "1.0", text: "Still working on it (1h 4m so far)." } }])
    expect(result.checkpoint.lastCheckInAt).toBe(due)
  })

  test("a quiet task posts only its final answer, with feedback buttons, then mentions the person", async () => {
    const { calls, slack } = recorder()
    const remote: RemoteCall = async () => ({
      status: "idle",
      messageCount: 4,
      finalAssistantText: "Looking at the checks.\n\nEvidence preview fails on a missing env var.",
      lastAssistantText: "Evidence preview fails on a missing env var.",
      messages: [],
    })
    const answered = await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse(quiet), remote, slack, now: () => 2 * 3_600_000 })
    expect(answered.checkpoint.phase).toBe("finish")
    const finish = await advanceSlackRun({ ...base, checkpoint: answered.checkpoint, remote, slack, now: () => 2 * 3_600_000 })
    expect(finish.done).toBe(true)
    expect(calls.map((call) => call.method)).toEqual(["chat.startStream", "chat.stopStream", "chat.postMessage"])
    expect(calls[0].body.chunks).toEqual([{ type: "markdown_text", text: "Evidence preview fails on a missing env var." }])
    expect(JSON.stringify(calls)).not.toContain("Looking at the checks")
    expect(JSON.stringify(calls[1].body.blocks)).toContain("feedback_buttons")
    expect(calls[2].body.text).toBe("<@U1> Done: Evidence preview fails on a missing env var.")
  })

  test("a task stuck repeating itself says so, and the mention asks for attention", async () => {
    const { calls, slack } = recorder()
    const remote: RemoteCall = async () => ({
      status: "idle",
      messageCount: 4,
      finalAssistantText: "",
      terminalError: { code: "stuck_repeating" },
      messages: [],
    })
    const stopped = await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse(quiet), remote, slack, now: () => 3_600_000 })
    await advanceSlackRun({ ...base, checkpoint: stopped.checkpoint, remote, slack, now: () => 3_600_000 })
    expect(JSON.stringify(calls[0].body.chunks)).toContain("I got stuck repeating the same step, so I stopped.")
    expect(calls.at(-1)?.body.text).toBe("<@U1> This task needs your attention. Details are above.")
  })

  test("a 3-hour task: a few live minutes, one note, two check-ins, then the answer — not a flood of messages", async () => {
    let clock = 0
    const opened = new Map<string, number>()
    const methods: string[] = []
    const posts: string[] = []
    const slack = async (method: string, body: Record<string, unknown>) => {
      methods.push(method)
      if (method === "chat.postMessage") posts.push(String(body.text))
      if (method === "chat.startStream") {
        const ts = `s${opened.size + 1}`
        opened.set(ts, clock)
        return { ok: true, ts }
      }
      if ((method === "chat.appendStream" || method === "chat.stopStream") && clock - (opened.get(String(body.ts)) ?? -Infinity) >= 5 * 60_000)
        throw new SlackApiError("message_not_in_streaming_state")
      return { ok: true }
    }
    let tick = 0
    const doneAt = 3 * 3_600_000
    const remote: RemoteCall = async () => {
      tick += 1
      const done = clock >= doneAt
      return {
        status: done ? "idle" : "busy",
        messageCount: tick,
        finalAssistantText: `note ${tick}\n${done ? "The final answer." : ""}`,
        lastAssistantText: done ? "The final answer." : `note ${tick}`,
        messages: [{ role: "assistant", toolCalls: [{ id: `c${tick}`, name: "Reading checks", status: "completed" }] }],
      }
    }
    let checkpoint = checkpointSchema.parse({ ...live, startedAt: 0 })
    let done = false
    for (let poll = 0; poll < 500 && !done; poll += 1) {
      const result = await advanceSlackRun({ ...base, checkpoint, remote, slack, now: () => clock })
      checkpoint = result.checkpoint
      done = result.done === true
      clock += 30_000
    }
    expect(done).toBe(true)
    expect(opened.size).toBe(2)
    expect(posts.filter((text) => text.startsWith("Still working on it ("))).toEqual([
      "Still working on it (1h 4m so far).",
      "Still working on it (2h 4m so far).",
    ])
    expect(posts.at(-1)).toBe("<@U1> Done: The final answer.")
    expect(methods.filter((method) => method === "chat.appendStream").length).toBeLessThan(10)
  })
})

test("elapsed time reads like a person would say it", () => {
  expect(formatElapsed(45_000)).toBe("0m")
  expect(formatElapsed(4 * 60_000)).toBe("4m")
  expect(formatElapsed(64 * 60_000)).toBe("1h 4m")
  expect(formatElapsed(8 * 3_600_000)).toBe("8h 0m")
})

test("labels and summaries are short and readable", () => {
  expect(stepLabel("search_capabilities")).toBe("Finding the right tool")
  expect(stepLabel("execute_capability", {})).toBe("Using your connections")
  expect(stepLabel("create_skill")).toBe("create skill")
  expect(doneSummary("\n\n> **Summary** of the week\nmore")).toBe("Summary of the week")
  expect(doneSummary("")).toBe("your answer is above.")
  expect(doneSummary("x".repeat(300)).length).toBe(140)
})

test("the runner-path prompt says Slack files and images can be opened", () => {
  const input = { event: { type: "app_mention", user: "U1", text: "<@B1> what is written here", files: [{ id: "F1", name: "image.png" }] }, teamId: "T1", botUserId: "B1", context: {}, privateReply: false }
  const headless = buildSlackPrompt({ ...input, webHandoff: false })
  expect(headless).toContain("Open them before saying you can't read them")
  expect(headless).toContain("F1")
  expect(buildSlackPrompt(input)).not.toContain("Open them before saying you can't read them")
})

describe("a busy workspace: nothing is blocked or silent", () => {
  const base = { messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false, quietAfterMs: LONG_TASK_QUIET_AFTER_MS }
  const reading = { phase: "read", channel: "C1", threadTs: "1.0", sessionId: "hs_1", recipientUserId: "U1", startedAt: 0 }
  function recorder() {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const slack = async (method: string, body: Record<string, unknown>) => {
      calls.push({ method, body })
      return { ok: true, ts: "9.0" }
    }
    return { calls, slack }
  }
  const busy = (extra: Record<string, unknown> = {}): RemoteCall => async () => ({
    status: "busy",
    messageCount: 2,
    finalAssistantText: "Looking at the checks.",
    messages: [{ role: "assistant", toolCalls: [{ id: "c1", name: "Reading checks", status: "running" }] }],
    ...extra,
  })

  test("without live progress a task makes no Slack calls while it works, then posts just its answer", async () => {
    const { calls, slack } = recorder()
    const checkpoint = checkpointSchema.parse({ ...reading, live: false })
    const working = await advanceSlackRun({ ...base, checkpoint, remote: busy(), slack, now: () => 60_000 })
    expect(calls).toHaveLength(0)
    expect(working.delayMs).toBe(3_000)

    const remote: RemoteCall = async () => ({
      status: "idle",
      messageCount: 4,
      finalAssistantText: "Looking at the checks.\n\nEvidence preview fails on a missing env var.",
      lastAssistantText: "Evidence preview fails on a missing env var.",
      messages: [],
    })
    const answered = await advanceSlackRun({ ...base, checkpoint: working.checkpoint, remote, slack, now: () => 90_000 })
    const finished = await advanceSlackRun({ ...base, checkpoint: answered.checkpoint, remote, slack, now: () => 90_000 })
    expect(finished.done).toBe(true)
    expect(calls.map((call) => call.method)).toEqual(["chat.startStream", "chat.stopStream", "chat.postMessage"])
    expect(calls[0].body.chunks).toEqual([{ type: "markdown_text", text: "Evidence preview fails on a missing env var." }])
    expect(JSON.stringify(calls[1].body.blocks)).toContain("feedback_buttons")
  })

  test("without live progress a long task still says it will report back", async () => {
    const { calls, slack } = recorder()
    const result = await advanceSlackRun({ ...base, checkpoint: checkpointSchema.parse({ ...reading, live: false }), remote: busy(), slack, now: () => LONG_TASK_QUIET_AFTER_MS })
    expect(calls).toEqual([
      { method: "chat.postMessage", body: { channel: "C1", thread_ts: "1.0", text: LONG_TASK_LINE } },
      { method: "agents.sessions.setStatus", body: { channel_id: "C1", thread_ts: "1.0", status: "processing" } },
    ])
    expect(result.checkpoint.quiet).toBe(true)
  })

  test("a live task sends text and step changes in one call, and is read every 3 seconds after its first 30", async () => {
    const { calls, slack } = recorder()
    const checkpoint = checkpointSchema.parse({ ...reading, streamTs: "1.5", streamStartedAt: 0 })
    const early = await advanceSlackRun({ ...base, checkpoint, remote: busy(), slack, now: () => 10_000 })
    expect(calls.map((call) => call.method)).toEqual(["chat.appendStream"])
    expect(calls[0].body.chunks).toEqual([
      { type: "markdown_text", text: "Looking at the checks." },
      expect.objectContaining({ type: "task_update", title: "Reading checks", status: "in_progress" }),
    ])
    expect(early.delayMs).toBe(1_000)
    const later = await advanceSlackRun({ ...base, checkpoint: early.checkpoint, remote: busy(), slack, now: () => 40_000 })
    expect(later.delayMs).toBe(3_000)
  })

  test("a task waiting for a free runner slot says so once", async () => {
    const { calls, slack } = recorder()
    const remote: RemoteCall = async () => ({ status: "busy", messageCount: 1, finalAssistantText: "", messages: [], waiting: true })
    const checkpoint = checkpointSchema.parse({ ...reading, live: false })
    const soon = await advanceSlackRun({ ...base, checkpoint, remote, slack, now: () => 5_000 })
    expect(calls).toHaveLength(0)
    const first = await advanceSlackRun({ ...base, checkpoint: soon.checkpoint, remote, slack, now: () => 20_000 })
    await advanceSlackRun({ ...base, checkpoint: first.checkpoint, remote, slack, now: () => 40_000 })
    expect(calls).toEqual([{ method: "chat.postMessage", body: { channel: "C1", thread_ts: "1.0", text: WAITING_LINE } }])
  })

  test("a follow-up in a thread whose runner session expired starts a fresh session instead of failing", async () => {
    const actions: string[] = []
    const saved: string[] = []
    const remote: RemoteCall = async (action) => {
      actions.push(action)
      if (action === "send" && actions.filter((entry) => entry === "send").length === 1) return { error: "unknown_session", retryable: false }
      if (action === "create") return { sessionId: "hs_new", workspaceId: "headless" }
      return {}
    }
    const { slack } = recorder()
    const input = { ...base, remote, slack, saveSession: async (sessionId: string) => void saved.push(sessionId) }
    let checkpoint = checkpointSchema.parse({ phase: "send", sessionId: "hs_expired", prompt: "follow up", channel: "C1", threadTs: "1.0" })
    for (let step = 0; step < 3 && checkpoint.phase !== "read"; step += 1) checkpoint = (await advanceSlackRun({ ...input, checkpoint })).checkpoint
    expect(actions).toEqual(["send", "create", "send"])
    expect(saved).toEqual(["hs_new"])
    expect(checkpoint).toMatchObject({ phase: "read", sessionId: "hs_new" })
  })

  test("the runner reports a queued turn as waiting", async () => {
    const { deps } = runner([snapshot({ status: "queued" }, [])])
    expect(await headlessRemoteCall(actor, "read", { sessionId: "hs_1", messageId: "msg_1" }, deps)).toMatchObject({ status: "busy", waiting: true })
  })
})
