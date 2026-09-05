import { describe, expect, test } from "bun:test";
import type { Message, Part, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import type { FieldsResult } from "../src/app/lib/opencode";
import {
  composeNativeSessionSnapshot,
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

describe("native OpenCode session operations", () => {
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
});
