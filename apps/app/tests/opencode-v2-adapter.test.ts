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
