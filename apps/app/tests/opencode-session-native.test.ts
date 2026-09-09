import { describe, expect, test } from "bun:test";
import { focusManager } from "@tanstack/react-query";
import type { Message, Part, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import { createClient, createPromptMessageID, hasAcceptedPromptMessage, unwrap, type FieldsResult } from "../src/app/lib/opencode";
import { interruptSessionTurn, sessionNeedsStop, submitAfterInterruption } from "../src/app/lib/opencode-interruption";
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
      limit: 140,
      signal: controller.signal,
    }, {
      createOperations: () => operations({
        get: async (_sessionId, options) => {
          calls.push(options?.signal === controller.signal ? "get" : "bad-get");
          return result(session);
        },
        messages: async (_sessionId, limit, options) => {
          calls.push(limit === 140 && options?.signal === controller.signal ? "messages" : "bad-messages");
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

  test("retries a failed local snapshot read without waiting for query focus or issuing writes", async () => {
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
      }), { limit: 140 }, {
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
      expect(calls).toEqual(["get", "messages", "todo", "status", "get", "messages", "todo", "status"]);
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

  test("aborting a local snapshot retry prevents the next read attempt", async () => {
    const controller = new AbortController();
    const aborted = new Error("snapshot read cancelled");
    let attempt = 0;
    const promise = composeNativeSessionSnapshotWithRetry("owner-a", () => ({
      owner: "owner-a",
      endpoint,
      sessionId: session.id,
    }), { signal: controller.signal }, {
      createOperations: () => {
        attempt += 1;
        return operations({ get: async () => failedResult({ code: "engine_reloading" }, 503) });
      },
      waitForSnapshotRetry: async () => { controller.abort(aborted); },
    });

    await expect(promise).rejects.toBe(aborted);
    expect(attempt).toBe(1);
  });
});

describe("native Stop and follow-up handoff", () => {
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

  test("v2 interrupts the native subagent before admitting the next prompt", async () => {
    const baseUrl = endpoint.opencodeBaseUrl.replace("opencode", "opencode2");
    const rootID = "ses_v2_stop";
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
      const stop = interruptSessionTurn(baseUrl, client, rootID, session.directory);
      const next = submitAfterInterruption(baseUrl, rootID, async () => unwrap(await client.session.promptAsync({
        sessionID: rootID, model: { providerID: "mock", modelID: "mock" }, parts: [{ type: "text", text: "new turn" }],
      })));
      await Promise.all([stop, next]);
      expect(events).toEqual([`interrupt:${rootID}`, `interrupt:${rootID}`, `interrupt:${childID}`, `prompt:${rootID}`]);
      expect(requests.every((request) => new URL(request.url).pathname.includes("/opencode2/api/"))).toBe(true);
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

  test("stops only the current foreground tree and holds follow-up through delayed child abort and authoritative idle", async () => {
    const root = { ...session, id: "ses_tree" };
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
      const stop = interruptSessionTurn(baseUrl, client, root.id, root.directory, {
        timeoutMs: 1_000, onStopped: () => { admissionReconciled = true; },
      });
      const followUp = submitAfterInterruption(baseUrl, root.id, async (afterStop) => {
        expect(admissionReconciled).toBe(true);
        sent.push(afterStop);
        return unwrap(await client.session.promptAsync({ sessionID: root.id, parts: [{ type: "text", text: "follow-up" }] }));
      });
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
          expect(request.url.startsWith(`${baseUrl}/session/`)).toBe(true);
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
