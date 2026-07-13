import { describe, expect, test } from "bun:test";

import { ApiError } from "./errors.js";
import {
  buildSession,
  buildSessionList,
  buildSessionMessages,
  buildSessionSnapshot,
  buildSessionStatuses,
  buildSessionTodos,
} from "./session-read-model.js";

const session = {
  id: "ses_1",
  title: "Owned session contract",
  slug: "owned-session-contract",
  directory: "/workspace",
  time: { created: 100, updated: 200, compacting: 150 },
  futureEngineField: { preserved: true },
};

const message = {
  info: {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 200 },
    futureEngineInfo: "preserved",
  },
  parts: [
    {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "text",
      text: "OpenWork owns the boundary",
      futureEnginePart: 42,
    },
  ],
};

describe("session read model adapter", () => {
  test("accepts unknown vendor responses and preserves existing passthrough behavior", () => {
    const vendorList: unknown = [session];
    const vendorSession: unknown = session;
    const vendorMessages: unknown = [message];
    const vendorTodos: unknown = [
      {
        content: "Keep behavior intact",
        status: "completed",
        priority: "high",
        futureEngineTodo: true,
      },
    ];
    const vendorStatuses: unknown = { ses_1: { type: "busy", futureEngineStatus: true } };

    expect(buildSessionList(vendorList)).toEqual([session]);
    expect(buildSession(vendorSession)).toEqual(session);
    expect(buildSessionMessages(vendorMessages)).toEqual([message]);
    expect(buildSessionTodos(vendorTodos)).toEqual([
      {
        content: "Keep behavior intact",
        status: "completed",
        priority: "high",
        futureEngineTodo: true,
      },
    ]);
    expect(buildSessionStatuses(vendorStatuses)).toEqual({ ses_1: { type: "busy" } });
  });

  test("assembles snapshots with the established idle fallback", () => {
    const result = buildSessionSnapshot({
      session,
      messages: [message],
      todos: [],
      statuses: {},
    });

    expect(result).toEqual({
      session,
      messages: [message],
      todos: [],
      status: { type: "idle" },
    });
  });

  test("maps stable contract issues to the existing public ApiError", () => {
    try {
      buildSessionMessages([
        {
          info: { id: "msg_1", sessionID: "ses_1", role: "assistant" },
          parts: [{ id: "prt_1", messageID: 42, sessionID: "ses_1" }],
        },
      ]);
      throw new Error("expected buildSessionMessages to reject the response");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw error;
      expect(error.status).toBe(502);
      expect(error.code).toBe("opencode_invalid_response");
      expect(error.message).toBe("OpenCode returned invalid session messages");
      expect(error.details).toEqual({
        issues: [
          {
            code: "invalid_type",
            expected: "string",
            message: "Invalid input: expected string, received number",
            path: [0, "parts", 0, "messageID"],
          },
        ],
      });
    }
  });
});
