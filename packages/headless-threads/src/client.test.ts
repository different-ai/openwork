import { createServer, type Server } from "node:http";
import { describe, expect, test } from "bun:test";

import { createHeadlessThreadClient } from "./client.js";
import { HeadlessThreadError } from "./errors.js";
import type { HeadlessFetch, HeadlessThreadStatus } from "./types.js";

type RecordedRequest = {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
  redirect: RequestRedirect | undefined;
  signal: AbortSignal | undefined;
};
type MessageWire = { info: { id: string; role: string; parentID?: string; time?: { created: number }; error?: unknown; tokens?: unknown; cost?: number }; parts: unknown[] };
/** One poll's worth of thread state, consumed in order by snapshot reads. */
type Beat = { status: HeadlessThreadStatus; messages: MessageWire[] };

const SESSION_ID = "ses_1";
const BASE_URL = "http://openwork.test";

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function serverUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  return `http://127.0.0.1:${address.port}`;
}

function reply(id: string, role: string, text?: string, parentID?: string): MessageWire {
  return {
    info: { id, role, time: { created: 1 }, ...(parentID ? { parentID } : {}) },
    parts: text === undefined ? [] : [{ id: `prt_${id}`, type: "text", text }],
  };
}

/**
 * A stand-in for the OpenWork server's native OpenCode proxy. `beats` scripts what
 * successive snapshot reads observe, so a wait can be tested without a clock
 * or an engine.
 */
