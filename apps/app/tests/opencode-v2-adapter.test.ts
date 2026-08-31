import { describe, expect, test } from "bun:test";

import {
  createV2EventTranslationState,
  translateV2Event,
} from "../src/app/lib/opencode-v2-adapter";

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
});
