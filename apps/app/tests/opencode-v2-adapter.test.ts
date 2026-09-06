import { describe, expect, test } from "bun:test";

import {
  createClientV2,
  createV2EventTranslationState,
  translateV2Event,
} from "../src/app/lib/opencode-v2-adapter";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import { codeModeToolCalls } from "../src/lib/code-mode-tools";

const capturedPermissionAsked = {
  id: "evt_permission_asked",
  created: 1_788_548_737_221,
  type: "permission.asked",
  location: { directory: "/workspace" },
  data: {
    id: "per_child",
    sessionID: "ses_child",
    action: "shell",
    resources: ["printf 'TOOL_RESULT_OK'"],
    save: ["printf *"],
    source: { type: "tool", messageID: "msg_child", id: "call_child" },
    message: "Allow this command?",
  },
  durable: { aggregateID: "ses_child", seq: 8, version: 1 },
};

const capturedPermissionReplied = {
  id: "evt_permission_replied",
  created: 1_788_548_737_260,
  type: "permission.replied",
  location: { directory: "/workspace" },
  data: { sessionID: "ses_child", requestID: "per_child", reply: "once" },
};

// Captured from 0.0.0-beta-19086 after approving one shell call with `once`.
const capturedV2ToolMessage = {
  id: "msg_06e0e76b900178zSuF55n4XEPY",
  time: {
    created: 1_788_552_837_299,
    streamed: 1_788_552_838_056,
    completed: 1_788_552_838_186,
  },
  type: "assistant",
  agent: "openwork",
  model: { id: "model", providerID: "witness", variant: "default" },
  content: [
    { type: "text", text: "Running the shell.\n" },
    {
      type: "tool",
      id: "call_captured_shell",
      name: "shell",
      executed: false,
      state: {
        status: "completed",
        input: { command: "printf 'TOOL_RESULT_OK\\n'", timeout: 30_000 },
        content: [
          { type: "text", text: "TOOL_RESULT_OK\n" },
          { type: "text", text: "Command exited with code 0." },
        ],
        metadata: { status: "completed", truncated: false, exit: 0 },
      },
      time: {
        created: 1_788_552_837_549,
        ran: 1_788_552_838_052,
        completed: 1_788_552_838_184,
      },
    },
  ],
  finish: "tool-calls",
  rawFinish: "tool_calls",
  cost: 0,
  tokens: {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  },
};

