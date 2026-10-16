import { describe, expect, test } from "bun:test";
import { focusManager } from "@tanstack/react-query";
import type { Message, Part, Session, SessionStatus, Todo } from "../src/app/lib/opencode-types";

import { unwrap, type FieldsResult } from "../src/app/lib/opencode";
import { interruptSessionTurn, submitAfterInterruption, submitImmediateSessionTurn } from "../src/app/lib/opencode-interruption";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { resolveForkBoundaryId } from "../src/react-app/domains/session/sync/transcript-reconcile";
import {
  composeNativeSessionHistory,
  composeNativeSessionHistoryWithRetry,
  composeNativeSessionSnapshot,
  composeNativeSessionSnapshotWithRetry,
  deleteNativeSession,
  getNativeSession,
  getNativeSessionMessages,
  type NativeSessionOperations,
} from "../src/app/lib/opencode-session-native";

const endpoint = {
  opencodeBaseUrl: "https://worker.example/workspace/ws-native/opencode",
  token: "workspace-token",
};

const session = {
  id: "ses_native",
  projectID: "project-native",
  directory: "/workspace/native",
  title: "Native session",
  version: "1",
  time: { created: 1, updated: 2 },
} as Session;
const messages = [{
  info: { id: "msg_1", sessionID: session.id, role: "user", time: { created: 1 } } as Message,
  parts: [{ id: "part_1", sessionID: session.id, messageID: "msg_1", type: "text", text: "hello" } as Part],
}];
const todos = [{ id: "todo_1", content: "Ship", status: "pending", priority: "high" }] as Todo[];

function result<T>(data: T, status = 200): FieldsResult<T> {
  return {
    data,
    request: new Request(endpoint.opencodeBaseUrl),
    response: new Response(null, { status }),
  };
}

function failedResult(error: unknown, status: number): FieldsResult<never> {
  return {
    error,
    request: new Request(endpoint.opencodeBaseUrl),
    response: new Response(null, { status }),
  };
}

function operations(overrides: Partial<NativeSessionOperations> = {}): NativeSessionOperations {
  return {
    get: async () => result(session),
    messages: async () => result(messages),
    todo: async () => result(todos),
    status: async () => result<Record<string, SessionStatus>>({ [session.id]: { type: "busy" } }),
    delete: async () => result(true),
    ...overrides,
  };
}

