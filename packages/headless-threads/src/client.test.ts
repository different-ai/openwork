import { describe, expect, test } from "bun:test";

import { createHeadlessThreadClient } from "./client.js";
import { HeadlessThreadError } from "./errors.js";
import type { HeadlessFetch, HeadlessThreadStatus } from "./types.js";

type RecordedRequest = { method: string; path: string; body: unknown };
type MessageWire = { info: { id: string; role: string; parentID?: string; time?: { created: number }; error?: unknown; tokens?: unknown; cost?: number }; parts: unknown[] };
/** One poll's worth of thread state, consumed in order by snapshot reads. */
type Beat = { status: HeadlessThreadStatus; messages: MessageWire[] };

const SESSION_ID = "ses_1";
const BASE_URL = "http://openwork.test";

function reply(id: string, role: string, text?: string, parentID?: string): MessageWire {
  return {
    info: { id, role, time: { created: 1 }, ...(parentID ? { parentID } : {}) },
    parts: text === undefined ? [] : [{ id: `prt_${id}`, type: "text", text }],
  };
}

/**
 * A stand-in for the OpenWork server's session routes. `beats` scripts what
 * successive snapshot reads observe, so a wait can be tested without a clock
 * or an engine.
 */
function createOpenworkDouble(input?: { beats?: Beat[]; messages?: MessageWire[] }) {
  const requests: RecordedRequest[] = [];
  const requestHeaders: Headers[] = [];
  const beats = input?.beats ?? [];
  const messages = input?.messages ?? [];
  let beatIndex = 0;

  const session = { id: SESSION_ID, title: "Refund policy", directory: "/workspace", time: { created: 1 } };

  const fetchImpl: HeadlessFetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({ method, path: `${parsed.pathname}${parsed.search}`, body });
    requestHeaders.push(new Headers(init?.headers));

    if (method === "POST" && parsed.pathname === "/workspace/ws_1/sessions") {
      const started = typeof body === "object" && body !== null && "prompt" in body;
      return Response.json({ item: session, started }, { status: 201 });
    }
    if (method === "GET" && parsed.pathname === `/workspace/ws_1/sessions/${SESSION_ID}/messages`) {
      return Response.json({ items: messages });
    }
    if (method === "GET" && parsed.pathname === `/workspace/ws_1/sessions/${SESSION_ID}/snapshot`) {
      const beat = beats[Math.min(beatIndex, beats.length - 1)];
      beatIndex += 1;
      return Response.json({
        item: {
          session,
          messages: beat === undefined ? messages : beat.messages,
          todos: [],
          status: beat === undefined ? { type: "idle" } : beat.status,
        },
      });
    }
    if (method === "POST" && parsed.pathname === `/workspace/ws_1/opencode/session/${SESSION_ID}/prompt_async`) {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && parsed.pathname === `/workspace/ws_1/sessions/${SESSION_ID}/abort`) {
      return Response.json({ ok: true });
    }
    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  };

  return { fetchImpl, requests, requestHeaders, snapshotReads: () => beatIndex };
}

/** A clock that only moves when the client sleeps, so waits are instant. */
function createClock() {
  let clock = 0;
  return {
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    elapsed: () => clock,
  };
}

function createClient(double: ReturnType<typeof createOpenworkDouble>, clock = createClock()) {
  return createHeadlessThreadClient({
    baseUrl: BASE_URL,
    workspaceId: "ws_1",
    token: "owt_test",
    fetch: double.fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
  });
}

describe("createThread", () => {
  test("sends the title, prompt, and model in OpenWork's casing", async () => {
    const double = createOpenworkDouble();
    const thread = await createClient(double).createThread({
      title: "Refund policy",
      prompt: "A customer wants a refund after 40 days.",
      model: { providerId: "anthropic", modelId: "claude-sonnet-5", variant: "thinking" },
    });

    expect(double.requests[0]).toEqual({
      method: "POST",
      path: "/workspace/ws_1/sessions",
      body: {
        title: "Refund policy",
        prompt: "A customer wants a refund after 40 days.",
        providerId: "anthropic",
        modelId: "claude-sonnet-5",
        variant: "thinking",
      },
    });
    expect(thread).toEqual({
      id: SESSION_ID,
      workspaceId: "ws_1",
      title: "Refund policy",
      directory: "/workspace",
      createdAt: 1,
      started: true,
    });
  });

  test("normalizes a base URL that ends in slashes", async () => {
    const double = createOpenworkDouble();
    const client = createHeadlessThreadClient({
      baseUrl: `${BASE_URL}///`,
      workspaceId: "ws_1",
      token: "owt_test",
      fetch: double.fetchImpl,
    });

    await client.createThread({ title: "Refund policy" });

    expect(double.requests[0]?.path).toBe("/workspace/ws_1/sessions");
  });

  test("authenticates server-to-server Cloud requests with both worker tokens", async () => {
    const double = createOpenworkDouble();
    const client = createHeadlessThreadClient({
      baseUrl: BASE_URL,
      workspaceId: "ws_1",
      token: "client-token",
      hostToken: "host-token",
      fetch: double.fetchImpl,
    });

    await client.createThread({ title: "Cloud Automation" });

    expect(double.requestHeaders[0]?.get("authorization")).toBe("Bearer client-token");
    expect(double.requestHeaders[0]?.get("x-openwork-host-token")).toBe("host-token");
  });

  test("omits the prompt and model when none were given", async () => {
    const double = createOpenworkDouble();
    const thread = await createClient(double).createThread({ title: "Empty" });

    expect(double.requests[0]?.body).toEqual({ title: "Empty" });
    expect(thread.started).toBe(false);
  });
});

