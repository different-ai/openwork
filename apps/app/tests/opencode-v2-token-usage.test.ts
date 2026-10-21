import { describe, expect, test } from "bun:test";
import { createV2EventTranslationState, mapV2Message, mapV2Tokens, translateV2Event } from "../src/app/lib/opencode-v2-adapter";
import { useMeasuredUsageStore } from "../src/react-app/domains/session/sync/measured-usage-store";

// Payload shapes recorded from OpenCode 2.0.26 (GET /api/session/{id}/message and the /api/event stream).
const assistantMessage = {
  id: "msg_158ac17a8001aOW7bSqQHnhlBh",
  time: { created: 1792489035696, completed: 1792489036100 },
  type: "assistant",
  agent: "build",
  model: { id: "ctx-model", providerID: "fake" },
  content: [{ type: "text", text: "Fake reply for the context spike." }],
  finish: "stop",
  rawFinish: "stop",
  cost: 0,
  tokens: { input: 5596, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
};

const stepEnded = {
  id: "evt_158ae0df0002CzRsPsyD1p3isS",
  created: 1792489164272,
  type: "session.step.ended",
  location: { directory: "/work" },
  data: {
    sessionID: "ses_ea75282fcffeagsVuVcDcPdx1D",
    assistantMessageID: "msg_158ae0dda001i5FnA72ev4e2r4",
    finish: "stop",
    rawFinish: "stop",
    cost: 0,
    tokens: { input: 5818, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  durable: { aggregateID: "ses_ea75282fcffeagsVuVcDcPdx1D", seq: 30, version: 1 },
};

describe("mapV2Tokens", () => {
  test("maps the usage block and defaults the optional fields", () => {
    expect(mapV2Tokens({ tokens: { input: 10, output: 2 } })).toEqual({ input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } });
    expect(mapV2Tokens({ tokens: { total: 15, input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } }))
      .toEqual({ total: 15, input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 5 } });
  });

  test("yields nothing for a missing or malformed block", () => {
    expect(mapV2Tokens({})).toBeUndefined();
    expect(mapV2Tokens({ tokens: "many" })).toBeUndefined();
    expect(mapV2Tokens({ tokens: { input: 10 } })).toBeUndefined();
    expect(mapV2Tokens({ tokens: { input: Number.NaN, output: 2 } })).toBeUndefined();
  });
});

describe("mapV2Message usage", () => {
  test("keeps the provider-reported tokens of an assistant message", () => {
    const mapped = mapV2Message(assistantMessage, "ses_1");
    expect(mapped?.info.role).toBe("assistant");
    expect(mapped?.info.tokens).toEqual({ input: 5596, output: 12, reasoning: 0, cache: { read: 0, write: 0 } });
  });

  test("does not copy finish or cost, which other code reads with v1 meaning", () => {
    const info = mapV2Message(assistantMessage, "ses_1")?.info;
    expect(info).toBeDefined();
    expect("finish" in (info ?? {})).toBe(false);
    expect("cost" in (info ?? {})).toBe(false);
  });

  test("gives a user message no tokens", () => {
    const mapped = mapV2Message({ id: "msg_u", time: { created: 1 }, type: "user", text: "hello", tokens: assistantMessage.tokens }, "ses_1");
    expect(mapped?.info.role).toBe("user");
    expect(mapped?.info.tokens).toBeUndefined();
  });

  test("leaves an assistant message without usage as before", () => {
    const { tokens: _tokens, ...bare } = assistantMessage;
    expect(mapV2Message(bare, "ses_1")?.info.tokens).toBeUndefined();
  });
});

describe("session.step.ended", () => {
  test("becomes a usage event of its own, not a message update", () => {
    const events = translateV2Event(stepEnded, createV2EventTranslationState());
    expect(events).toEqual([{
      type: "session.usage.measured",
      properties: {
        sessionID: "ses_ea75282fcffeagsVuVcDcPdx1D",
        messageID: "msg_158ae0dda001i5FnA72ev4e2r4",
        tokens: { input: 5818, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    }]);
  });

  test("accepts the session.next spelling of the typings", () => {
    const events = translateV2Event({ ...stepEnded, type: "session.next.step.ended" }, createV2EventTranslationState());
    expect(events?.[0]?.type).toBe("session.usage.measured");
  });

  test("ignores a step without usage or message id", () => {
    const { tokens: _tokens, ...withoutTokens } = stepEnded.data;
    expect(translateV2Event({ ...stepEnded, data: withoutTokens }, createV2EventTranslationState())).toBeNull();
    const { assistantMessageID: _id, ...withoutMessage } = stepEnded.data;
    expect(translateV2Event({ ...stepEnded, data: withoutMessage }, createV2EventTranslationState())).toBeNull();
  });
});

describe("measured usage store", () => {
  const usage = (messageId: string, input: number) => ({ messageId, tokens: { input, output: 12, reasoning: 0, cache: { read: 0, write: 0 } } });

  test("keeps the latest measurement per session", () => {
    const store = useMeasuredUsageStore;
    store.getState().clear("w", "s");
    store.getState().record("w", "s", usage("a1", 5596));
    store.getState().record("w", "s", usage("a2", 5789));
    store.getState().record("w", "other", usage("b1", 1));
    const bySession = store.getState().bySession;
    expect(bySession[JSON.stringify(["w", "s"])]?.messageId).toBe("a2");
    expect(bySession[JSON.stringify(["w", "other"])]?.messageId).toBe("b1");
    store.getState().clear("w", "s");
    store.getState().clear("w", "other");
    expect(Object.keys(store.getState().bySession)).toEqual([]);
  });

  test("ignores a message that still reports zeros", () => {
    const store = useMeasuredUsageStore;
    store.getState().record("w", "s", usage("a1", 5596));
    store.getState().record("w", "s", { messageId: "a2", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
    expect(store.getState().bySession[JSON.stringify(["w", "s"])]?.messageId).toBe("a1");
    store.getState().clear("w", "s");
  });
});
