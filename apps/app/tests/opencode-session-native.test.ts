import { describe, expect, test } from "bun:test";
import { focusManager } from "@tanstack/react-query";
import type { Message, Part, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import { createClient, createPromptMessageID, hasAcceptedPromptMessage, PromptAdmissionUnknownError, promptAdmissionFailure, readPromptAdmission, unwrap, type FieldsResult } from "../src/app/lib/opencode";
import { holdSessionWork, interruptSessionTurn, sendSessionCommand, sessionHasPendingSubmission, sessionNeedsStop, sessionWorkHeld, submitAfterInterruption, submitImmediateSessionTurn } from "../src/app/lib/opencode-interruption";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import {
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
  test("acceptance requires an exact native user-message GET, never absence or another message", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Request[] = [];
    let response = new Response(null, { status: 404 });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(new Request(input, init));
        return response;
      },
    });
    try {
      const client = createClient(endpoint.opencodeBaseUrl, session.directory, { token: endpoint.token, mode: "openwork" });
      const messageID = createPromptMessageID();
      expect(await hasAcceptedPromptMessage(client, session.id, messageID)).toBe(false);
      for (const info of [
        { id: "msg_other", sessionID: session.id, role: "user" },
        { id: messageID, sessionID: "ses_other", role: "user" },
        { id: messageID, sessionID: session.id, role: "assistant" },
      ]) {
        response = Response.json({ info, parts: [] });
        expect(await hasAcceptedPromptMessage(client, session.id, messageID)).toBe(false);
      }
      response = Response.json({ info: { id: messageID, sessionID: session.id, role: "user" }, parts: [] });
      expect(await hasAcceptedPromptMessage(client, session.id, messageID)).toBe(true);
      expect(requests).toHaveLength(5);
      for (const request of requests) {
        expect(request.method).toBe("GET");
        const url = new URL(request.url);
        expect(`${url.origin}${url.pathname}`).toBe(`${endpoint.opencodeBaseUrl}/session/${session.id}/message/${messageID}`);
        expect(url.searchParams.get("directory")).toBe(session.directory);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("an idle conversation listed without the message is the only absence that counts", async () => {
    const originalFetch = globalThis.fetch;
    const messageID = createPromptMessageID();
    let listed: unknown = [];
    let statuses: Record<string, SessionStatus> = {};
    let messageStatus = 404;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(new Request(input, init).url).pathname;
        if (path.endsWith(`/message/${messageID}`)) {
          return messageStatus === 200
            ? Response.json({ info: { id: messageID, sessionID: session.id, role: "user" }, parts: [] })
            : new Response(null, { status: messageStatus });
        }
        if (path.endsWith("/session/status")) return Response.json(statuses);
        if (path.endsWith(`/session/${session.id}/message`)) return Response.json(listed);
        return new Response(null, { status: 500 });
      },
    });
    try {
      const client = createClient(endpoint.opencodeBaseUrl, session.directory, { token: endpoint.token, mode: "openwork" });
      expect(await readPromptAdmission(client, session.id, messageID)).toBe("absent");
      statuses = { [session.id]: { type: "busy" } };
      expect(await readPromptAdmission(client, session.id, messageID)).toBe("unknown");
      statuses = {};
      listed = [{ info: { id: messageID, sessionID: session.id, role: "user" }, parts: [] }];
      expect(await readPromptAdmission(client, session.id, messageID)).toBe("unknown");
      listed = { unexpected: true };
      expect(await readPromptAdmission(client, session.id, messageID)).toBe("unknown");
      messageStatus = 200;
      expect(await readPromptAdmission(client, session.id, messageID)).toBe("accepted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  test("a settled prompt failure keeps its response body behind the unknown admission", async () => {
    const originalFetch = globalThis.fetch;
    const body = { name: "APIError", data: { statusCode: 507, message: "storage quota exceeded" } };
    let response = () => Response.json(body, { status: 507 });
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => response() });
    try {
      const client = createClient(endpoint.opencodeBaseUrl, session.directory, { token: endpoint.token, mode: "openwork" });
      const settled = await client.session.promptAsync({ sessionID: session.id, parts: [] }).catch((error: unknown) => error);
      if (!(settled instanceof PromptAdmissionUnknownError)) throw new Error("Expected an unknown admission");
      expect(promptAdmissionFailure(settled)).toEqual(body);
      response = () => new Response("", { status: 502 });
      const empty = await client.session.promptAsync({ sessionID: session.id, parts: [] }).catch((error: unknown) => error);
      if (!(empty instanceof PromptAdmissionUnknownError)) throw new Error("Expected an unknown admission");
      expect(promptAdmissionFailure(empty)).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
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

  test("composes get, messages, todo, and status in parallel with limit and signal", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const snapshotPromise = composeNativeSessionSnapshot(endpoint, session.id, {
      limit: 24,
      signal: controller.signal,
    }, {
      createOperations: () => operations({
        get: async (_sessionId, options) => {
          calls.push(options?.signal === controller.signal ? "get" : "bad-get");
          return result(session);
        },
        messages: async (_sessionId, limit, options) => {
          calls.push(limit === 24 && options?.signal === controller.signal ? "messages" : "bad-messages");
          return result(messages);
        },
        todo: async (_sessionId, options) => {
          calls.push(options?.signal === controller.signal ? "todo" : "bad-todo");
          return result(todos);
        },
        status: async (options) => {
          calls.push(options?.signal === controller.signal ? "status" : "bad-status");
          return result<Record<string, SessionStatus>>({});
        },
      }),
    });

    expect(calls).toEqual(["get", "messages", "todo", "status"]);
    expect(await snapshotPromise).toEqual({ session, messages, todos, status: { type: "idle" } });
  });

  test.each(["opencode", "opencode2"])("%s previews request the newest bounded messages and leave full reads uncapped", async (engine) => {
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
      const preview = await composeNativeSessionSnapshot(target, session.id, { limit: 24 });
      const full = await composeNativeSessionSnapshot(target, session.id);
      const newestIds = history.slice(-24).map(({ info }) => info.id);
      const allIds = history.map(({ info }) => info.id);
      expect(preview.messages.map(({ info }) => info.id)).toEqual(engine === "opencode2" ? newestIds.toReversed() : newestIds);
      expect(full.messages.map(({ info }) => info.id)).toEqual(engine === "opencode2" ? allIds.toReversed() : allIds);
      expect(limits).toEqual(["24", null]);
    });
  });

  test.each(["opencode", "opencode2"])("%s reads only saved IDs in requested order and skips a deleted anchor", async (engine) => {
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
      const snapshot = await composeNativeSessionSnapshot(target, session.id, { messageIds: ids, limit: 24, signal: controller.signal });
      expect(snapshot.messages.map(({ info }) => info.id)).toEqual(["msg_z", "msg_m"]);
      expect(snapshot.messages.every(({ info, parts }) => info.sessionID === session.id && parts.length === 1
        && parts.every((part) => part.sessionID === session.id && part.messageID === info.id))).toBe(true);
      const lookups = requests.filter((request) => new URL(request.url).pathname.includes("/message/"));
      expect(lookups.map((request) => request.url)).toEqual(["msg_z", "msg_a", "msg_m"].map((id) =>
        `${target.opencodeBaseUrl}${engine === "opencode2" ? "/api" : ""}/session/${session.id}/message/${id}`));
      expect(requests.some((request) => new URL(request.url).pathname.endsWith("/message"))).toBe(false);
      for (const request of requests) {
        expect(request.method).toBe("GET");
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
        expect(options?.signal).toBe(controller.signal);
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
  test("archive holds share native submission coordination without blocking another runtime", async () => {
    const baseUrl = endpoint.opencodeBaseUrl;
    const id = "ses_archive_hold";
    const release = holdSessionWork(baseUrl, id);
    let sent = false;
    try {
      expect(sessionWorkHeld(`${baseUrl}/`, id)).toBe(true);
      expect(sessionWorkHeld(baseUrl, "other")).toBe(false);
      await expect(submitAfterInterruption(baseUrl, id, async () => { sent = true; })).rejects.toThrow("being archived");
      expect(sent).toBe(false);
      await submitAfterInterruption(`${baseUrl}/other`, id, async () => { sent = true; });
      expect(sent).toBe(true);
    } finally {
      release();
    }
    expect(sessionWorkHeld(baseUrl, id)).toBe(false);
    sent = false;
    await submitAfterInterruption(baseUrl, id, async () => { sent = true; });
    expect(sent).toBe(true);
  });

  test("proxy-accepted commands stay fenced through idle until their exact terminal reply is visible", async () => {
    const root = { ...session, id: "ses_deferred_command" };
    const baseUrl = endpoint.opencodeBaseUrl;
    const messageID = createPromptMessageID();
    let terminal = false;
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith("/command")) return Response.json({ accepted: true });
      if (path.endsWith("/message")) return Response.json(terminal
        ? turnMessages(root.id, [], messageID).map(message => message.info.role === "assistant" ? {
          ...message, info: { ...message.info, parentID: messageID, finish: "stop", time: { created: 2, completed: 3 } },
        } : message)
        : turnMessages(root.id, [], "msg_unrelated"));
      if (path.endsWith("/abort")) return Response.json(false);
      if (path.endsWith("/status")) return Response.json({});
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async requests => {
      const client = createClient(baseUrl, root.directory);
      await sendSessionCommand(baseUrl, client, { sessionID: root.id, messageID, command: "held", arguments: "" });
      expect(sessionHasPendingSubmission(baseUrl, root.id)).toBe(true);
      expect(sessionHasPendingSubmission(`${baseUrl}/other`, root.id)).toBe(false);
      await expect(interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 30 })).rejects.toThrow("timed out");
      expect(requests.some(request => new URL(request.url).pathname.endsWith("/abort"))).toBe(true);
      expect(sessionNeedsStop(baseUrl, root.id)).toBe(true);
      terminal = true;
      await interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
      expect(sessionHasPendingSubmission(baseUrl, root.id)).toBe(false);
      expect(sessionNeedsStop(baseUrl, root.id)).toBe(false);
      expect(requests.filter(request => new URL(request.url).pathname.endsWith("/command"))).toHaveLength(1);
    });
  });

  test("an unknown admission with exact terminal evidence and fresh idle permits Stop even on abort false", async () => {
    const root = { ...session, id: "ses_unknown_terminal" };
    const messageID = createPromptMessageID();
    await withSessionFetch(request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith("/message")) return Response.json(turnMessages(root.id, [], messageID).map(message => message.info.role === "assistant" ? {
        ...message, info: { ...message.info, parentID: messageID, finish: "stop", time: { created: 2, completed: 3 } },
      } : message));
      if (path.endsWith("/abort")) return Response.json(false);
      if (path.endsWith("/status")) return Response.json({});
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async () => {
      const client = createClient(endpoint.opencodeBaseUrl, root.directory);
      await interruptSessionTurn(endpoint.opencodeBaseUrl, client, root.id, root.directory, {
        admissionUnknown: true, admissionMessageID: messageID,
      });
      expect(sessionNeedsStop(endpoint.opencodeBaseUrl, root.id)).toBe(false);
    });
  });

  test("Stop re-aborts a command admitted after its first idle abort without waiting for natural completion", async () => {
    const root = { ...session, id: "ses_late_command" };
    const child = { ...session, id: "ses_late_command_child", parentID: root.id };
    const messageID = createPromptMessageID();
    const firstIdle = Promise.withResolvers<void>();
    let admitted = false;
    let terminal = false;
    let childStopped = false;
    const events: string[] = [];
    await withSessionFetch(request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith(`/session/${child.id}`)) return Response.json(child);
      if (path.endsWith("/command")) { events.push("command-accepted"); return Response.json({ accepted: true }); }
      if (path.endsWith(`/session/${child.id}/message`)) return Response.json(turnMessages(child.id));
      if (path.endsWith(`/session/${root.id}/message`)) {
        if (!admitted) return Response.json([]);
        // Cancellation can remove task metadata: Stop must retain what it saw
        // in the admitted command before issuing that cancellation.
        return Response.json(turnMessages(root.id, terminal ? [] : [delegatedTool(child.id)], messageID).map(message =>
          terminal && message.info.role === "assistant" ? {
            ...message, info: { ...message.info, parentID: messageID, finish: "stop", time: { created: 2, completed: 3 } },
          } : message));
      }
      if (path.endsWith(`/session/${root.id}/abort`)) {
        events.push(admitted ? "abort-admitted-command" : "abort-idle-root");
        if (admitted) terminal = true;
        return Response.json(admitted);
      }
      if (path.endsWith(`/session/${child.id}/abort`)) {
        events.push("abort-command-child");
        childStopped = true;
        return Response.json(true);
      }
      if (path.endsWith("/status")) {
        if (!admitted) firstIdle.resolve();
        return Response.json({
          [root.id]: { type: admitted && !terminal ? "busy" : "idle" },
          [child.id]: { type: admitted && !childStopped ? "busy" : "idle" },
          ses_unrelated: { type: "busy" },
        });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async requests => {
      const client = createClient(endpoint.opencodeBaseUrl, root.directory);
      await sendSessionCommand(endpoint.opencodeBaseUrl, client, { sessionID: root.id, messageID, command: "late", arguments: "" });
      const stopping = interruptSessionTurn(endpoint.opencodeBaseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
      await Promise.race([firstIdle.promise, stopping]);
      expect(events).toEqual(["command-accepted", "abort-idle-root"]);
      expect(terminal).toBe(false);
      admitted = true;
      events.push("command-admitted");
      await stopping;
      expect(terminal).toBe(true);
      expect(childStopped).toBe(true);
      expect(events.indexOf("abort-admitted-command")).toBeGreaterThan(events.indexOf("command-admitted"));
      expect(events.indexOf("abort-command-child")).toBeGreaterThan(events.indexOf("abort-admitted-command"));
      expect(sessionHasPendingSubmission(endpoint.opencodeBaseUrl, root.id)).toBe(false);
      expect(sessionNeedsStop(endpoint.opencodeBaseUrl, root.id)).toBe(false);
      expect(requests.filter(request => new URL(request.url).pathname.endsWith("/command"))).toHaveLength(1);
      const stoppedIds = requests.flatMap(request => new URL(request.url).pathname.match(/\/session\/([^/]+)\/abort$/)?.[1] ?? []);
      expect(new Set(stoppedIds)).toEqual(new Set([root.id, child.id]));
      expect(requests.some(request => new URL(request.url).pathname.endsWith("/prompt_async"))).toBe(false);
    });
  });

  test("dispatches root abort before failed or hanging discovery reads can block Stop", async () => {
    for (const action of ["get", "message"]) {
      for (const failure of ["failed", "hanging"]) {
        const root = { ...session, id: `ses_discovery_${action}_${failure}` };
        const discovery = Promise.withResolvers<Response>();
        const reached = Promise.withResolvers<void>();
        await withSessionFetch((request) => {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/abort")) return Response.json(true);
          if (path.endsWith(action === "get" ? `/session/${root.id}` : "/message")) {
            reached.resolve();
            return discovery.promise;
          }
          if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
          if (path.endsWith("/message")) return Response.json(turnMessages(root.id));
          throw new Error(`Unexpected request: ${request.method} ${path}`);
        }, async (requests) => {
          const client = createClient(endpoint.opencodeBaseUrl, root.directory);
          const stop = interruptSessionTurn(endpoint.opencodeBaseUrl, client, root.id, root.directory, { timeoutMs: 100 });
          const outcome = stop.then(() => undefined, (error: unknown) => error);
          try {
            await reached.promise;
            expect(requests.filter((request) => request.method === "POST").map((request) => new URL(request.url).pathname))
              .toEqual([`/workspace/ws-native/opencode/session/${root.id}/abort`]);
            if (failure === "failed") discovery.resolve(Response.json({ message: "Discovery failed" }, { status: 503 }));
            const error = await outcome;
            expect(error).toBeInstanceOf(Error);
            expect(error).toMatchObject({ message: expect.stringContaining(failure === "hanging" ? "timed out" : "Discovery failed") });
            expect(sessionNeedsStop(endpoint.opencodeBaseUrl, root.id)).toBe(true);
          } finally {
            discovery.resolve(Response.json(action === "get" ? root : []));
            await outcome;
          }
        });
      }
    }
  });

  test("a duplicate Stop cancels the intervening follow-up but admits one queued after it", async () => {
    const root = { ...session, id: "ses_duplicate_generation" };
    const baseUrl = endpoint.opencodeBaseUrl;
    const idle = Promise.withResolvers<Response>();
    const reached = Promise.withResolvers<void>();
    const sent: string[] = [];
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith("/message")) return Response.json(turnMessages(root.id));
      if (path.endsWith("/abort")) return Response.json(true);
      if (path.endsWith("/status")) { reached.resolve(); return idle.promise; }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async (requests) => {
      const client = createClient(baseUrl, root.directory);
      const stop = interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
      const intervening = submitAfterInterruption(baseUrl, root.id, async () => { sent.push("cancelled"); });
      const outcome = intervening.then(() => undefined, (error: unknown) => error);
      expect(interruptSessionTurn(baseUrl, client, root.id, root.directory)).toBe(stop);
      const followUp = submitAfterInterruption(baseUrl, root.id, async (afterStop) => {
        expect(afterStop).toBe(true);
        sent.push("follow-up");
      });
      try {
        await reached.promise;
        expect(sent).toEqual([]);
        idle.resolve(Response.json({}));
        await Promise.all([stop, followUp]);
        expect(await outcome).toMatchObject({ message: expect.stringContaining("Send cancelled by Stop") });
        expect(sent).toEqual(["follow-up"]);
        expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
      } finally {
        idle.resolve(Response.json({}));
        await Promise.allSettled([stop, outcome, followUp]);
      }
    });
  });

  test("terminal native evidence cancels a hung send before tree cleanup and ignores its late HTTP response", async () => {
    const root = { ...session, id: "ses_terminal_admission" };
    const child = { ...session, id: "ses_terminal_child", parentID: root.id };
    const baseUrl = endpoint.opencodeBaseUrl;
    const messageID = "msg_terminal_admission";
    const admission = Promise.withResolvers<Response>();
    const dispatched = Promise.withResolvers<void>();
    const returned = Promise.withResolvers<void>();
    const childAbort = Promise.withResolvers<Response>();
    const childReached = Promise.withResolvers<void>();
    const sent: string[] = [];
    const native = turnMessages(root.id, [delegatedTool(child.id, { status: "error", error: "cancelled" })], messageID)
      .map((message) => message.info.role === "assistant" ? {
        ...message, info: { ...message.info, parentID: messageID, finish: "stop", time: { created: 2, completed: 3 } },
      } : message);
    await withSessionFetch(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith(`/session/${child.id}`)) return Response.json(child);
      if (path.endsWith(`/session/${root.id}/message`)) return Response.json(native);
      if (path.endsWith(`/session/${child.id}/message`)) return Response.json(turnMessages(child.id));
      if (path.endsWith(`/session/${child.id}/abort`)) { childReached.resolve(); return childAbort.promise.then((response) => response.clone()); }
      if (path.endsWith("/abort")) return Response.json(true);
      if (path.endsWith("/status")) return Response.json({ [root.id]: { type: "idle" } });
      if (path.endsWith("/prompt_async")) {
        const body = await request.json();
        sent.push(body.messageID);
        if (body.messageID === messageID) { dispatched.resolve(); return admission.promise; }
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async (requests) => {
      const client = createClient(baseUrl, root.directory);
      const send = async (id: string) => unwrap(await client.session.promptAsync({ sessionID: root.id, messageID: id, parts: [] }));
      const old = submitAfterInterruption(baseUrl, root.id, async () => {
        const response = await send(messageID);
        returned.resolve();
        return response;
      }, messageID);
      const outcome = old.then(() => undefined, (error: unknown) => error);
      await dispatched.promise;
      const stop = interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
      const followUp = submitAfterInterruption(baseUrl, root.id, () => send("msg_after_terminal"));
      try {
        // Race with Stop so a broken implementation fails at its bounded deadline.
        const error = await Promise.race([outcome, stop]);
        expect(error).toMatchObject({ message: expect.stringContaining("Send cancelled by Stop") });
        await Promise.race([childReached.promise, stop]);
        expect(sent).toEqual([messageID]);
        expect(sessionNeedsStop(baseUrl, root.id)).toBe(true);
        childAbort.resolve(Response.json(true));
        await Promise.all([stop, followUp]);
        expect(sessionNeedsStop(baseUrl, root.id)).toBe(false);
        expect(requests.filter((request) => new URL(request.url).pathname.endsWith(`/session/${root.id}/abort`))).toHaveLength(2);
        // Another Stop must finish even while the old HTTP response is still held.
        await interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
        admission.resolve(new Response(null, { status: 204 }));
        await returned.promise;
        await submitAfterInterruption(baseUrl, root.id, () => send("msg_after_late_response"));
        await interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
        expect(await outcome).toBe(error);
        expect(sent).toEqual([messageID, "msg_after_terminal", "msg_after_late_response"]);
        expect(sessionNeedsStop(baseUrl, root.id)).toBe(false);
      } finally {
        admission.resolve(new Response(null, { status: 204 }));
        childAbort.resolve(Response.json(true));
        await Promise.allSettled([old, stop, followUp]);
      }
    });
  });

  test("unknown, nonmatching, nonterminal, tool-calls, and busy evidence cannot release pending admission", async () => {
    for (const variant of ["unknown", "absent", "wrong-message", "wrong-user-session", "wrong-reply-session", "wrong-parent", "unfinished", "tool-calls", "running-tool", "busy"]) {
      const root = { ...session, id: `ses_pending_${variant}` };
      const baseUrl = endpoint.opencodeBaseUrl;
      const messageID = "msg_pending";
      const admission = Promise.withResolvers<Response>();
      const dispatched = Promise.withResolvers<void>();
      const observedID = variant === "wrong-message" ? "msg_other" : messageID;
      const native = turnMessages(root.id, variant === "running-tool" ? [delegatedTool("ses_unused", {}, "read")] : [], observedID)
        .map((message) => ({
          ...message,
          info: message.info.role === "user" ? {
            ...message.info, sessionID: variant === "wrong-user-session" ? "ses_other" : root.id,
          } : {
            ...message.info,
            sessionID: variant === "wrong-reply-session" ? "ses_other" : root.id,
            parentID: variant === "wrong-parent" ? "msg_other" : observedID,
            finish: variant === "tool-calls" ? "tool-calls" : "stop",
            time: { created: 2, ...(variant === "unfinished" ? {} : { completed: 3 }) },
          },
        }));
      let settled = false;
      let followUpSent = false;
      await withSessionFetch((request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
        if (path.endsWith("/message")) return Response.json(variant === "absent" ? [] : native);
        if (path.endsWith("/abort")) return Response.json(true);
        if (path.endsWith("/status")) return Response.json({ [root.id]: { type: variant === "busy" ? "busy" : "idle" } });
        if (path.endsWith("/prompt_async")) { dispatched.resolve(); return admission.promise; }
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      }, async () => {
        const client = createClient(baseUrl, root.directory);
        const old = submitAfterInterruption(baseUrl, root.id, async () => unwrap(await client.session.promptAsync({
          sessionID: root.id, messageID, parts: [],
        })), variant === "unknown" ? undefined : messageID);
        const outcome = old.then(() => { settled = true; }, () => { settled = true; });
        await dispatched.promise;
        const stop = interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 25 });
        const followUp = submitAfterInterruption(baseUrl, root.id, async () => { followUpSent = true; });
        try {
          for (const result of await Promise.allSettled([stop, followUp])) {
            expect(result.status).toBe("rejected");
            if (result.status !== "rejected" || !(result.reason instanceof Error)) throw new Error("Expected cancellation timeout");
            expect(result.reason.message).toContain("timed out");
          }
          expect(settled).toBe(false);
          expect(followUpSent).toBe(false);
          expect(sessionNeedsStop(baseUrl, root.id)).toBe(true);
        } finally {
          admission.resolve(new Response(null, { status: 204 }));
          await Promise.allSettled([outcome, stop, followUp]);
        }
      });
    }
  });

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
      const client = createClientV2(baseUrl, session.directory, { token: endpoint.token, mode: "openwork" });
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

  test("immediate follow-up preserves steering without current pending foreground delegation", async () => {
    for (const variant of ["ordinary", "previous", "completed", "error", "background-input", "background-metadata"]) {
      const rootID = `ses_steer_${variant}`;
      const current = turnMessages(rootID, variant === "ordinary" ? [delegatedTool("ses_read", {}, "read")] :
        variant === "previous" ? [] : [delegatedTool("ses_ignored", {
          ...(variant === "completed" ? { status: "completed", output: "done" } : {}),
          ...(variant === "error" ? { status: "error", error: "cancelled" } : {}),
          ...(variant === "background-input" ? { input: { background: true } } : {}),
          ...(variant === "background-metadata" ? { metadata: { sessionID: "ses_ignored", background: true } } : {}),
        })]);
      const sent: boolean[] = [];
      await withSessionFetch((request) => {
        if (request.method === "GET") return Response.json([
          ...turnMessages(rootID, [delegatedTool("ses_old")], "msg_old"), ...current,
        ]);
        throw new Error("Ordinary steering must not abort");
      }, async (requests) => {
        const client = createClient(endpoint.opencodeBaseUrl);
        const messages = unwrap(await client.session.messages({ sessionID: rootID }));
        await submitImmediateSessionTurn(endpoint.opencodeBaseUrl, client, rootID, messages, async (afterStop) => { sent.push(afterStop); });
        expect(sent).toEqual([false]);
        expect(requests.filter((request) => request.method === "POST")).toEqual([]);
      });
    }
  });

  test("another Stop cancels an immediate successor while pending delegation is being interrupted", async () => {
    const rootID = "ses_immediate_stop_race";
    const idle = Promise.withResolvers<Response>();
    const reached = Promise.withResolvers<void>();
    let sends = 0;
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/message")) return Response.json(turnMessages(rootID, [
        delegatedTool("ses_pending", { status: "pending", metadata: undefined }),
      ]));
      if (path.endsWith("/abort")) return Response.json(true);
      if (path.endsWith("/status")) { reached.resolve(); return idle.promise; }
      if (path.endsWith(`/session/${rootID}`)) return Response.json({ ...session, id: rootID });
      throw new Error(`Unexpected request: ${path}`);
    }, async () => {
      const client = createClient(endpoint.opencodeBaseUrl);
      const current = unwrap(await client.session.messages({ sessionID: rootID }));
      const next = submitImmediateSessionTurn(endpoint.opencodeBaseUrl, client, rootID, current, async () => { sends += 1; });
      const outcome = next.then(() => undefined, (error: unknown) => error);
      try {
        await reached.promise;
        const stop = interruptSessionTurn(endpoint.opencodeBaseUrl, client, rootID);
        idle.resolve(Response.json({}));
        await stop;
        expect(await outcome).toMatchObject({ message: "Send cancelled by Stop." });
        expect(sends).toBe(0);
      } finally {
        idle.resolve(Response.json({}));
        await outcome;
      }
    });
  });

  test("unknown admission stays fenced even after the visible run stops", async () => {
    const root = { ...session, id: "ses_unknown_stop" };
    let sends = 0;
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith("/message")) return Response.json(turnMessages(root.id));
      if (path.endsWith("/abort")) return Response.json(true);
      if (path.endsWith("/status")) return Response.json({});
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async (requests) => {
      const client = createClient(endpoint.opencodeBaseUrl, root.directory);
      await expect(interruptSessionTurn(endpoint.opencodeBaseUrl, client, root.id, root.directory, { admissionUnknown: true }))
        .rejects.toThrow("acceptance is still unknown");
      await expect(submitAfterInterruption(endpoint.opencodeBaseUrl, root.id, async () => { sends += 1; }))
        .rejects.toThrow("acceptance is still unknown");
      expect(sends).toBe(0);
      expect(requests.filter((request) => request.method === "POST")).toHaveLength(2);
      expect(sessionNeedsStop(endpoint.opencodeBaseUrl, root.id)).toBe(true);
    });
  });

  test.each([false, true])("stops only the current foreground tree through delayed child abort and authoritative idle (immediate: %s)", async (immediate) => {
    const root = { ...session, id: `ses_tree_${immediate}` };
    const baseUrl = endpoint.opencodeBaseUrl;
    const childAbort = Promise.withResolvers<Response>();
    const childReached = Promise.withResolvers<void>();
    const idle = Promise.withResolvers<Response>();
    const idleReached = Promise.withResolvers<void>();
    const aborted: string[] = [];
    const sent: boolean[] = [];
    let admissionReconciled = false;
    let statusReads = 0;
    const sessions: Record<string, Session> = {
      [root.id]: root,
      ses_child: { ...session, id: "ses_child", parentID: root.id },
      ses_nested: { ...session, id: "ses_nested", parentID: "ses_child" },
      ses_late: { ...session, id: "ses_late", parentID: root.id },
    };
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/status")) {
        if (++statusReads === 1) return Response.json({ ses_nested: { type: "busy" }, ses_unrelated: { type: "busy" } });
        idleReached.resolve();
        return idle.promise;
      }
      const [, id, action] = path.match(/\/session\/([^/]+)(?:\/([^/]+))?$/) ?? [];
      if (request.method === "POST" && action === "prompt_async") return new Response(null, { status: 204 });
      if (request.method === "POST" && action === "abort" && id) {
        aborted.push(id);
        if (id === "ses_child") { childReached.resolve(); return childAbort.promise; }
        return Response.json(true);
      }
      if (action === "message" && id === root.id) return Response.json([
        ...turnMessages(root.id, [delegatedTool("ses_old")], "msg_old"),
        ...turnMessages(root.id, [
          delegatedTool("ses_child"),
          delegatedTool("ses_completed", { status: "completed", output: "done" }),
          delegatedTool("ses_background_input", { input: { background: true } }),
          delegatedTool("ses_background_metadata", { metadata: { sessionID: "ses_background_metadata", background: true } }),
          delegatedTool("ses_not_a_task", {}, "read"),
          delegatedTool(root.id),
          ...(aborted.includes(root.id) ? [delegatedTool("ses_late", { status: "error", error: "cancelled" })] : []),
        ]),
      ]);
      if (action === "message" && id === "ses_child") return Response.json(turnMessages(id, [
        delegatedTool("ses_nested", { metadata: { sessionID: "ses_nested" } }, "subagent"),
      ]));
      if (action === "message" && id && sessions[id]) return Response.json(turnMessages(id));
      if (!action && id && sessions[id]) return Response.json(sessions[id]);
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async (requests) => {
      const client = createClient(baseUrl, root.directory, { token: endpoint.token, mode: "openwork" });
      const current = unwrap(await client.session.messages({ sessionID: root.id, directory: root.directory }));
      const stop = immediate ? undefined : interruptSessionTurn(baseUrl, client, root.id, root.directory, {
        timeoutMs: 1_000, onStopped: () => { admissionReconciled = true; },
      });
      const send = async (afterStop: boolean) => {
        if (!immediate) expect(admissionReconciled).toBe(true);
        sent.push(afterStop);
        return unwrap(await client.session.promptAsync({ sessionID: root.id, parts: [{ type: "text", text: "follow-up" }] }));
      };
      const followUp = immediate
        ? submitImmediateSessionTurn(baseUrl, client, root.id, current, send, { directory: root.directory })
        : submitAfterInterruption(baseUrl, root.id, send);
      try {
        await childReached.promise;
        expect(sent).toEqual([]);
        expect(sessionNeedsStop(baseUrl, root.id)).toBe(true);
        childAbort.resolve(Response.json(true));
        await idleReached.promise;
        expect(aborted).toEqual([root.id, root.id, "ses_child", "ses_nested", "ses_late"]);
        expect(sent).toEqual([]);
        expect(sessionNeedsStop(baseUrl, root.id)).toBe(true);
        // Busy sessions outside this turn must neither be stopped nor hold the fence.
        idle.resolve(Response.json({ [root.id]: { type: "idle" }, ses_unrelated: { type: "busy" }, ses_old: { type: "busy" } }));
        await Promise.all([stop, followUp]);
        expect(sent).toEqual([true]);
        expect(sessionNeedsStop(baseUrl, root.id)).toBe(false);
        expect(requests.filter((request) => /\/session\/ses_[^/]+$/.test(new URL(request.url).pathname))
          .map((request) => new URL(request.url).pathname.split("/").at(-1)))
          .toEqual([root.id, "ses_child", "ses_nested", "ses_late"]);
        for (const request of requests) {
          expect(request.url.startsWith(`${baseUrl}/session/`) || request.url.startsWith(`${baseUrl}/path?`)).toBe(true);
          expect(request.headers.get("Authorization")).toBe(`Bearer ${endpoint.token}`);
          if (!request.url.endsWith("/prompt_async")) expect(new URL(request.url).searchParams.get("directory")).toBe(root.directory);
        }
      } finally {
        childAbort.resolve(Response.json(true));
        idle.resolve(Response.json({}));
        await Promise.allSettled([stop, followUp]);
      }
    });
  });

  test("refuses cross-directory and wrong-parent children without aborting them or admitting follow-up", async () => {
    for (const mismatch of ["directory", "parentID"]) {
      const root = { ...session, id: `ses_owner_${mismatch}` };
      const child = { ...session, id: "ses_foreign", parentID: root.id, [mismatch]: "other-owner" };
      const sent: boolean[] = [];
      await withSessionFetch((request) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
        if (path.endsWith(`/session/${child.id}`)) return Response.json(child);
        if (path.endsWith(`/session/${root.id}/message`)) return Response.json(turnMessages(root.id, [delegatedTool(child.id)]));
        if (path.endsWith(`/session/${root.id}/abort`)) return Response.json(true);
        throw new Error(`Unexpected request: ${request.method} ${path}`);
      }, async (requests) => {
        const client = createClient(endpoint.opencodeBaseUrl, root.directory);
        await expect(interruptSessionTurn(endpoint.opencodeBaseUrl, client, root.id, root.directory, { timeoutMs: 1_000 }))
          .rejects.toThrow("Could not verify the delegated session owner");
        expect(sessionNeedsStop(endpoint.opencodeBaseUrl, root.id)).toBe(true);
        await expect(submitAfterInterruption(endpoint.opencodeBaseUrl, root.id, async (afterStop) => { sent.push(afterStop); }))
          .rejects.toThrow("Could not verify the delegated session owner");
        expect(sent).toEqual([]);
        expect(requests.filter((request) => request.method === "POST").map((request) => new URL(request.url).pathname))
          .toEqual(Array(2).fill(`/workspace/ws-native/opencode/session/${root.id}/abort`));
      });
    }
  });

  test("false abort with authoritative busy times out, keeps sends blocked, and releases only on explicit Stop retry", async () => {
    const root = { ...session, id: "ses_retry" };
    const baseUrl = endpoint.opencodeBaseUrl;
    const sent: boolean[] = [];
    let busy = true;
    let statusReads = 0;
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith("/message")) return Response.json(turnMessages(root.id));
      if (path.endsWith("/abort")) return Response.json(false);
      if (path.endsWith("/status")) { statusReads += 1; return Response.json({ [root.id]: { type: busy ? "busy" : "idle" } }); }
      if (path.endsWith("/prompt_async")) return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async (requests) => {
      const client = createClient(baseUrl, root.directory);
      const send = async (afterStop: boolean) => {
        sent.push(afterStop);
        return unwrap(await client.session.promptAsync({ sessionID: root.id, parts: [{ type: "text", text: "follow-up" }] }));
      };
      const stop = interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 25 });
      const followUp = submitAfterInterruption(baseUrl, root.id, send);
      for (const outcome of await Promise.allSettled([stop, followUp])) {
        if (outcome.status !== "rejected" || !(outcome.reason instanceof Error)) {
          throw new Error("Stop and follow-up must both reject on timeout");
        }
        expect(outcome.reason.message).toContain("timed out. Retry Stop before sending");
      }
      expect(statusReads).toBeGreaterThan(0);
      expect(sessionNeedsStop(baseUrl, root.id)).toBe(true);
      busy = false;
      await expect(submitAfterInterruption(baseUrl, root.id, send)).rejects.toThrow("Retry Stop before sending");
      expect(sent).toEqual([]);
      expect(requests.filter((request) => request.url.endsWith("/prompt_async"))).toHaveLength(0);
      const retry = interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
      const retriedFollowUp = submitAfterInterruption(baseUrl, root.id, send);
      await Promise.all([retry, retriedFollowUp]);
      expect(sessionNeedsStop(baseUrl, root.id)).toBe(false);
      expect(sent).toEqual([true]);
      expect(requests.filter((request) => request.url.endsWith("/prompt_async"))).toHaveLength(1);
    });
  });

  test("drains old preflight before follow-up and cancels sends that had not entered preflight at Stop", async () => {
    const root = { ...session, id: "ses_preflight" };
    const baseUrl = endpoint.opencodeBaseUrl;
    const preflight = Promise.withResolvers<Response>();
    const preflightReached = Promise.withResolvers<void>();
    const firstAbort = Promise.withResolvers<void>();
    const events: string[] = [];
    await withSessionFetch(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/todo")) { preflightReached.resolve(); return preflight.promise; }
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith("/message")) return Response.json(turnMessages(root.id));
      if (path.endsWith("/abort")) { events.push("abort"); firstAbort.resolve(); return Response.json(true); }
      if (path.endsWith("/status")) { events.push("idle"); return Response.json({}); }
      if (path.endsWith("/prompt_async")) {
        const body = await request.json();
        events.push(body.messageID);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async () => {
      const client = createClient(baseUrl, root.directory);
      const send = async (messageID: string) => unwrap(await client.session.promptAsync({ sessionID: root.id, messageID, parts: [] }));
      const old = submitAfterInterruption(baseUrl, root.id, async () => {
        unwrap(await client.session.todo({ sessionID: root.id }));
        return send("msg_old_preflight");
      });
      await preflightReached.promise;
      const notStarted = submitAfterInterruption(baseUrl, root.id, () => send("msg_never_started"));
      const stop = interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
      const cancelled = expect(notStarted).rejects.toThrow("Send cancelled by Stop");
      const followUp = submitAfterInterruption(baseUrl, root.id, () => send("msg_follow_up"));
      try {
        await firstAbort.promise;
        await cancelled;
        expect(events).toEqual(["abort"]);
        preflight.resolve(Response.json([]));
        await Promise.all([old, stop, followUp]);
        expect(events).toEqual(["abort", "msg_old_preflight", "abort", "idle", "msg_follow_up"]);
        expect(sessionNeedsStop(baseUrl, root.id)).toBe(false);
      } finally {
        preflight.resolve(Response.json([]));
        await Promise.allSettled([old, stop, followUp, notStarted]);
      }
    });
  });

  test("re-aborts a mid-send predecessor admitted after the first abort before allowing follow-up", async () => {
    const root = { ...session, id: "ses_mid_send" };
    const baseUrl = endpoint.opencodeBaseUrl;
    const admission = Promise.withResolvers<Response>();
    const dispatched = Promise.withResolvers<void>();
    const firstAbort = Promise.withResolvers<void>();
    const events: string[] = [];
    let busy = false;
    await withSessionFetch(async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith("/message")) return Response.json(turnMessages(root.id));
      if (path.endsWith("/abort")) { busy = false; events.push("abort"); firstAbort.resolve(); return Response.json(true); }
      if (path.endsWith("/status")) { events.push("status"); return Response.json({ [root.id]: { type: busy ? "busy" : "idle" } }); }
      if (path.endsWith("/prompt_async")) {
        const body = await request.json();
        if (body.messageID === "msg_old") {
          events.push("old-dispatched");
          dispatched.resolve();
          const response = await admission.promise;
          busy = true;
          events.push("old-admitted");
          return response;
        }
        events.push("follow-up");
        busy = true;
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async () => {
      const client = createClient(baseUrl, root.directory);
      const send = async (messageID: string) => unwrap(await client.session.promptAsync({ sessionID: root.id, messageID, parts: [] }));
      const old = submitAfterInterruption(baseUrl, root.id, () => send("msg_old"));
      await dispatched.promise;
      const stop = interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
      const followUp = submitAfterInterruption(baseUrl, root.id, () => send("msg_follow_up"));
      try {
        await firstAbort.promise;
        expect(events).toEqual(["old-dispatched", "abort"]);
        admission.resolve(new Response(null, { status: 204 }));
        await Promise.all([old, stop, followUp]);
        expect(events).toEqual(["old-dispatched", "abort", "old-admitted", "abort", "status", "follow-up"]);
        expect(busy).toBe(true);
        expect(sessionNeedsStop(baseUrl, root.id)).toBe(false);
      } finally {
        admission.resolve(new Response(null, { status: 204 }));
        await Promise.allSettled([old, stop, followUp]);
      }
    });
  });

  test("shares duplicate Stop across clients and trailing slashes without fencing another workspace, engine, or session", async () => {
    const root = { ...session, id: "ses_scope" };
    const baseUrl = endpoint.opencodeBaseUrl;
    const idle = Promise.withResolvers<Response>();
    const idleReached = Promise.withResolvers<void>();
    const sent: string[] = [];
    const targets = [
      { baseUrl: baseUrl.replace("ws-native", "ws-other"), sessionID: root.id },
      { baseUrl: baseUrl.replace("worker.example", "engine.example"), sessionID: root.id },
      { baseUrl, sessionID: "ses_other" },
    ];
    await withSessionFetch((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith(`/session/${root.id}`)) return Response.json(root);
      if (path.endsWith("/message")) return Response.json(turnMessages(root.id));
      if (path.endsWith("/abort")) return Response.json(true);
      if (path.endsWith("/status")) { idleReached.resolve(); return idle.promise; }
      if (path.endsWith("/prompt_async")) { sent.push(request.url); return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected request: ${request.method} ${path}`);
    }, async (requests) => {
      const client = createClient(baseUrl, root.directory);
      const otherClient = createClient(baseUrl, root.directory);
      const stop = interruptSessionTurn(baseUrl, client, root.id, root.directory, { timeoutMs: 1_000 });
      expect(interruptSessionTurn(`${baseUrl}/`, otherClient, root.id, root.directory, { timeoutMs: 1_000 })).toBe(stop);
      const followUp = submitAfterInterruption(`${baseUrl}/`, root.id, async (afterStop) => {
        expect(afterStop).toBe(true);
        return unwrap(await otherClient.session.promptAsync({ sessionID: root.id, parts: [] }));
      });
      try {
        await idleReached.promise;
        expect(sessionNeedsStop(`${baseUrl}/`, root.id)).toBe(true);
        for (const target of targets) {
          expect(sessionNeedsStop(target.baseUrl, target.sessionID)).toBe(false);
          const independentClient = createClient(target.baseUrl, root.directory);
          await submitAfterInterruption(target.baseUrl, target.sessionID, async (afterStop) => {
            expect(afterStop).toBe(false);
            return unwrap(await independentClient.session.promptAsync({ sessionID: target.sessionID, parts: [] }));
          });
        }
        expect(sent).toEqual(targets.map((target) => `${target.baseUrl}/session/${target.sessionID}/prompt_async`));
        expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/abort"))).toHaveLength(2);
        idle.resolve(Response.json({}));
        await Promise.all([stop, followUp]);
        expect(sent.at(-1)).toBe(`${baseUrl}/session/${root.id}/prompt_async`);
        expect(sent).toHaveLength(4);
        expect(sessionNeedsStop(baseUrl, root.id)).toBe(false);
      } finally {
        idle.resolve(Response.json({}));
        await Promise.allSettled([stop, followUp]);
      }
    });
  });
});