describe("sendTurn", () => {
  test("records the pre-turn message count and prompts in OpenCode's casing", async () => {
    const double = createOpenworkDouble({ messages: [reply("msg_1", "user"), reply("msg_2", "assistant", "hi")] });
    const acceptance = await createClient(double).sendTurn(SESSION_ID, {
      prompt: "They also lost the receipt.",
      model: { providerId: "anthropic", modelId: "claude-sonnet-5" },
    });

    expect(acceptance).toEqual({
      threadId: SESSION_ID,
      acceptedAt: 0,
      messageCountBefore: 2,
      messageId: null,
      alreadyPresent: false,
    });
    expect(double.requests.map((request) => request.path)).toEqual([
      "/workspace/ws_1/sessions/ses_1/messages",
      "/workspace/ws_1/opencode/session/ses_1/prompt_async",
    ]);
    expect(double.requests[1]?.body).toEqual({
      parts: [{ type: "text", text: "They also lost the receipt." }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
    });
  });

  test("falls back to the client's default model", async () => {
    const double = createOpenworkDouble({ messages: [] });
    const client = createHeadlessThreadClient({
      baseUrl: BASE_URL,
      workspaceId: "ws_1",
      token: "owt_test",
      fetch: double.fetchImpl,
      defaultModel: { providerId: "openai", modelId: "gpt-5" },
    });

    await client.sendTurn(SESSION_ID, { prompt: "hello" });

    expect(double.requests[1]?.body).toEqual({
      parts: [{ type: "text", text: "hello" }],
      model: { providerID: "openai", modelID: "gpt-5" },
    });
  });

  test("uses a stable message id and does not submit it twice", async () => {
    const double = createOpenworkDouble({ messages: [reply("msg_run_1", "user")] });

    const acceptance = await createClient(double).sendTurn(SESSION_ID, {
      prompt: "Run the report.",
      messageId: "msg_run_1",
    });

    expect(acceptance.alreadyPresent).toBe(true);
    expect(acceptance.messageId).toBe("msg_run_1");
    expect(double.requests).toHaveLength(1);
    expect(double.requests[0]?.path).toBe("/workspace/ws_1/sessions/ses_1/messages");
  });

  test("passes a new stable message id to OpenCode", async () => {
    const double = createOpenworkDouble({ messages: [] });

    await createClient(double).sendTurn(SESSION_ID, { prompt: "Run it.", messageId: "msg_run_2" });

    expect(double.requests[1]?.body).toEqual({
      parts: [{ type: "text", text: "Run it." }],
      messageID: "msg_run_2",
    });
  });
});

describe("waitForThread", () => {
  test("does not call an idle thread finished before the engine has started", async () => {
    // The first beat is the gap between accepting a prompt and starting work:
    // the thread is idle and has no new reply. Settling there would report a
    // turn finished before it began.
    const double = createOpenworkDouble({
      beats: [
        { status: { type: "idle" }, messages: [reply("msg_1", "user")] },
        { status: { type: "busy" }, messages: [reply("msg_1", "user")] },
        { status: { type: "retry", attempt: 1, message: "rate limited", next: 5 }, messages: [reply("msg_1", "user")] },
        { status: { type: "idle" }, messages: [reply("msg_1", "user"), reply("msg_2", "assistant", "Answer.")] },
      ],
    });

    const result = await createClient(double).waitForThread(SESSION_ID, { timeoutMs: 10_000, pollIntervalMs: 100 });

    expect(result.outcome).toBe("settled");
    expect(result.polls).toBe(4);
    expect(result.observedRunning).toBe(true);
    expect(result.waitedMs).toBe(300);
    expect(result.snapshot.status).toEqual({ type: "idle" });
  });

  test("ignores an assistant reply that predates the turn being waited on", async () => {
    const before = [reply("msg_1", "user"), reply("msg_2", "assistant", "First answer.")];
    const double = createOpenworkDouble({
      beats: [
        { status: { type: "idle" }, messages: before },
        { status: { type: "idle" }, messages: [...before, reply("msg_3", "user")] },
        { status: { type: "idle" }, messages: [...before, reply("msg_3", "user"), reply("msg_4", "assistant", "Second.")] },
      ],
    });

    const result = await createClient(double).waitForThread(SESSION_ID, {
      timeoutMs: 10_000,
      pollIntervalMs: 100,
      since: { messageCountBefore: 2 },
    });

    expect(result.outcome).toBe("settled");
    expect(result.polls).toBe(3);
    expect(result.snapshot.messages.at(-1)?.id).toBe("msg_4");
  });

  test("reports a timeout instead of throwing when the thread never answers", async () => {
    const clock = createClock();
    const double = createOpenworkDouble({
      beats: [{ status: { type: "busy" }, messages: [reply("msg_1", "user")] }],
    });

    const result = await createClient(double, clock).waitForThread(SESSION_ID, {
      timeoutMs: 1_000,
      pollIntervalMs: 400,
    });

    expect(result.outcome).toBe("timeout");
    expect(result.observedRunning).toBe(true);
    expect(clock.elapsed()).toBe(1_000);
    expect(result.waitedMs).toBe(1_000);
  });

  test("stops on an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const double = createOpenworkDouble({
      beats: [{ status: { type: "busy" }, messages: [] }],
    });

    const result = await createClient(double).waitForThread(SESSION_ID, {
      timeoutMs: 10_000,
      signal: controller.signal,
    });

    expect(result.outcome).toBe("aborted");
    expect(result.polls).toBe(0);
  });

  test("matches the assistant response to the stable user message", async () => {
    const double = createOpenworkDouble({
      beats: [{
        status: { type: "idle" },
        messages: [
          reply("msg_old_answer", "assistant", "old", "msg_old"),
          reply("msg_new_answer", "assistant", "new", "msg_run_1"),
        ],
      }],
    });

    const result = await createClient(double).waitForThread(SESSION_ID, {
      timeoutMs: 1_000,
      since: { messageCountBefore: 2, messageId: "msg_run_1" },
    });

    expect(result.outcome).toBe("settled");
  });

  test("reports a terminal assistant error", async () => {
    const failed = reply("msg_failed", "assistant", undefined, "msg_run_1");
    failed.info.error = { name: "ProviderAuthError", data: { message: "Reconnect the provider." } };
    const double = createOpenworkDouble({ beats: [{ status: { type: "idle" }, messages: [failed] }] });

    const result = await createClient(double).waitForThread(SESSION_ID, {
      timeoutMs: 1_000,
      since: { messageCountBefore: 0, messageId: "msg_run_1" },
    });

    expect(result.outcome).toBe("failed");
    expect(result.terminalError).toMatchObject({ name: "ProviderAuthError", message: "Reconnect the provider." });
  });
});