function createOpenworkDouble(input?: { beats?: Beat[]; messages?: MessageWire[]; abortResult?: boolean }) {
  const requests: RecordedRequest[] = [];
  const beats = input?.beats ?? [];
  const messages = input?.messages ?? [];
  let beatIndex = 0;
  let activeBeat: Beat | undefined;

  const session = { id: SESSION_ID, title: "Refund policy", directory: "/workspace", time: { created: 1 } };

  const fetchImpl: HeadlessFetch = async (url, init) => {
    const parsed = new URL(url);
    const method = init?.method ?? "GET";
    const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body);
    requests.push({
      method,
      path: `${parsed.pathname}${parsed.search}`,
      body,
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      signal: init?.signal,
    });

    if (method === "POST" && parsed.pathname === "/workspace/ws_1/opencode/session") {
      return Response.json(session);
    }
    if (method === "GET" && parsed.pathname === `/workspace/ws_1/opencode/session/${SESSION_ID}`) {
      activeBeat = beats[Math.min(beatIndex, beats.length - 1)];
      beatIndex += 1;
      return Response.json(session);
    }
    if (method === "GET" && parsed.pathname === `/workspace/ws_1/opencode/session/${SESSION_ID}/message`) {
      return Response.json(activeBeat?.messages ?? messages);
    }
    if (method === "GET" && parsed.pathname === `/workspace/ws_1/opencode/session/${SESSION_ID}/todo`) {
      return Response.json([]);
    }
    if (method === "GET" && parsed.pathname === "/workspace/ws_1/opencode/session/status") {
      const status = activeBeat?.status;
      return Response.json(status === undefined || status.type === "idle" ? {} : { [SESSION_ID]: status });
    }
    if (method === "POST" && parsed.pathname === `/workspace/ws_1/opencode/session/${SESSION_ID}/prompt_async`) {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && parsed.pathname === `/workspace/ws_1/opencode/session/${SESSION_ID}/abort`) {
      return Response.json(input?.abortResult ?? true);
    }
    return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
  };

  return { fetchImpl, requests, snapshotReads: () => beatIndex };
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
  test("creates first, then submits the initial prompt in OpenCode's casing", async () => {
    const double = createOpenworkDouble();
    const thread = await createClient(double).createThread({
      title: "Refund policy",
      prompt: "A customer wants a refund after 40 days.",
      model: { providerId: "anthropic", modelId: "claude-sonnet-5", variant: "thinking" },
    });

    expect(double.requests.map(({ method, path }) => ({ method, path }))).toEqual([
      { method: "POST", path: "/workspace/ws_1/opencode/session" },
      { method: "POST", path: "/workspace/ws_1/opencode/session/ses_1/prompt_async" },
    ]);
    expect(double.requests[0]?.body).toEqual({ title: "Refund policy" });
    expect(double.requests[1]?.body).toEqual({
      parts: [{ type: "text", text: "A customer wants a refund after 40 days." }],
      model: { providerID: "anthropic", modelID: "claude-sonnet-5" },
      variant: "thinking",
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

    expect(double.requests[0]?.path).toBe("/workspace/ws_1/opencode/session");
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

    expect(double.requests[0]?.headers.get("authorization")).toBe("Bearer client-token");
    expect(double.requests[0]?.headers.get("x-openwork-host-token")).toBe("host-token");
    expect(double.requests[0]?.redirect).toBe("error");
  });

  test("omits the optional host token", async () => {
    const double = createOpenworkDouble();

    await createClient(double).createThread({ title: "Local" });

    expect(double.requests[0]?.headers.get("authorization")).toBe("Bearer owt_test");
    expect(double.requests[0]?.headers.has("x-openwork-host-token")).toBe(false);
  });

  test("omits the prompt and model when none were given", async () => {
    const double = createOpenworkDouble();
    const thread = await createClient(double).createThread({ title: "Empty" });

    expect(double.requests[0]?.body).toEqual({ title: "Empty" });
    expect(double.requests).toHaveLength(1);
    expect(thread.started).toBe(false);
  });

  test("treats an explicitly empty initial prompt as not started", async () => {
    const double = createOpenworkDouble();

    const thread = await createClient(double).createThread({ title: "Empty prompt", prompt: "" });

    expect(double.requests).toHaveLength(1);
    expect(thread.started).toBe(false);
  });

  test("preserves client validation and normalization for initial title and prompt", async () => {
    const double = createOpenworkDouble();
    const client = createClient(double);

    await client.createThread({ title: "  Refund policy  ", prompt: "  Review it  " });
    expect(double.requests[0]?.body).toEqual({ title: "Refund policy" });
    expect(double.requests[1]?.body).toEqual({ parts: [{ type: "text", text: "Review it" }] });

    await expect(client.createThread({ title: "  " })).rejects.toMatchObject({
      code: "invalid_payload",
      status: 400,
    });
    await expect(client.createThread({ title: "Valid", prompt: "  " })).rejects.toMatchObject({
      code: "invalid_payload",
      status: 400,
    });
    await expect(client.createThread({ title: "x".repeat(121) })).rejects.toMatchObject({
      code: "invalid_payload",
      status: 400,
    });
    await expect(client.createThread({ title: "Valid", prompt: "x".repeat(100_001) })).rejects.toMatchObject({
      code: "invalid_payload",
      status: 400,
    });
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
      "/workspace/ws_1/opencode/session/ses_1/message",
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
    expect(double.requests[0]?.path).toBe("/workspace/ws_1/opencode/session/ses_1/message");
  });

  test("passes a new stable message id to OpenCode", async () => {
    const double = createOpenworkDouble({ messages: [] });

    await createClient(double).sendTurn(SESSION_ID, { prompt: "Run it.", messageId: "msg_run_2" });

    expect(double.requests[1]?.body).toEqual({
      parts: [{ type: "text", text: "Run it." }],
      messageID: "msg_run_2",
    });
  });

  test("URL-encodes workspace and session IDs on native proxy calls", async () => {
    const paths: string[] = [];
    const fetchImpl: HeadlessFetch = async (url) => {
      const path = new URL(url).pathname;
      paths.push(path);
      if (path.endsWith("/message")) return Response.json([]);
      return new Response(null, { status: 204 });
    };
    const client = createHeadlessThreadClient({
      baseUrl: BASE_URL,
      workspaceId: "ws /?",
      token: "owt_test",
      fetch: fetchImpl,
    });

    await client.sendTurn("ses /?", { prompt: "hello" });

    expect(paths).toEqual([
      "/workspace/ws%20%2F%3F/opencode/session/ses%20%2F%3F/message",
      "/workspace/ws%20%2F%3F/opencode/session/ses%20%2F%3F/prompt_async",
    ]);
  });
});