async function withSessionFetch(
  respond: (request: Request) => Response | Promise<Response>,
  run: (requests: Request[]) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const requests: Request[] = [];
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const url = new URL(request.url);
      // The engine serves these fixtures' directories as given; no symlink resolution applies.
      if (request.method === "GET" && url.pathname.endsWith("/path")) {
        const directory = url.searchParams.get("directory") ?? "";
        return Promise.resolve(Response.json({ home: "/", state: "/", config: "/", worktree: directory, directory }));
      }
      return Promise.resolve(respond(request));
    },
  });
  try {
    await run(requests);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function delegatedTool(childID: string, state: Record<string, unknown> = {}, tool = "task") {
  return {
    type: "tool", tool, id: `part_${childID}`, callID: `call_${childID}`,
    state: { status: "running", input: {}, metadata: { sessionId: childID }, time: { start: 1 }, ...state },
  };
}

function turnMessages(sessionID: string, parts: ReturnType<typeof delegatedTool>[] = [], messageID = "msg_current") {
  return [
    { info: { id: messageID, sessionID, role: "user", time: { created: 1 } }, parts: [] },
    { info: { id: `${messageID}_reply`, sessionID, role: "assistant", time: { created: 2 } }, parts },
  ];
}

describe("native OpenCode session operations", () => {
  test("v2 history normalizes descending pages chronologically so forks use the following message across page boundaries", async () => {
    const target = { ...endpoint, opencodeBaseUrl: endpoint.opencodeBaseUrl.replace("opencode", "opencode2") };
    const cursors: Array<string | null> = [];
    const records = (ids: string[]) => ids.map((id) => ({ id, type: "user", time: { created: 7 }, content: [] }));
    await withSessionFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith(`/session/${session.id}`)) return Response.json({ data: session });
      if (url.pathname.endsWith("/active")) return Response.json({ data: {} });
      expect(url.pathname.endsWith("/api/session/ses_native/message")).toBe(true);
      expect(url.searchParams.has("before")).toBe(false);
      const cursor = url.searchParams.get("cursor");
      cursors.push(cursor);
      if (cursor === "empty") return Response.json({ data: [], cursor: {} });
      return Response.json(cursor === "older" ? {
        data: records(["a-answer", "z-first"]), cursor: { previous: "newer", next: "empty" },
      } : {
        data: records(["b-last", "m-next"]), cursor: { previous: "newer", next: "older" },
      });
    }, async () => {
      const page = await composeNativeSessionHistory(target, session.id, { limit: 2 });
      expect(page.messages.map(({ info }) => info.id)).toEqual(["m-next", "b-last"]);
      expect(page.pagination).toEqual({ nextCursor: "older", limit: 2 });
      const older = await composeNativeSessionHistory(target, session.id, { limit: 2, before: "older" });
      expect(older.messages.map(({ info }) => info.id)).toEqual(["z-first", "a-answer"]);
      expect(older.pagination).toEqual({ before: "older", nextCursor: "empty", limit: 2 });
      const exhausted = await composeNativeSessionHistory(target, session.id, { limit: 2, before: "empty" });
      expect(exhausted.messages).toEqual([]);
      expect(exhausted.pagination).toEqual({ before: "empty", nextCursor: null, limit: 2 });
      const full = await composeNativeSessionSnapshot(target, session.id);
      const transcript = full.messages.map(({ info }) => info);
      expect(transcript.map(({ id }) => id)).toEqual(["z-first", "a-answer", "m-next", "b-last"]);
      expect(resolveForkBoundaryId(transcript, "z-first")).toBe("a-answer");
      expect(resolveForkBoundaryId(transcript, "a-answer")).toBe("m-next");
      expect(resolveForkBoundaryId(transcript, "m-next")).toBe("b-last");
      expect(resolveForkBoundaryId(transcript, "b-last")).toBeNull();
      expect(full.pagination).toBeUndefined();
      expect(full.status).toEqual({ type: "idle" });
      expect(cursors).toEqual([null, "older", "empty", null, "older", "empty"]);
    });
  });

  test("v2 fork sends the native `before` boundary, or no boundary to copy the whole session", async () => {
    const baseUrl = endpoint.opencodeBaseUrl.replace("opencode", "opencode2");
    const bodies: unknown[] = [];
    await withSessionFetch(async (request) => {
      const path = new URL(request.url).pathname;
      expect(request.method).toBe("POST");
      expect(path.endsWith(`/api/session/${session.id}/fork`)).toBe(true);
      bodies.push(await request.json());
      return Response.json({ data: {
        id: `ses_fork_${bodies.length}`, parentID: session.id, title: "Forked",
        location: { directory: session.directory }, time: { created: 3, updated: 3 },
      } });
    }, async () => {
      const client = createClientV2(baseUrl, session.directory, { token: endpoint.token });
      const atMessage = unwrap(await client.session.fork({ sessionID: session.id, messageID: "msg_next" }));
      const whole = unwrap(await client.session.fork({ sessionID: session.id }));
      expect(bodies).toEqual([{ before: "msg_next" }, {}]);
      expect([atMessage.id, whole.id]).toEqual(["ses_fork_1", "ses_fork_2"]);
      expect(atMessage.parentID).toBe(session.id);
    });
  });

  test.each([undefined, 0, -1, 1.5, Infinity])("a cursor requires a positive integer limit (%s) before any history read", async (limit) => {
    const dependencies = { createOperations: () => operations({ messages: async () => { throw new Error("Unexpected read"); } }) };
    await expect(composeNativeSessionHistory(endpoint, session.id, { before: "older", limit }, dependencies))
      .rejects.toThrow("positive integer limit");
    await expect(getNativeSessionMessages(endpoint, session.id, { before: "older", limit }, dependencies))
      .rejects.toThrow("positive integer limit");
  });

  test.each([undefined, { limit: 24 }, { messageIds: ["msg_1"] }])("history reads verify metadata/messages without reading activity (%j)", async (window) => {
    const metadata = Promise.withResolvers<FieldsResult<Session>>();
    const calls: string[] = [];
    const controller = new AbortController();
    let settled = false;
    const history = composeNativeSessionHistory(endpoint, session.id, { ...window, signal: controller.signal }, {
      createOperations: () => operations({
        get: async (_id, options) => { expect(options?.signal?.aborted).toBe(false); calls.push("get"); return metadata.promise; },
        messages: async (_id, limit, options) => {
          expect(limit).toBe(window && "limit" in window ? window.limit : undefined);
          expect(options?.signal?.aborted).toBe(false);
          calls.push("messages"); return result(messages);
        },
        message: async (_id, _messageId, options) => {
          expect(options?.signal?.aborted).toBe(false);
          calls.push("message"); return result(messages[0]!);
        },
        todo: async () => { calls.push("todo"); throw new Error("Todos unavailable"); },
        status: async () => { calls.push("status"); throw new Error("Status unavailable"); },
      }),
    }).then((value) => { settled = true; return value; });
    await Promise.resolve();
    expect(settled).toBe(false);
    metadata.resolve(result(session));
    expect(await history).toEqual({ session, messages });
    expect(calls).toEqual(["get", window && "messageIds" in window ? "message" : "messages"]);
  });

  test.each(["metadata", "messages", "saved metadata", "saved message"])("a %s failure promptly cancels only its history siblings and preserves the cause", async (branch) => {
    const controller = new AbortController();
    const failure = Promise.withResolvers<FieldsResult<never>>();
    const original = new Error("Connection lost");
    const signals: AbortSignal[] = [];
    let cancelled = 0;
    const pending = <T>(signal?: AbortSignal): Promise<FieldsResult<T>> => {
      if (!signal) throw new Error("Missing history cancellation signal");
      signals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          cancelled += 1;
          reject(new DOMException("Sibling cancelled", "AbortError"));
        }, { once: true });
      });
    };
    const unrelatedMetadata = Promise.withResolvers<FieldsResult<Session>>();
    const unrelatedSignals: AbortSignal[] = [];
    const unrelated = [session.id, "ses_other"].map((sessionId) => composeNativeSessionHistory(endpoint, sessionId, {
      signal: controller.signal,
    }, { createOperations: () => operations({
      get: async (_id, options) => {
        if (options?.signal) unrelatedSignals.push(options.signal);
        await unrelatedMetadata.promise;
        return result({ ...session, id: sessionId });
      },
      messages: async () => result([]),
    }) }));
    const saved = branch.startsWith("saved");
    const metadataFails = branch.endsWith("metadata");
    const history = composeNativeSessionHistory(endpoint, session.id, {
      signal: controller.signal, ...(saved ? { messageIds: ["msg_1", "msg_2"] } : { limit: 24 }),
    }, { createOperations: () => operations({
      get: async (_id, options) => metadataFails ? failure.promise : pending<Session>(options?.signal),
      messages: async (_id, _limit, options) => metadataFails ? pending<typeof messages>(options?.signal) : failure.promise,
      message: async (_id, messageId, options) => !metadataFails && messageId === "msg_1"
        ? failure.promise : pending<typeof messages[number]>(options?.signal),
    }) });
    failure.reject(original);
    await expect(history).rejects.toBe(original);
    expect(cancelled).toBe(saved ? 2 : 1);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    expect(unrelatedSignals).toHaveLength(2);
    expect(unrelatedSignals.every((signal) => !signal.aborted)).toBe(true);
    unrelatedMetadata.resolve(result(session));
    expect((await Promise.all(unrelated)).map((history) => history.session.id)).toEqual([session.id, "ses_other"]);
  });

  test("failed metadata responses are unwrapped before pending messages settle", async () => {
    let cancelled = false;
    await expect(composeNativeSessionHistory(endpoint, session.id, {}, { createOperations: () => operations({
      get: async () => failedResult({ code: "access_denied" }, 401),
      messages: (_id, _limit, options) => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          cancelled = true;
          reject(new DOMException("Cancelled", "AbortError"));
        }, { once: true });
      }),
    }) })).rejects.toMatchObject({ status: 401, code: "access_denied" });
    expect(cancelled).toBe(true);
  });

  test.each([false, true])("caller abort reaches all history reads and fences ignored completion (saved: %s)", async (saved) => {
    const controller = new AbortController();
    const original = new Error("History cancelled");
    const gate = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const track = async <T>(data: T, signal?: AbortSignal) => {
      if (!signal) throw new Error("Missing history cancellation signal");
      signals.push(signal);
      await gate.promise;
      return result(data);
    };
    const history = composeNativeSessionHistory(endpoint, session.id, {
      signal: controller.signal, ...(saved ? { messageIds: ["msg_1"] } : {}),
    }, { createOperations: () => operations({
      get: (_id, options) => track(session, options?.signal),
      messages: (_id, _limit, options) => track(messages, options?.signal),
      message: (_id, _messageId, options) => track(messages[0]!, options?.signal),
    }) });
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    controller.abort(original);
    expect(signals.every((signal) => signal.aborted && signal.reason === original)).toBe(true);
    gate.resolve();
    await expect(history).rejects.toBe(original);
  });

  test.each([400, 401, 403, 404, 413, 422])("HTTP %s history failures are terminal after one attempt with no backoff", async (status) => {
    let attempts = 0;
    const delays: number[] = [];
    await expect(composeNativeSessionHistoryWithRetry("owner", () => ({ owner: "owner", endpoint, sessionId: session.id }), {}, {
      createOperations: () => {
        attempts += 1;
        return operations({ messages: async () => failedResult({ code: "read_failed" }, status) });
      },
      waitForSnapshotRetry: async (delay) => { delays.push(delay); },
    })).rejects.toMatchObject({ status, code: "read_failed" });
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test.each([
    "Could not verify the session history owner.",
    "Could not verify the saved session message owner.",
    "Invalid session history pagination metadata.",
    "Session history pagination cursor did not advance.",
    "A session history cursor requires a positive integer limit.",
    "Invalid saved session message ID.",
    "Native single-message reads are unavailable.",
    "Response payload too large.",
    "Response size exceeded the limit.",
    "Unexpected history failure.",
  ])("deterministic history failures do not retry: %s", async (message) => {
    const error = new Error(message);
    let attempts = 0;
    const delays: number[] = [];
    await expect(composeNativeSessionHistoryWithRetry("owner", () => ({ owner: "owner", endpoint, sessionId: session.id }), {}, {
      createOperations: () => {
        attempts += 1;
        return operations({ messages: async () => { throw error; } });
      },
      waitForSnapshotRetry: async (delay) => { delays.push(delay); },
    })).rejects.toBe(error);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });

  test.each([408, 429, 500, 503, "Failed to fetch", "Connection refused", "Local engine unavailable", "Request timed out."])("transient history failure %s retries with a fresh signal after sibling cleanup", async (failure) => {
    let attempts = 0;
    let active = 0;
    const signals: AbortSignal[] = [];
    const delays: number[] = [];
    const history = await composeNativeSessionHistoryWithRetry("owner", () => ({ owner: "owner", endpoint, sessionId: session.id }), {}, {
      createOperations: () => {
        attempts += 1;
        return operations({
          get: async (_id, options) => {
            const signal = options?.signal;
            if (!signal) throw new Error("Missing history cancellation signal");
            expect(signal.aborted).toBe(false);
            signals.push(signal);
            if (attempts > 1) return result(session);
            active += 1;
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => {
                active -= 1;
                reject(new DOMException("Cancelled", "AbortError"));
              }, { once: true });
            });
          },
          messages: async () => {
            if (attempts > 1) return result(messages);
            if (typeof failure === "number") return failedResult({ code: "engine_reloading" }, failure);
            throw new Error(failure);
          },
        });
      },
      waitForSnapshotRetry: async (delay) => {
        expect(active).toBe(0);
        expect(signals[0]?.aborted).toBe(true);
        delays.push(delay);
      },
    });
    expect(history).toEqual({ session, messages });
    expect(attempts).toBe(2);
    expect(delays).toEqual([100]);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  test.each(["opencode2"])("%s wrapper cancels failed-attempt siblings without aborting a retry on late completion", async (engine) => {
    const target = { ...endpoint, opencodeBaseUrl: endpoint.opencodeBaseUrl.replace("opencode", engine) };
    const caller = new AbortController();
    const firstMessages = Promise.withResolvers<Response>();
    const secondMetadata = Promise.withResolvers<Response>();
    const secondStarted = Promise.withResolvers<void>();
    const messageRequests: Request[] = [];
    const metadataRequests: Request[] = [];
    const delays: number[] = [];
    const sessionResponse = () => Response.json(engine === "opencode2" ? { data: session } : session);
    const messagesResponse = () => Response.json(engine === "opencode2"
      ? { data: [{ id: "msg_1", type: "user", time: { created: 1 }, content: [] }] } : messages);
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${session.id}`)) {
        metadataRequests.push(request);
        if (metadataRequests.length === 1) return Response.json({ error: "engine_v2_preview_not_running" }, { status: 503 });
        secondStarted.resolve();
        return secondMetadata.promise;
      }
      expect(path.endsWith("/message")).toBe(true);
      messageRequests.push(request);
      return messageRequests.length === 1 ? firstMessages.promise : messagesResponse();
    }, async () => {
      const history = composeNativeSessionHistoryWithRetry("owner", () => ({ owner: "owner", endpoint: target, sessionId: session.id }), {
        signal: caller.signal,
      }, { waitForSnapshotRetry: async (delay) => {
        expect(messageRequests).toHaveLength(1);
        expect(messageRequests[0]!.signal.aborted).toBe(true);
        expect(caller.signal.aborted).toBe(false);
        delays.push(delay);
      } });
      await secondStarted.promise;
      firstMessages.resolve(messagesResponse());
      await Promise.resolve();
      await Promise.resolve();
      expect(metadataRequests[1]!.signal.aborted).toBe(false);
      expect(caller.signal.aborted).toBe(false);
      secondMetadata.resolve(sessionResponse());
      expect((await history).messages.map(({ info }) => info.id)).toEqual(["msg_1"]);
      expect(metadataRequests).toHaveLength(2);
      expect(messageRequests).toHaveLength(2);
      expect(delays).toEqual([100]);
      expect(caller.signal.aborted).toBe(false);
    });
  });

  test.each(["opencode2"])("%s wrapper classifies permanent, malformed, unknown and transient failures without writes", async (engine) => {
    const target = { ...endpoint, opencodeBaseUrl: endpoint.opencodeBaseUrl.replace("opencode", engine) };
    for (const failure of ["missing", "malformed", "unknown", "network", "warmup"]) {
      for (const saved of [false, true]) {
        let reads = 0;
        const delays: number[] = [];
        await withSessionFetch((request) => {
          expect(request.method).toBe("GET");
          const path = new URL(request.url).pathname;
          if (path.endsWith(`/session/${session.id}`)) {
            if (failure === "missing") return Response.json({ message: "Session not found" }, { status: 404 });
            return Response.json(engine === "opencode2" ? { data: session } : session);
          }
          expect(path.endsWith(saved ? "/message/msg_1" : "/message")).toBe(true);
          reads += 1;
          if (failure === "malformed") return new Response("{", { headers: { "Content-Type": "application/json" } });
          if (failure === "unknown") throw new Error("Unrecognized native failure");
          if (failure === "network") throw new TypeError("Failed to fetch");
          if (failure === "warmup") return Response.json({ error: "engine_v2_preview_not_running" }, { status: 503 });
          return Response.json(engine === "opencode2"
            ? { data: saved ? { id: "msg_1", type: "user", content: [] } : [] }
            : saved ? messages[0] : []);
        }, async () => {
          const history = composeNativeSessionHistoryWithRetry("owner", () => ({ owner: "owner", endpoint: target, sessionId: session.id }),
            saved ? { messageIds: ["msg_1"] } : {}, { waitForSnapshotRetry: async (delay) => { delays.push(delay); } });
          if (failure === "missing") await expect(history).rejects.toMatchObject({ status: 404, code: "session_not_found" });
          else if (failure === "warmup") await expect(history).rejects.toMatchObject({ status: 503 });
          else if (failure === "unknown") await expect(history).rejects.toThrow("Unrecognized native failure");
          else if (failure === "network") await expect(history).rejects.toThrow("Failed to fetch");
          else await expect(history).rejects.toBeInstanceOf(Error);
          const transient = failure === "network" || failure === "warmup";
          expect(reads).toBe(transient ? 4 : 1);
          expect(delays).toEqual(transient ? [100, 250, 500] : []);
        });
      }
    }
  });

  test.each(["opencode2"])("%s wrapper preserves a caller's abort reason across all saved-message siblings", async (engine) => {
    const target = { ...endpoint, opencodeBaseUrl: endpoint.opencodeBaseUrl.replace("opencode", engine) };
    const caller = new AbortController();
    const reason = { cancelledBy: "native-history-audit" };
    const started = Promise.withResolvers<void>();
    let count = 0;
    await withSessionFetch((request) => new Promise((_resolve, reject) => {
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      count += 1;
      if (count === 3) started.resolve();
    }), async (requests) => {
      const history = composeNativeSessionHistoryWithRetry("owner", () => ({ owner: "owner", endpoint: target, sessionId: session.id }), {
        messageIds: ["msg_1", "msg_2"], signal: caller.signal,
      }, { waitForSnapshotRetry: async () => { throw new Error("Unexpected retry"); } });
      await started.promise;
      caller.abort(reason);
      await expect(history).rejects.toBe(reason);
      expect(requests).toHaveLength(3);
      expect(requests.every((request) => request.signal.aborted && request.signal.reason === reason)).toBe(true);
    });
  });

  test("history-only reads reject mismatched metadata, messages, and parts", async () => {
    const record = messages[0]!;
    for (const overrides of [
      { get: async () => result({ ...session, id: "ses_other" }) },
      { messages: async () => result([{ ...record, info: { ...record.info, sessionID: "ses_other" } }]) },
      { messages: async () => result([{ ...record, parts: record.parts.map((part) => ({ ...part, sessionID: "ses_other" })) }]) },
      { messages: async () => result([{ ...record, parts: record.parts.map((part) => ({ ...part, messageID: "msg_other" })) }]) },
    ]) {
      await expect(composeNativeSessionHistory(endpoint, session.id, { limit: 24, before: "older" }, {
        createOperations: () => operations(overrides),
      })).rejects.toThrow("verify the session history owner");
    }
  });

  test.each(["abort", "owner"])("history retry cannot publish after its %s changes", async (change) => {
    const pending = Promise.withResolvers<FieldsResult<Session>>();
    const controller = new AbortController();
    const aborted = new Error("history cancelled");
    let owner = "owner-a";
    let attempts = 0;
    const history = composeNativeSessionHistoryWithRetry(owner, () => ({ owner, endpoint, sessionId: session.id }), {
      limit: 24, before: "older", signal: controller.signal,
    }, {
      createOperations: () => {
        attempts += 1;
        return operations({ get: async () => pending.promise });
      },
      waitForSnapshotRetry: async () => { throw new Error("Unexpected retry"); },
    });
    if (change === "abort") controller.abort(aborted);
    else owner = "owner-b";
    pending.resolve(result(session));
    if (change === "abort") await expect(history).rejects.toBe(aborted);
    else await expect(history).rejects.toThrow("Session snapshot owner changed");
    expect(attempts).toBe(1);
  });

  test("uses the resolved mounted endpoint and its workspace token", async () => {
    let receivedEndpoint: typeof endpoint | null = null;
    await getNativeSession(endpoint, session.id, undefined, {
      createOperations: (target) => {
        receivedEndpoint = target;
        return operations();
      },
    });

    expect(receivedEndpoint).toEqual(endpoint);
  });

  test.each(["opencode2"])("%s newest session/messages reads need no status or todos", async (engine) => {
    const target = { ...endpoint, opencodeBaseUrl: endpoint.opencodeBaseUrl.replace("opencode", engine) };
    const controller = new AbortController();
    const history = Array.from({ length: 30 }, (_, index) => ({
      info: { ...messages[0]!.info, id: `msg_${index}`, time: { created: index } },
      parts: [],
    }));
    await withSessionFetch((request) => {
      const url = new URL(request.url);
      expect(request.headers.get("authorization")).toBe(`Bearer ${target.token}`);
      if (url.pathname.endsWith(`/session/${session.id}`)) {
        return Response.json(engine === "opencode2" ? { data: session } : session);
      }
      if (url.pathname.endsWith("/message")) {
        expect(url.searchParams.get("limit")).toBe("24");
        return Response.json(engine === "opencode2" ? {
          data: history.slice(-24).map(({ info }) => ({ ...info, type: "user", content: [] })),
        } : history.slice(-24));
      }
      throw new Error(`Unexpected newest-read dependency: ${url.pathname}`);
    }, async (requests) => {
      const [current, newest] = await Promise.all([
        getNativeSession(target, session.id, { signal: controller.signal }),
        getNativeSessionMessages(target, session.id, { signal: controller.signal, limit: 24 }),
      ]);
      expect(current.id).toBe(session.id);
      expect(newest.map(({ info }) => info.id)).toEqual(history.slice(-24).map(({ info }) => info.id));
      expect(requests).toHaveLength(2);
    });
  });

  test("composes get, messages, todo, and status in parallel with limit and signal", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const snapshotPromise = composeNativeSessionSnapshot(endpoint, session.id, {
      limit: 24,
      signal: controller.signal,
    }, {
      createOperations: () => operations({
        get: async (_sessionId, options) => {
          calls.push(options?.signal?.aborted === false ? "get" : "bad-get");
          return result(session);
        },
        messages: async (_sessionId, limit, options) => {
          calls.push(limit === 24 && options?.signal?.aborted === false ? "messages" : "bad-messages");
          return result(messages);
        },
        todo: async (_sessionId, options) => {
          calls.push(options?.signal?.aborted === false ? "todo" : "bad-todo");
          return result(todos);
        },
        status: async (options) => {
          calls.push(options?.signal?.aborted === false ? "status" : "bad-status");
          return result<Record<string, SessionStatus>>({});
        },
      }),
    });

    expect(calls).toEqual(["get", "messages", "todo", "status"]);
    expect(await snapshotPromise).toEqual({ session, messages, todos, status: { type: "idle" } });
  });

  test.each(["opencode2"])("%s previews request the newest bounded messages and leave full reads uncapped", async (engine) => {
    const target = { ...endpoint, opencodeBaseUrl: endpoint.opencodeBaseUrl.replace("opencode", engine) };
    const history = Array.from({ length: 30 }, (_, index) => ({
      info: { ...messages[0]!.info, id: `msg_${index}`, time: { created: index } },
      parts: [],
    }));
    const limits: Array<string | null> = [];
    await withSessionFetch((request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith(`/session/${session.id}`)) {
        return Response.json(engine === "opencode2" ? { data: session } : session);
      }
      if (url.pathname.endsWith("/message")) {
        const limit = url.searchParams.get("limit");
        limits.push(limit);
        const page = limit ? history.slice(-Number(limit)) : history;
        return Response.json(engine === "opencode2" ? {
          data: page.toReversed().map(({ info }) => ({ ...info, type: "user", content: [] })),
        } : page);
      }
      if (url.pathname.endsWith("/todo")) return Response.json(todos);
      if (url.pathname.endsWith("/status")) return Response.json({});
      if (url.pathname.endsWith("/active")) return Response.json({ data: {} });
      throw new Error(`Unexpected request: ${request.method} ${url.pathname}`);
    }, async () => {
      const preview = await composeNativeSessionHistory(target, session.id, { limit: 24 });
      const full = await composeNativeSessionHistory(target, session.id);
      expect(preview.status).toBeUndefined();
      expect(full.todos).toBeUndefined();
      const newestIds = history.slice(-24).map(({ info }) => info.id);
      const allIds = history.map(({ info }) => info.id);
      expect(preview.messages.map(({ info }) => info.id)).toEqual(engine === "opencode2" ? newestIds.toReversed() : newestIds);
      expect(full.messages.map(({ info }) => info.id)).toEqual(engine === "opencode2" ? allIds.toReversed() : allIds);
      expect(limits).toEqual(["24", null]);
    });
  });

  test.each(["opencode2"])("%s reads only saved IDs in requested order and skips a deleted anchor", async (engine) => {
    const target = { ...endpoint, opencodeBaseUrl: endpoint.opencodeBaseUrl.replace("opencode", engine) };
    const controller = new AbortController();
    const ids: readonly string[] = ["msg_z", "msg_a", "msg_m", "msg_z"];
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${session.id}`)) return Response.json(engine === "opencode2" ? { data: session } : session);
      const id = path.match(/\/message\/([^/]+)$/)?.[1];
      if (id) {
        if (id === "msg_a") return Response.json({ message: "Message not found" }, { status: 404 });
        const record = {
          info: { ...messages[0]!.info, id, time: { created: ids.indexOf(id) } },
          parts: messages[0]!.parts.map((part) => ({ ...part, messageID: id })),
        };
        return Response.json(engine === "opencode2"
          ? { data: { ...record.info, type: "user", content: [{ type: "text", text: "hello" }] } }
          : record);
      }
      if (path.endsWith("/todo")) return Response.json(todos);
      if (path.endsWith("/status")) return Response.json({});
      if (path.endsWith("/active")) return Response.json({ data: {} });
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async (requests) => {
      const snapshot = await composeNativeSessionHistory(target, session.id, { messageIds: ids, limit: 24, before: "ignored-legacy-cursor", signal: controller.signal });
      expect(snapshot.pagination).toBeUndefined();
      expect(snapshot.messages.map(({ info }) => info.id)).toEqual(["msg_z", "msg_m"]);
      expect(snapshot.messages.every(({ info, parts }) => info.sessionID === session.id && parts.length === 1
        && parts.every((part) => part.sessionID === session.id && part.messageID === info.id))).toBe(true);
      const lookups = requests.filter((request) => new URL(request.url).pathname.includes("/message/"));
      expect(lookups.map((request) => request.url)).toEqual(["msg_z", "msg_a", "msg_m"].map((id) =>
        `${target.opencodeBaseUrl}${engine === "opencode2" ? "/api" : ""}/session/${session.id}/message/${id}`));
      expect(requests.some((request) => new URL(request.url).pathname.endsWith("/message"))).toBe(false);
      for (const request of requests) {
        expect(request.method).toBe("GET");
        expect(/\/(todo|status|active)$/.test(new URL(request.url).pathname)).toBe(false);
        expect(request.headers.get("Authorization")).toBe(`Bearer ${endpoint.token}`);
      }
    });
  });

  test("saved-region previews dedupe before capping at 24 IDs without listing messages", async () => {
    const ids = Array.from({ length: 30 }, (_, index) => `msg_${30 - index}`);
    const lookups: string[] = [];
    const controller = new AbortController();
    const dependencies = { createOperations: () => operations({
      messages: async () => { throw new Error("Unexpected full message read"); },
      message: async (sessionId, messageId, options) => {
        expect(sessionId).toBe(session.id);
        expect(options?.signal?.aborted).toBe(false);
        lookups.push(messageId);
        return result({ info: { ...messages[0]!.info, id: messageId }, parts: [] });
      },
    }) };
    const snapshot = await composeNativeSessionSnapshot(endpoint, session.id, {
      messageIds: [ids[0]!, ids[0]!, ...ids], signal: controller.signal,
    }, dependencies);
    expect(lookups).toEqual(ids.slice(0, 24));
    expect(snapshot.messages.map(({ info }) => info.id)).toEqual(lookups);
    expect((await composeNativeSessionSnapshot(endpoint, session.id, { messageIds: [] }, dependencies)).messages).toEqual([]);
    expect(lookups).toHaveLength(24);
  });

  test("saved-region previews preserve auth, permission, and transport errors instead of treating them as deletion", async () => {
    for (const status of [401, 403, 503]) {
      await expect(composeNativeSessionSnapshot(endpoint, session.id, { messageIds: ["msg_1"] }, {
        createOperations: () => operations({ message: async () => failedResult({ code: "read_failed" }, status) }),
      })).rejects.toMatchObject({ status, code: "read_failed" });
    }
    const transportError = new Error("Connection lost");
    await expect(composeNativeSessionSnapshot(endpoint, session.id, { messageIds: ["msg_1"] }, {
      createOperations: () => operations({ message: async () => { throw transportError; } }),
    })).rejects.toBe(transportError);
    await expect(composeNativeSessionSnapshot(endpoint, session.id, { messageIds: ["msg_1"] }, {
      createOperations: () => operations(),
    })).rejects.toThrow("single-message reads are unavailable");
  });

  test("saved-region previews reject mismatched message and part owners", async () => {
    const record = messages[0]!;
    for (const mismatched of [
      { ...record, info: { ...record.info, id: "msg_other" } },
      { ...record, info: { ...record.info, sessionID: "ses_other" } },
      { ...record, parts: record.parts.map((part) => ({ ...part, messageID: "msg_other" })) },
      { ...record, parts: record.parts.map((part) => ({ ...part, sessionID: "ses_other" })) },
    ]) {
      await expect(composeNativeSessionSnapshot(endpoint, session.id, { messageIds: [record.info.id] }, {
        createOperations: () => operations({ message: async () => result(mismatched) }),
      })).rejects.toThrow("verify the saved session message owner");
    }
  });

  test("returns raw SDK shapes for get, messages, and delete", async () => {
    const dependencies = { createOperations: () => operations({ delete: async () => result(false) }) };

    expect(await getNativeSession(endpoint, session.id, undefined, dependencies)).toBe(session);
    expect(await getNativeSessionMessages(endpoint, session.id, { limit: 40 }, dependencies)).toBe(messages);
    expect(await deleteNativeSession(endpoint, session.id, undefined, dependencies)).toBe(false);
  });

  test("preserves native response status and not-found semantics", async () => {
    const promise = getNativeSession(endpoint, "ses_missing", undefined, {
      createOperations: () => operations({
        get: async () => failedResult({ message: "missing" }, 404),
      }),
    });

    try {
      await promise;
      throw new Error("Expected native session read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ status: 404, code: "session_not_found" });
    }
  });

  test("a transport failure keeps its own message when the SDK settles without a response", async () => {
    // The SDK client answers a thrown fetch (timeout, refused connection) with
    // `response: undefined`; the person must read the cause, not a TypeError.
    const settledWithoutResponse = {
      error: new Error("Request timed out."),
      request: new Request(endpoint.opencodeBaseUrl),
      response: undefined,
    } as unknown as FieldsResult<never>;
    await expect(getNativeSessionMessages(endpoint, session.id, undefined, {
      createOperations: () => operations({ messages: async () => settledWithoutResponse }),
    })).rejects.toThrow("Request timed out.");
  });

  test("fails the snapshot when any native operation fails", async () => {
    await expect(composeNativeSessionSnapshot(endpoint, session.id, undefined, {
      createOperations: () => operations({
        todo: async () => failedResult({ code: "engine_unavailable" }, 503),
      }),
    })).rejects.toMatchObject({ status: 503, code: "engine_unavailable" });
  });

  test.each([false, true])("retries a failed local snapshot read without waiting for query focus or issuing writes (saved region: %s)", async (savedRegion) => {
    const calls: string[] = [];
    const endpointTokens: string[] = [];
    let currentEndpoint = endpoint;
    let attempt = 0;
    focusManager.setFocused(false);
    try {
      const snapshot = await composeNativeSessionSnapshotWithRetry("owner-a", () => ({
        owner: "owner-a",
        endpoint: currentEndpoint,
        sessionId: session.id,
      }), savedRegion ? { messageIds: ["msg_1"] } : { limit: 140 }, {
        createOperations: (target) => {
          attempt += 1;
          endpointTokens.push(target.token);
          const track = <T>(name: string, value: FieldsResult<T>) => {
            calls.push(name);
            return Promise.resolve(value);
          };
          return operations({
            get: async () => track("get", attempt === 1
              ? failedResult({ code: "engine_reloading" }, 503)
              : result(session)),
            messages: async () => track("messages", result(messages)),
            message: async () => track("message", result(messages[0]!)),
            todo: async () => track("todo", result(todos)),
            status: async () => track("status", result<Record<string, SessionStatus>>({})),
            delete: async () => {
              calls.push("delete");
              return result(true);
            },
          });
        },
        waitForSnapshotRetry: async () => {
          currentEndpoint = { ...endpoint, token: "rotated-workspace-token" };
        },
      });

      expect(snapshot.session.id).toBe(session.id);
      expect(attempt).toBe(2);
      expect(endpointTokens).toEqual([endpoint.token, "rotated-workspace-token"]);
      const messageRead = savedRegion ? "message" : "messages";
      expect(calls).toEqual(["get", messageRead, "todo", "status", "get", messageRead, "todo", "status"]);
      expect(calls).not.toContain("delete");
      expect(calls).not.toContain("prompt");
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  test("rejects the final local snapshot read error after four attempts", async () => {
    let attempt = 0;
    const delays: number[] = [];
    const promise = composeNativeSessionSnapshotWithRetry("owner-a", () => ({
      owner: "owner-a",
      endpoint,
      sessionId: session.id,
    }), {}, {
      createOperations: () => {
        attempt += 1;
        return operations({
          get: async () => failedResult({ code: `engine_unavailable_${attempt}` }, 503),
        });
      },
      waitForSnapshotRetry: async (delayMs) => { delays.push(delayMs); },
    });

    await expect(promise).rejects.toMatchObject({ status: 503, code: "engine_unavailable_4" });
    expect(attempt).toBe(4);
    expect(delays).toEqual([100, 250, 500]);
  });

  test.each([false, true])("aborting a local snapshot retry prevents the next read attempt (saved region: %s)", async (savedRegion) => {
    const controller = new AbortController();
    const aborted = new Error("snapshot read cancelled");
    let attempt = 0;
    const promise = composeNativeSessionSnapshotWithRetry("owner-a", () => ({
      owner: "owner-a",
      endpoint,
      sessionId: session.id,
    }), { signal: controller.signal, ...(savedRegion ? { messageIds: ["msg_1"] } : {}) }, {
      createOperations: () => {
        attempt += 1;
        return operations({
          get: async () => failedResult({ code: "engine_reloading" }, 503),
          message: async () => result(messages[0]!),
        });
      },
      waitForSnapshotRetry: async () => { controller.abort(aborted); },
    });

    await expect(promise).rejects.toBe(aborted);
    expect(attempt).toBe(1);
  });

  test.each(["abort", "owner"])("a saved-region lookup cannot publish or retry after its %s changes", async (change) => {
    const pending = Promise.withResolvers<FieldsResult<{ info: Message; parts: Part[] }>>();
    const controller = new AbortController();
    const aborted = new Error("snapshot read cancelled");
    let owner = "owner-a";
    let reads = 0;
    const promise = composeNativeSessionSnapshotWithRetry("owner-a", () => ({
      owner, endpoint, sessionId: session.id,
    }), { messageIds: ["msg_1"], signal: controller.signal }, {
      createOperations: () => operations({ message: async () => { reads += 1; return pending.promise; } }),
      waitForSnapshotRetry: async () => { throw new Error("Unexpected retry"); },
    });
    expect(reads).toBe(1);
    if (change === "abort") controller.abort(aborted);
    else owner = "owner-b";
    pending.resolve(result(messages[0]!));
    if (change === "abort") await expect(promise).rejects.toBe(aborted);
    else await expect(promise).rejects.toThrow("Session snapshot owner changed");
    expect(reads).toBe(1);
  });
});

describe("native Stop and follow-up handoff", () => {
  test.each([false, true])("v2 interrupts the native subagent before admitting the next prompt (immediate: %s)", async (immediate) => {
    const baseUrl = endpoint.opencodeBaseUrl.replace("opencode", "opencode2");
    const rootID = `ses_v2_stop_${immediate}`;
    const childID = "ses_v2_child";
    const events: string[] = [];
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      const [, id, action] = path.match(/\/api\/session\/([^/]+)(?:\/([^/]+))?$/) ?? [];
      if (id === "active") return Response.json({ data: {} });
      if (!action) return Response.json({ data: {
        id, title: "Native turn", location: { directory: session.directory }, time: { created: 1, updated: 2 },
        ...(id === childID ? { parentID: rootID } : {}),
      } });
      if (action === "message") return Response.json({ data: [
        { id: "msg_user", type: "user", time: { created: 1 }, content: [] },
        { id: "msg_assistant", type: "assistant", time: { created: 2 }, content: id === rootID ? [{
          type: "tool", id: "call_child", name: "subagent", time: { created: 2, ran: 2 },
          state: { status: "running", input: { agent: "explore" }, metadata: { sessionID: childID } },
        }] : [] },
      ] });
      if (action === "interrupt") { events.push(`interrupt:${id}`); return Response.json({ data: { interrupted: true } }); }
      if (action === "model") return Response.json({ data: {} });
      if (action === "prompt") { events.push(`prompt:${id}`); return Response.json({ data: {} }); }
      throw new Error(`Unexpected v2 request: ${request.method} ${path}`);
    }, async (requests) => {
      const client = createClientV2(baseUrl, session.directory, { token: endpoint.token });
      const current = unwrap(await client.session.messages({ sessionID: rootID }));
      const send = async () => unwrap(await client.session.promptAsync({
        sessionID: rootID, model: { providerID: "mock", modelID: "mock" }, parts: [{ type: "text", text: "new turn" }],
      }));
      const stop = immediate ? undefined : interruptSessionTurn(baseUrl, client, rootID, session.directory);
      const next = immediate
        ? submitImmediateSessionTurn(baseUrl, client, rootID, current, send, { directory: session.directory })
        : submitAfterInterruption(baseUrl, rootID, send);
      await Promise.all([stop, next]);
      expect(events).toEqual([`interrupt:${rootID}`, `interrupt:${rootID}`, `interrupt:${childID}`, `prompt:${rootID}`]);
      expect(requests.every((request) => new URL(request.url).pathname.includes("/opencode2/api/"))).toBe(true);
    });
  });

});