describe("failures", () => {
  test("surfaces the server's error code and status", async () => {
    const double = createOpenworkDouble();
    const client = createClient(double);

    const error = await client.getThreadSnapshot("ses_missing").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HeadlessThreadError);
    if (!(error instanceof HeadlessThreadError)) throw new Error("expected a HeadlessThreadError");
    expect(error.code).toBe("not_found");
    expect(error.status).toBe(404);
    expect(error.method).toBe("GET");
    expect(error.path).toBe("/workspace/ws_1/sessions/ses_missing/snapshot");
  });

  test("rejects a payload that does not match the session read model", async () => {
    const fetchImpl: HeadlessFetch = async () => Response.json({ item: { session: { id: 7 } } });
    const client = createHeadlessThreadClient({
      baseUrl: BASE_URL,
      workspaceId: "ws_1",
      token: "owt_test",
      fetch: fetchImpl,
    });

    const error = await client.getThreadSnapshot(SESSION_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HeadlessThreadError);
    if (!(error instanceof HeadlessThreadError)) throw new Error("expected a HeadlessThreadError");
    expect(error.code).toBe("invalid_response");
  });

  test("bounds an individual request even when the caller has no deadline", async () => {
    const fetchImpl: HeadlessFetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const client = createHeadlessThreadClient({
      baseUrl: BASE_URL,
      workspaceId: "ws_1",
      token: "owt_test",
      fetch: fetchImpl,
      requestTimeoutMs: 5,
    });

    await expect(client.getThreadSnapshot(SESSION_ID)).rejects.toBeDefined();
  });
});

describe("abortThread", () => {
  test("reports acceptance without claiming the run stopped", async () => {
    const double = createOpenworkDouble();

    await expect(createClient(double).abortThread(SESSION_ID)).resolves.toEqual({
      threadId: SESSION_ID,
      accepted: true,
    });
  });

  test("waits until the aborted thread is observably idle", async () => {
    const double = createOpenworkDouble({ beats: [
      { status: { type: "busy" }, messages: [] },
      { status: { type: "idle" }, messages: [] },
    ] });

    const result = await createClient(double).waitUntilIdle(SESSION_ID, { timeoutMs: 1_000, pollIntervalMs: 10 });

    expect(result.outcome).toBe("settled");
    expect(result.observedRunning).toBe(true);
  });
});

describe("exportTranscript", () => {
  test("flattens the current snapshot", async () => {
    const double = createOpenworkDouble({
      beats: [
        {
          status: { type: "idle" },
          messages: [reply("msg_1", "user", "Why?"), reply("msg_2", "assistant", "Because.")],
        },
      ],
    });

    const transcript = await createClient(double).exportTranscript(SESSION_ID);

    expect(transcript.threadId).toBe(SESSION_ID);
    expect(transcript.finalAssistantText).toBe("Because.");
    expect(transcript.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });
});
