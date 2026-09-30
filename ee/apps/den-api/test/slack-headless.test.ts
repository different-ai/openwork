import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { isHeadlessRunMcpToken } from "../src/mcp/headless-run-token.js"
import {
  headlessRemoteCall,
  headlessRunnerConfig,
  slackRuntimeForOrganization,
  stepLabel,
  type HeadlessDeps,
} from "../src/slack-assistant/headless.js"
import { advanceSlackRun, checkpointSchema, doneSummary, type RemoteCall } from "../src/slack-assistant/run.js"

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

  test("read maps a running turn to busy with labelled steps", async () => {
    const { deps } = runner([
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
    await advanceSlackRun({ checkpoint, remote, slack, messageId: "msg_1", saveSession: async () => {}, title: "t", webHandoff: false, now: () => 90_000 })
    expect(JSON.stringify(calls)).not.toContain("OpenWork Web")
    expect(calls.at(-1)).toEqual({ method: "chat.postMessage", body: { channel: "C1", thread_ts: "1.0", text: "<@U1> Done: Digest" } })
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

test("labels and summaries are short and readable", () => {
  expect(stepLabel("search_capabilities")).toBe("Finding the right tool")
  expect(stepLabel("execute_capability", {})).toBe("Using your connections")
  expect(stepLabel("create_skill")).toBe("create skill")
  expect(doneSummary("\n\n> **Summary** of the week\nmore")).toBe("Summary of the week")
  expect(doneSummary("")).toBe("your answer is above.")
  expect(doneSummary("x".repeat(300)).length).toBe(140)
})
