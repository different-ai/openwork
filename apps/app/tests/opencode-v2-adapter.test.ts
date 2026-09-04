import { describe, expect, test } from "bun:test";

import {
  createClientV2,
  createV2EventTranslationState,
  translateV2Event,
} from "../src/app/lib/opencode-v2-adapter";

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

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenCode v2 event translation", () => {
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