describe("getThreadSnapshot", () => {
  test("reads session, messages, todos, and status in parallel", async () => {
    const requests: string[] = [];
    let markStarted: () => void = () => {};
    let releaseRequests: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const fetchImpl: HeadlessFetch = async (url) => {
      const path = new URL(url).pathname;
      requests.push(path);
      if (requests.length === 4) markStarted();
      await released;
      if (path.endsWith("/message")) return Response.json([]);
      if (path.endsWith("/todo")) return Response.json([{ content: "Check", status: "pending", priority: "high" }]);
      if (path.endsWith("/status")) return Response.json({ [SESSION_ID]: { type: "busy" } });
      return Response.json({ id: SESSION_ID, title: "Refund policy", directory: "/workspace", time: { created: 1 } });
    };
    const client = createHeadlessThreadClient({ baseUrl: BASE_URL, workspaceId: "ws_1", token: "owt_test", fetch: fetchImpl });

    const pending = client.getThreadSnapshot(SESSION_ID);
    await allStarted;
    expect(requests).toEqual([
      "/workspace/ws_1/opencode/session/ses_1",
      "/workspace/ws_1/opencode/session/ses_1/message",
      "/workspace/ws_1/opencode/session/ses_1/todo",
      "/workspace/ws_1/opencode/session/status",
    ]);
    releaseRequests();

    await expect(pending).resolves.toMatchObject({
      threadId: SESSION_ID,
      status: { type: "busy" },
      todos: [{ content: "Check", status: "pending", priority: "high" }],
    });
  });

  test("falls back to idle when the native status map omits the session", async () => {
    const snapshot = await createClient(createOpenworkDouble()).getThreadSnapshot(SESSION_ID);

    expect(snapshot.status).toEqual({ type: "idle" });
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

  test("aborting mid-wait stops polling after the in-flight beat and never calls abortThread implicitly", async () => {
    const controller = new AbortController();
    const clock = createClock();
    // The turn never settles: every beat reports a busy engine.
    const double = createOpenworkDouble({
      beats: [{ status: { type: "busy" }, messages: [reply("msg_1", "user")] }],
    });
    // Abort while the wait sleeps between polls — mid-stream, not before the call.
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      controller.abort();
    };
    const client = createHeadlessThreadClient({
      baseUrl: BASE_URL,
      workspaceId: "ws_1",
      token: "owt_test",
      fetch: double.fetchImpl,
      now: clock.now,
      sleep,
    });

    const result = await client.waitForThread(SESSION_ID, {
      timeoutMs: 10_000,
      pollIntervalMs: 100,
      signal: controller.signal,
    });

    expect(result.outcome).toBe("aborted");
    expect(result.observedRunning).toBe(true);
    // Exactly one live poll happened before the abort; the final snapshot read
    // documents state at abort time instead of counting as a poll.
    expect(result.polls).toBe(1);
    expect(double.snapshotReads()).toBe(2);
    // Cancelling a wait must never cancel the engine turn on the caller's behalf.
    expect(double.requests.some((request) => request.path.endsWith("/abort"))).toBe(false);
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
    expect(error.path).toBe("/workspace/ws_1/opencode/session/ses_missing");
    expect(error.message).toBe("Not found");
    expect(error.body).toEqual({ code: "not_found", message: "Not found" });
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

    const error = await client.getThreadSnapshot(SESSION_ID).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HeadlessThreadError);
    if (!(error instanceof HeadlessThreadError)) throw new Error("expected a HeadlessThreadError");
    expect(error.code).toBe("request_failed");
    expect(error.method).toBe("GET");
    expect(error.path).toBe("/workspace/ws_1/opencode/session/ses_1");
    expect(error.status).toBeNull();
  });

  test("defaults individual request timeouts to 15 seconds", async () => {
    const originalTimeout = AbortSignal.timeout;
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    if (!timeoutDescriptor) throw new Error("AbortSignal.timeout is unavailable");
    const requested: number[] = [];
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (milliseconds: number) => {
        requested.push(milliseconds);
        return originalTimeout(milliseconds);
      },
    });
    try {
      await createClient(createOpenworkDouble()).createThread({ title: "Default timeout" });
      expect(requested).toEqual([15_000]);
    } finally {
      Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    }
  });

  test("disables request timeouts when configured with zero", async () => {
    const originalTimeout = AbortSignal.timeout;
    const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
    if (!timeoutDescriptor) throw new Error("AbortSignal.timeout is unavailable");
    const requested: number[] = [];
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      value: (milliseconds: number) => {
        requested.push(milliseconds);
        return originalTimeout(milliseconds);
      },
    });
    const double = createOpenworkDouble();
    const client = createHeadlessThreadClient({
      baseUrl: BASE_URL,
      workspaceId: "ws_1",
      token: "owt_test",
      fetch: double.fetchImpl,
      requestTimeoutMs: 0,
    });

    try {
      await client.createThread({ title: "No timeout" });
      expect(requested).toEqual([]);
      expect(double.requests[0]?.signal?.aborted).toBe(false);
    } finally {
      Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    }
  });

  test("merges the client-wide and per-call signals into SDK requests", async () => {
    const globalController = new AbortController();
    const callController = new AbortController();
    const first = createOpenworkDouble();
    const firstClient = createHeadlessThreadClient({
      baseUrl: BASE_URL,
      workspaceId: "ws_1",
      token: "owt_test",
      signal: globalController.signal,
      fetch: first.fetchImpl,
    });
    await firstClient.createThread({ title: "Global signal", signal: callController.signal });
    const firstSignal = first.requests[0]?.signal;
    expect(firstSignal?.aborted).toBe(false);
    globalController.abort();
    expect(firstSignal?.aborted).toBe(true);

    const secondGlobal = new AbortController();
    const secondCall = new AbortController();
    const second = createOpenworkDouble();
    const secondClient = createHeadlessThreadClient({
      baseUrl: BASE_URL,
      workspaceId: "ws_1",
      token: "owt_test",
      signal: secondGlobal.signal,
      fetch: second.fetchImpl,
    });
    await secondClient.createThread({ title: "Call signal", signal: secondCall.signal });
    const secondSignal = second.requests[0]?.signal;
    expect(secondSignal?.aborted).toBe(false);
    secondCall.abort();
    expect(secondSignal?.aborted).toBe(true);
  });

  test("a custom Cloud fetch cannot follow a 307 with the thread body or tokens", async () => {
    const targetRequests: Array<{ authorization: string | undefined; hostToken: string | undefined }> = [];
    const target = createServer((request, response) => {
      targetRequests.push({
        authorization: request.headers.authorization,
        hostToken: typeof request.headers["x-openwork-host-token"] === "string" ? request.headers["x-openwork-host-token"] : undefined,
      });
      response.end("unexpected");
    });
    const preview = createServer((_request, response) => {
      response.writeHead(307, { Location: `${serverUrl(target)}/captured` });
      response.end();
    });
    await Promise.all([listen(target), listen(preview)]);
    try {
      const client = createHeadlessThreadClient({
        baseUrl: serverUrl(preview),
        workspaceId: "ws_1",
        token: "client-secret",
        hostToken: "host-secret",
        fetch: (url, init) => fetch(url, init),
      });

      await expect(client.createThread({ title: "Secret thread" })).rejects.toBeDefined();
      expect(targetRequests).toEqual([]);
    } finally {
      await Promise.all([close(preview), close(target)]);
    }
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

  test("preserves a native false abort result", async () => {
    const double = createOpenworkDouble({ abortResult: false });

    await expect(createClient(double).abortThread(SESSION_ID)).resolves.toEqual({
      threadId: SESSION_ID,
      accepted: false,
    });
    expect(double.requests[0]?.path).toBe("/workspace/ws_1/opencode/session/ses_1/abort");
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