const capturedV2ToolEvents = [
  {
    id: "evt_06e0e79ad001BAvTZOqueGcqPa",
    created: 1_788_552_837_549,
    type: "session.tool.input.started",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      name: "shell",
    },
  },
  {
    id: "evt_06e0e7ba3001XQZt8DvOc8VTE1",
    created: 1_788_552_838_051,
    type: "session.tool.input.ended",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      text: "{\"command\":\"printf 'TOOL_RESULT_OK\\\\n'\",\"timeout\":30000}",
    },
  },
  {
    id: "evt_06e0e7ba4001XebEvHlJDSttDY",
    created: 1_788_552_838_052,
    type: "session.tool.called",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      input: { command: "printf 'TOOL_RESULT_OK\\n'", timeout: 30_000 },
      executed: false,
    },
  },
  {
    id: "evt_06e0e7c22002P2HdF8g7Jt5EGX",
    created: 1_788_552_838_178,
    type: "session.tool.progress",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      metadata: { shellID: "sh_06e0e7c1e0017KTSezeFHBiGRk" },
    },
  },
  {
    id: "evt_06e0e7c28001BsHlyKVTMaacIe",
    created: 1_788_552_838_184,
    type: "session.tool.success",
    data: {
      sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
      assistantMessageID: "msg_06e0e76b900178zSuF55n4XEPY",
      id: "call_captured_shell",
      content: [
        { type: "text", text: "TOOL_RESULT_OK\n" },
        { type: "text", text: "Command exited with code 0." },
      ],
      metadata: { status: "completed", truncated: false, exit: 0 },
      executed: false,
    },
  },
];

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenCode v2 event translation", () => {
  test("renders an admitted user message before execution using its persisted identity", () => {
    const state = createV2EventTranslationState();
    const admitted = {
      type: "session.inbox.enqueued",
      created: 1_788_657_600_000,
      location: { directory: "/workspace" },
      data: {
        sessionID: "ses_upgrade",
        inboxID: "msg_user",
        item: { type: "user", payload: { text: "hi" }, delivery: "steer" },
      },
    };
    const expected = [
      { type: "message.updated", properties: { info: {
        id: "msg_user", sessionID: "ses_upgrade", role: "user", time: { created: admitted.created },
      } } },
      { type: "message.part.updated", properties: { part: {
        id: "msg_user:0", messageID: "msg_user", sessionID: "ses_upgrade", type: "text", text: "hi",
      } } },
    ];
    expect(translateV2Event(admitted, state)).toEqual(expected);
    // A replay must update the same message and part, not create another row.
    expect(translateV2Event(admitted, state)).toEqual(expected);
    expect(translateV2Event({
      type: "session.inbox.cancelled", data: { sessionID: "ses_upgrade", inboxID: "msg_user" },
    }, state)).toEqual([
      { type: "message.removed", properties: { sessionID: "ses_upgrade", messageID: "msg_user" } },
    ]);
    expect(translateV2Event({ ...admitted, data: {
      ...admitted.data, item: { type: "synthetic", payload: { text: "Internal instructions" }, delivery: "steer" },
    } }, state)).toBeNull();
  });

  test("uses the created envelope timestamp for an untitled session", () => {
    const created = 1_788_548_737_221;
    const event = {
      type: "session.created",
      created,
      location: { directory: "/workspace" },
      data: { sessionID: "ses_new" },
    };

    expect(translateV2Event(event, createV2EventTranslationState())).toEqual([{
      type: "session.created",
      properties: {
        info: {
          id: "ses_new",
          slug: "ses_new",
          projectID: "v2",
          directory: "/workspace",
          title: `New session - ${new Date(created).toISOString()}`,
          version: "v2",
          time: { created, updated: created },
        },
      },
    }]);
    expect(event.data).toEqual({ sessionID: "ses_new" });
  });

  test.each(["Named session", "Untitled session", ""])("translates rename %j as a title-only patch", (title) => {
    expect(translateV2Event({
      type: "session.renamed",
      created: 1_788_548_737_260,
      location: { directory: "/workspace" },
      data: { sessionID: "ses_named", title },
    }, createV2EventTranslationState())).toEqual([{
      type: "session.updated",
      properties: { info: { id: "ses_named", title } },
    }]);
  });

  test("does not turn an incomplete rename into a generated title", () => {
    expect(translateV2Event({
      type: "session.renamed",
      data: { sessionID: "ses_named" },
    }, createV2EventTranslationState())).toBeNull();
  });

  test("uses one stable text part id from start through the cumulative end update", () => {
    const state = createV2EventTranslationState();

    expect(translateV2Event({
      type: "session.text.started",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "msg_1",
        textID: "txt_1",
        timestamp: 10,
      },
    }, state)).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            sessionID: "ses_1",
            role: "assistant",
            time: { created: 10 },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "msg_1:0",
            messageID: "msg_1",
            sessionID: "ses_1",
            type: "text",
            text: "",
          },
        },
      },
    ]);

    expect(translateV2Event({
      type: "session.text.delta",
      data: { sessionID: "ses_1", textID: "txt_1", delta: "Hello " },
    }, state)).toEqual([{
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "msg_1:0",
        field: "text",
        delta: "Hello ",
      },
    }]);
    translateV2Event({
      type: "session.text.delta",
      data: { sessionID: "ses_1", textID: "txt_1", delta: "world" },
    }, state);

    expect(translateV2Event({
      type: "session.text.ended",
      data: { sessionID: "ses_1", textID: "txt_1" },
    }, state)).toEqual([{
      type: "message.part.updated",
      properties: {
        part: {
          id: "msg_1:0",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "text",
          text: "Hello world",
        },
      },
    }]);
  });

  test("uses event-provided ordinals to keep same-message text parts distinct", () => {
    const state = createV2EventTranslationState();

    const firstStarted = translateV2Event({
      type: "session.text.started",
      data: { sessionID: "ses_ordinal", assistantMessageID: "msg_ordinal", ordinal: 0 },
    }, state);
    const secondStarted = translateV2Event({
      type: "session.text.started",
      data: { sessionID: "ses_ordinal", assistantMessageID: "msg_ordinal", ordinal: 1 },
    }, state);

    expect(firstStarted?.[1]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { id: "msg_ordinal:0" } },
    });
    expect(secondStarted?.[1]).toMatchObject({
      type: "message.part.updated",
      properties: { part: { id: "msg_ordinal:1" } },
    });

    const delta = translateV2Event({
      type: "session.text.delta",
      data: { sessionID: "ses_ordinal", assistantMessageID: "msg_ordinal", ordinal: 1, delta: "second" },
    }, state);
    expect(delta).toEqual([{
      type: "message.part.delta",
      properties: {
        sessionID: "ses_ordinal",
        messageID: "msg_ordinal",
        partID: "msg_ordinal:1",
        field: "text",
        delta: "second",
      },
    }]);
    expect(delta).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ partID: "msg_ordinal:0" }) }),
    ]));
  });

  test("translates captured v2 text lifecycle events through terminal idle", () => {
    const state = createV2EventTranslationState();
    const captured = [
      { type: "session.text.started", data: { sessionID: "s", assistantMessageID: "m", ordinal: 0 } },
      { type: "session.text.delta", data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, delta: "hello world" } },
      { type: "session.text.ended", data: { sessionID: "s", assistantMessageID: "m", ordinal: 0, text: "hello world" } },
      { type: "session.execution.succeeded", data: { sessionID: "s" } },
    ];
    const translated = captured.flatMap((event) => translateV2Event(event, state) ?? []);

    expect(translated).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "m",
            sessionID: "s",
            role: "assistant",
            time: { created: expect.any(Number) },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "m:0", messageID: "m", sessionID: "s", type: "text", text: "" },
        },
      },
      {
        type: "message.part.delta",
        properties: {
          sessionID: "s",
          messageID: "m",
          partID: "m:0",
          field: "text",
          delta: "hello world",
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "m:0", messageID: "m", sessionID: "s", type: "text", text: "hello world" },
        },
      },
      { type: "session.status", properties: { sessionID: "s", status: { type: "idle" } } },
      { type: "session.idle", properties: { sessionID: "s" } },
    ]);
  });

  test("translates the captured v2 shell lifecycle using the bash presentation", () => {
    const state = createV2EventTranslationState();
    const translated = capturedV2ToolEvents.flatMap((event) => translateV2Event(event, state) ?? []);
    const command = { command: "printf 'TOOL_RESULT_OK\\n'", timeout: 30_000 };

    expect(translated).toEqual([
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
            role: "assistant",
            time: { created: 1_788_552_837_549 },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "call_captured_shell",
            messageID: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
            type: "tool",
            callID: "call_captured_shell",
            tool: "bash",
            state: { status: "pending", input: {}, raw: "" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: expect.objectContaining({
            id: "call_captured_shell",
            state: {
              status: "pending",
              input: command,
              raw: "{\"command\":\"printf 'TOOL_RESULT_OK\\\\n'\",\"timeout\":30000}",
            },
          }),
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: expect.objectContaining({
            id: "call_captured_shell",
            state: {
              status: "running",
              input: command,
              title: "bash",
              metadata: {},
              time: { start: 1_788_552_838_052 },
            },
          }),
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: expect.objectContaining({
            id: "call_captured_shell",
            state: {
              status: "running",
              input: command,
              title: "bash",
              metadata: { shellID: "sh_06e0e7c1e0017KTSezeFHBiGRk" },
              time: { start: 1_788_552_838_052 },
            },
          }),
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "call_captured_shell",
            messageID: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_f91f18e25ffeiB1huO0Hascs8b",
            type: "tool",
            callID: "call_captured_shell",
            tool: "bash",
            state: {
              status: "completed",
              input: command,
              output: "TOOL_RESULT_OK\n\nCommand exited with code 0.",
              title: "bash",
              metadata: { status: "completed", truncated: false, exit: 0 },
              time: { start: 1_788_552_838_052, end: 1_788_552_838_184 },
            },
          },
        },
      },
    ]);
  });

  test("emits an error before terminal idle events for failed execution", () => {
    const state = createV2EventTranslationState();
    expect(translateV2Event({
      type: "session.execution.failed",
      properties: { sessionID: "ses_2", error: { message: "provider failed" } },
    }, state)).toEqual([
      {
        type: "session.error",
        properties: {
          sessionID: "ses_2",
          error: { name: "UnknownError", data: { message: "provider failed" } },
        },
      },
      { type: "session.status", properties: { sessionID: "ses_2", status: { type: "idle" } } },
      { type: "session.idle", properties: { sessionID: "ses_2" } },
    ]);
  });

  test("translates captured permission events for the child session while preserving busy and idle", () => {
    const state = createV2EventTranslationState();
    const translated = [
      { type: "session.execution.started", data: { sessionID: "ses_child" } },
      capturedPermissionAsked,
      capturedPermissionReplied,
      { type: "session.execution.succeeded", data: { sessionID: "ses_child" } },
    ].flatMap((event) => translateV2Event(event, state) ?? []);

    expect(translated).toEqual([
      { type: "session.status", properties: { sessionID: "ses_child", status: { type: "busy" } } },
      {
        type: "permission.asked",
        properties: {
          id: "per_child",
          sessionID: "ses_child",
          action: "shell",
          resources: ["printf 'TOOL_RESULT_OK'"],
          save: ["printf *"],
          metadata: { message: "Allow this command?" },
          source: { type: "tool", messageID: "msg_child", callID: "call_child" },
        },
      },
      {
        type: "permission.replied",
        properties: { sessionID: "ses_child", requestID: "per_child", reply: "once" },
      },
      { type: "session.status", properties: { sessionID: "ses_child", status: { type: "idle" } } },
      { type: "session.idle", properties: { sessionID: "ses_child" } },
    ]);
  });
});

describe("OpenCode v2 client compatibility", () => {
  test("Code Mode keeps the same child identities through progress, replay, and saved history", async () => {
    const state = createV2EventTranslationState();
    const data = { sessionID: "ses_code", assistantMessageID: "msg_code", id: "execute-code" };
    const toolCalls = [
      { tool: "openwork-cloud.search_capabilities", status: "completed", input: { query: "Slack" } },
      { tool: "openwork-cloud.execute_capability", status: "running", input: { name: "mcp:connection:list_channels" } },
    ];
    translateV2Event({ type: "session.tool.input.started", data: { ...data, name: "execute" } }, state);
    translateV2Event({ type: "session.tool.called", data: { ...data, input: { code: "recorded code" } } }, state);
    const progress = { type: "session.tool.progress", data: { ...data, metadata: { toolCalls } } };
    const expected = [{ type: "message.part.updated", properties: { part: {
      id: "execute-code", callID: "execute-code", tool: "execute", metadata: { openworkV2CodeMode: true },
      state: { status: "running", metadata: { toolCalls } },
    } } }];
    expect(translateV2Event(progress, state)).toMatchObject(expected);
    expect(translateV2Event(progress, state)).toMatchObject(expected);
    const completedCalls = toolCalls.map(call => ({ ...call, status: "completed" }));
    expect(translateV2Event({ type: "session.tool.success", data: {
      ...data, metadata: { toolCalls: completedCalls }, content: [{ type: "text", text: "Combined result" }],
    } }, state)).toMatchObject([{ properties: { part: { id: "execute-code", state: {
      output: "Combined result", metadata: { toolCalls: completedCalls },
    } } } }]);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => jsonResponse({ data: [{
      id: "msg_code", type: "assistant", time: { created: 1, completed: 2 },
      content: [{ id: "execute-code", type: "tool", name: "execute", time: { created: 1, completed: 2 }, state: {
        status: "completed", input: { code: "recorded code" }, metadata: { toolCalls: completedCalls },
        content: [{ type: "text", text: "Combined result" }],
      } }],
    }] });
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_code" });
      const saved = result.data?.[0]?.parts[0];
      if (saved?.type !== "tool") throw new Error("Missing saved execute part");
      const ui = parseDynamicToolUIPart(saved);
      if (!ui) throw new Error("Missing execute UI part");
      expect(codeModeToolCalls(ui)?.map(call => [call.toolCallId, call.toolName, call.state])).toEqual([
        ["execute-code:call:0", "openwork-cloud_search_capabilities", "output-available"],
        ["execute-code:call:1", "openwork-cloud_execute_capability", "output-available"],
      ]);
      expect(ui).toMatchObject({ output: "Combined result" });
    } finally { globalThis.fetch = originalFetch; }
  });
  test("maps only missing and empty native titles to stable read-time placeholders", async () => {
    const originalFetch = globalThis.fetch;
    const created = 1_788_548_737_221;
    const time = { created, updated: created + 100 };
    const sessions = [
      { id: "ses_missing", created },
      { id: "ses_empty", title: "", time },
      { id: "ses_literal", title: "Untitled session", time },
      { id: "ses_named", title: "Named session", time },
    ];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && request.url.endsWith("/api/session")) {
        return jsonResponse({ data: sessions });
      }
      const session = sessions.find((item) => request.url.endsWith(`/api/session/${item.id}`));
      if (request.method === "GET" && session) return jsonResponse({ data: session });
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.list();
      const placeholder = `New session - ${new Date(created).toISOString()}`;
      expect(result.data?.map((session) => session.title)).toEqual([
        placeholder, placeholder, "Untitled session", "Named session",
      ]);
      for (const session of result.data ?? []) {
        const fetched = await client.session.get({ sessionID: session.id });
        expect(fetched.data).toEqual(session);
      }
      expect(result.data?.[1]?.time).toEqual(time);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test.each([undefined, "", "Named session", "Untitled session"])("forwards only the provided title %j when creating a session", async (title) => {
    const originalFetch = globalThis.fetch;
    const bodies: unknown[] = [];
    const created = 1_788_548_737_221;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "POST" && request.url.endsWith("/api/session")) {
        bodies.push(await request.json());
        return jsonResponse({ data: { id: "ses_new", title, created } });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.create({ title });
      expect(bodies).toEqual([{
        location: { directory: "/workspace" },
        ...(title === undefined ? {} : { title }),
      }]);
      expect(result.data?.title).toBe(title || `New session - ${new Date(created).toISOString()}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retains native assistant errors even when a failed turn has text and a completion time", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && request.url.endsWith("/api/session/ses_failed/message")) {
        return jsonResponse({ data: [{
          id: "msg_failed",
          type: "assistant",
          time: { created: 10, completed: 20 },
          content: [{ type: "text", text: "Partial response" }],
          error: { type: "unknown", message: "provider unavailable" },
        }] });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_failed" });
      expect(result.data).toEqual([{
        info: {
          id: "msg_failed",
          sessionID: "ses_failed",
          role: "assistant",
          time: { created: 10, completed: 20 },
          error: { name: "UnknownError", data: { message: "provider unavailable" } },
        },
        parts: [{
          id: "msg_failed:0",
          messageID: "msg_failed",
          sessionID: "ses_failed",
          type: "text",
          text: "Partial response",
        }],
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps active v2 sessions to busy compatibility statuses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && request.url.endsWith("/api/session/active")) {
        return jsonResponse({ data: { ses_active: { type: "running" } } });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.status();

      expect(result.data).toEqual({ ses_active: { type: "busy" } });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("maps captured v2 message content and presents shell tool parts as bash", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && request.url.endsWith("/api/session/ses_tool/message")) {
        return jsonResponse({ data: [capturedV2ToolMessage] });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const result = await client.session.messages({ sessionID: "ses_tool" });

      expect(result.data).toEqual([{
        info: {
          id: "msg_06e0e76b900178zSuF55n4XEPY",
          sessionID: "ses_tool",
          role: "assistant",
          time: { created: 1_788_552_837_299, completed: 1_788_552_838_186 },
        },
        parts: [
          {
            id: "msg_06e0e76b900178zSuF55n4XEPY:0",
            messageID: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_tool",
            type: "text",
            text: "Running the shell.\n",
          },
          {
            id: "call_captured_shell",
            messageID: "msg_06e0e76b900178zSuF55n4XEPY",
            sessionID: "ses_tool",
            type: "tool",
            callID: "call_captured_shell",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "printf 'TOOL_RESULT_OK\\n'", timeout: 30_000 },
              output: "TOOL_RESULT_OK\n\nCommand exited with code 0.",
              title: "bash",
              metadata: { status: "completed", truncated: false, exit: 0 },
              time: { start: 1_788_552_838_052, end: 1_788_552_838_184 },
            },
          },
        ],
      }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns from promptAsync before a delayed prompt response", async () => {
    const originalFetch = globalThis.fetch;
    let promptSettled: Promise<void> = Promise.resolve();
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/model")) return jsonResponse({ data: {} });
      if (request.url.endsWith("/prompt")) {
        promptSettled = delay(2_000);
        await promptSettled;
        return jsonResponse({ data: {} });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const startedAt = performance.now();
      const result = await client.session.promptAsync({
        sessionID: "ses_prompt",
        model: { providerID: "witness", modelID: "model" },
        parts: [{ type: "text", text: "hello" }],
      });

      expect(performance.now() - startedAt).toBeLessThan(100);
      expect(result.response.status).toBe(202);
      await promptSettled;
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("workspace streams reject foreign and unscoped permission events", async () => {
    const originalFetch = globalThis.fetch;
    const events = [
      { ...capturedPermissionAsked, location: undefined, data: { ...capturedPermissionAsked.data, sessionID: "ses_unscoped" } },
      { ...capturedPermissionAsked, location: { directory: "/other" }, data: { ...capturedPermissionAsked.data, sessionID: "ses_foreign" } },
      capturedPermissionAsked,
    ];
    globalThis.fetch = async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "Content-Type": "text/event-stream" } },
    );
    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace/", {});
      const subscription = await client.event.subscribe();
      const next = await subscription.stream.next();
      expect(next.value).toMatchObject({ type: "permission.asked", properties: { sessionID: "ses_child" } });
      await subscription.stream.return(undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("emits session.error when the dispatched prompt fails", async () => {
    const originalFetch = globalThis.fetch;
    let eventController: ReadableStreamDefaultController<Uint8Array> | undefined;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.url.endsWith("/api/event")) {
        return new Response(new ReadableStream<Uint8Array>({
          start: (controller) => {
            eventController = controller;
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      }
      if (request.url.endsWith("/model")) return jsonResponse({ data: {} });
      if (request.url.endsWith("/prompt")) {
        await delay(10);
        return jsonResponse({ error: { message: "provider unavailable" } }, 500);
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const subscription = await client.event.subscribe();
      const nextEvent = subscription.stream.next();
      const result = await client.session.promptAsync({
        sessionID: "ses_failure",
        model: { providerID: "witness", modelID: "model" },
        parts: [{ type: "text", text: "hello" }],
      });
      expect(result.response.status).toBe(202);

      expect(await nextEvent).toEqual({
        done: false,
        value: {
          type: "session.error",
          properties: {
            sessionID: "ses_failure",
            error: { name: "UnknownError", data: { message: "provider unavailable" } },
          },
        },
      });
      eventController?.close();
      await subscription.stream.return(undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("lists and replies to captured v2 permission requests", async () => {
    const originalFetch = globalThis.fetch;
    const replyBodies: unknown[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (request.method === "GET" && request.url.endsWith("/api/session")) {
        return jsonResponse({ data: [{ id: "ses_child" }] });
      }
      if (request.method === "GET" && request.url.endsWith("/api/session/ses_child/permission")) {
        return jsonResponse({ data: [capturedPermissionAsked.data] });
      }
      if (request.method === "POST" && request.url.endsWith("/api/session/ses_child/permission/per_child/reply")) {
        replyBodies.push(await request.json());
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };

    try {
      const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
      const v2 = await client.v2.session.permission.list({ sessionID: "ses_child" });
      expect(v2.data).toEqual({
        data: [{
          id: "per_child",
          sessionID: "ses_child",
          action: "shell",
          resources: ["printf 'TOOL_RESULT_OK'"],
          save: ["printf *"],
          metadata: { message: "Allow this command?" },
          source: { type: "tool", messageID: "msg_child", callID: "call_child" },
        }],
      });

      const legacy = await client.permission.list();
      expect(legacy.data).toEqual([{
        id: "per_child",
        sessionID: "ses_child",
        permission: "shell",
        patterns: ["printf 'TOOL_RESULT_OK'"],
        metadata: { action: "shell", message: "Allow this command?" },
        always: ["printf *"],
        tool: { messageID: "msg_child", callID: "call_child" },
      }]);

      const legacyReply = await client.permission.reply({ requestID: "per_child", reply: "always" });
      expect(legacyReply.data).toBe(true);

      await client.v2.session.permission.list({ sessionID: "ses_child" });
      const reply = await client.v2.session.permission.reply({
        sessionID: "ses_child",
        requestID: "per_child",
        reply: "once",
      });
      expect(reply.error).toBeUndefined();
      expect(reply.response.status).toBe(204);
      expect(replyBodies).toEqual([{ reply: "always" }, { reply: "once" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


test("v2 provider catalog retains display names without exposing request settings", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.url.endsWith("/api/model")) return jsonResponse({ data: [{ id: "coding", providerID: "lpr_fixture", name: "Coding" }] });
    if (request.url.endsWith("/api/provider")) return jsonResponse({ data: [{ id: "lpr_fixture", name: "Assigned Coding", settings: { apiKey: "fixture-private" } }] });
    if (request.url.endsWith("/api/model/default")) return jsonResponse({ data: {} });
    throw new Error(`Unexpected request: ${request.url}`);
  };
  try {
    const client = createClientV2("http://opencode.test/opencode2", "/workspace", {});
    const result = await client.provider.list();
    expect(result.data?.all[0]?.name).toBe("Assigned Coding");
    expect(JSON.stringify(result.data)).not.toContain("fixture-private");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

describe("v2 question forms", () => {
  const form = {
    id: "frm_choice", sessionID: "ses_side", title: "Questions",
    metadata: { kind: "question", tool: { messageID: "msg_side", id: "call_question" } },
    fields: [
      { key: "q0", type: "string", title: "Format", description: "Which format?", custom: true,
        options: [{ label: "Summary", value: "summary_value", description: "A short overview" }] },
      { key: "q1", type: "multiselect", title: "Sections", description: "Which sections?", custom: true,
        options: [{ label: "Facts", value: "facts_value" }, { label: "Actions", value: "actions_value" }] },
    ],
  };

  test("maps pending, answered, and cancelled forms to the existing question UI protocol", () => {
    const state = createV2EventTranslationState();
    expect(translateV2Event({ type: "form.created", data: { form } }, state)).toEqual([{
      type: "question.asked", properties: {
        id: "frm_choice", sessionID: "ses_side", tool: { messageID: "msg_side", callID: "call_question" },
        questions: [
          { header: "Format", question: "Which format?", custom: true, multiple: false,
            options: [{ label: "Summary", description: "A short overview" }] },
          { header: "Sections", question: "Which sections?", custom: true, multiple: true,
            options: [{ label: "Facts", description: "" }, { label: "Actions", description: "" }] },
        ],
      },
    }]);
    expect(translateV2Event({ type: "form.created", data: { form: { ...form, metadata: { kind: "oauth" } } } }, state)).toBeNull();
    for (const [event, expected] of [["form.replied", "question.replied"], ["form.cancelled", "question.rejected"]]) {
      expect(translateV2Event({ type: event, data: { id: form.id, sessionID: form.sessionID } }, state)).toEqual([
        { type: expected, properties: { requestID: form.id, sessionID: form.sessionID } },
      ]);
    }
  });

  test("an interaction client can answer a live form it never listed, preserving values and custom text", async () => {
    const originalFetch = globalThis.fetch;
    const writes: { path: string; body: unknown }[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path.endsWith("/api/form/request")) return Response.json({ data: [form] });
      writes.push({ path, body: request.body ? await request.json() : null });
      return new Response(null, { status: 204 });
    };
    try {
      const client = createClientV2("http://owner.test/opencode2", "/workspace", {});
      expect((await client.question.reply({ requestID: form.id, answers: [["Summary"], ["Facts", "Custom section"]] })).data).toBe(true);
      expect(writes).toEqual([{ path: "/opencode2/api/session/ses_side/form/frm_choice/reply", body: {
        answer: { q0: "summary_value", q1: ["facts_value", "Custom section"] },
      } }]);
      expect((await client.question.reject({ requestID: form.id })).data).toBe(true);
      expect(writes.at(-1)?.path).toBe("/opencode2/api/session/ses_side/form/frm_choice/cancel");
    } finally { globalThis.fetch = originalFetch; }
  });

  test("failed list and reply requests remain failures and do not settle another question", async () => {
    const originalFetch = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      methods.push(request.method);
      return Response.json({ message: "Unavailable" }, { status: 503 });
    };
    try {
      const client = createClientV2("http://owner.test/opencode2", "/workspace", {});
      expect((await client.question.reply({ requestID: form.id, answers: [["Summary"]] })).response.status).toBe(503);
      expect(methods).toEqual(["GET"]);
      globalThis.fetch = async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        return request.method === "GET" ? Response.json({ data: [form] }) : Response.json({ message: "Try again" }, { status: 503 });
      };
      expect((await client.question.reply({ requestID: form.id, answers: [["Summary"]] })).response.status).toBe(503);
      expect((await client.question.list()).data?.map((item) => item.id)).toEqual([form.id]);
    } finally { globalThis.fetch = originalFetch; }
  });

  test("writes session context before prompting and fails closed if it cannot be written", async () => {
    const originalFetch = globalThis.fetch;
    const requests: { method: string; path: string; body: unknown }[] = [];
    let status = 204;
    globalThis.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      requests.push({ method: request.method, path, body: await request.json() });
      return path.includes("/instructions/") && status !== 204
        ? Response.json({ message: "Unavailable" }, { status }) : new Response(null, { status: 204 });
    };
    try {
      const client = createClientV2("http://owner.test/opencode2", "/workspace", {});
      const parameters = { sessionID: "ses_side", model: { providerID: "mock", modelID: "model" },
        system: "Main conversation reference: ses_main", parts: [{ type: "text", text: "What is happening?" }] };
      expect((await client.session.promptAsync(parameters)).response.status).toBe(202);
      expect(requests.map((item) => item.method)).toEqual(["POST", "PUT", "POST"]);
      expect(requests[1]).toMatchObject({ path: "/opencode2/api/session/ses_side/instructions/entries/openwork-context", body: { value: parameters.system } });
      expect(requests[2]?.body).toEqual({ text: "What is happening?" });
      requests.length = 0; status = 503;
      expect((await client.session.promptAsync(parameters)).response.status).toBe(503);
      expect(requests.map((item) => item.method)).toEqual(["POST", "PUT"]);
    } finally { globalThis.fetch = originalFetch; }
  });
});
