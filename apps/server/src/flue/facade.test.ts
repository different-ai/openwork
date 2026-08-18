import { describe, expect, test } from "bun:test";
import type { FlueObservation, PromptResponse } from "@flue/runtime";
import { engineEventSchema, sessionMessagesSchema, type EngineEvent, type MessageWithParts, type Part, type Provider } from "@openwork/engine-protocol";
import { applyObservedToolEvent, completeAssistantMessage, promptModelAvailabilityError } from "./facade.js";

function assistantMessage(): MessageWithParts {
  return {
    info: {
      id: "msg_assistant",
      sessionID: "ses_test",
      role: "assistant",
      time: { created: 1_000 },
      parentID: "msg_user",
      modelID: "initial-model",
      providerID: "initial-provider",
      mode: "build",
      agent: "openwork",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [{
      id: "prt_text",
      sessionID: "ses_test",
      messageID: "msg_assistant",
      type: "text",
      text: "",
      time: { start: 1_000 },
    }],
  };
}

function observation(event: {
  type: "tool_start";
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
} | {
  type: "tool";
  toolName: string;
  toolCallId: string;
  isError: boolean;
  result: unknown;
  durationMs: number;
}): FlueObservation {
  return {
    ...event,
    session: "ses_test",
    instanceId: "test",
    v: 3,
    eventIndex: 1,
    timestamp: "2026-07-29T00:00:00.000Z",
  };
}

function apply(message: MessageWithParts, event: FlueObservation, now: number, emitted: EngineEvent[]): void {
  if (event.type !== "tool_start" && event.type !== "tool") throw new Error("Expected tool observation");
  applyObservedToolEvent({
    message,
    event,
    sessionID: "ses_test",
    now,
    partId: () => "prt_tool",
    onUpdated: (part) => emitted.push(engineEventSchema.parse({
      id: `evt_${emitted.length}`,
      type: "message.part.updated",
      properties: { sessionID: "ses_test", part, time: now },
    })),
  });
}

function toolPart(message: MessageWithParts): Extract<Part, { type: "tool" }> {
  const part = message.parts.find((item) => item.type === "tool");
  if (!part || part.type !== "tool") throw new Error("Missing tool part");
  return part;
}

describe("Flue facade wire projections", () => {
  test("transitions tool_start to completed and emits the updated final part", () => {
    const message = assistantMessage();
    const emitted: EngineEvent[] = [];
    apply(message, observation({ type: "tool_start", toolName: "write", toolCallId: "call_1", args: { path: "response.txt" } }), 2_000, emitted);
    apply(message, observation({ type: "tool", toolName: "write", toolCallId: "call_1", isError: false, result: "written", durationMs: 25 }), 2_100, emitted);

    expect(toolPart(message).state).toEqual({
      status: "completed",
      input: { path: "response.txt" },
      output: "written",
      title: "write",
      metadata: {},
      time: { start: 2_000, end: 2_025 },
    });
    expect(emitted.at(-1)).toMatchObject({
      type: "message.part.updated",
      properties: { part: { type: "tool", state: { status: "completed", output: "written" } } },
    });
    expect(sessionMessagesSchema.parse([message])).toEqual([message]);
  });

  test("projects tool failures into the wire error state", () => {
    const message = assistantMessage();
    apply(message, observation({ type: "tool_start", toolName: "write", toolCallId: "call_1", args: {} }), 3_000, []);
    apply(message, observation({ type: "tool", toolName: "write", toolCallId: "call_1", isError: true, result: "permission denied", durationMs: 10 }), 3_100, []);
    expect(toolPart(message).state).toEqual({
      status: "error",
      input: {},
      error: "permission denied",
      time: { start: 3_000, end: 3_010 },
    });
    expect(sessionMessagesSchema.parse([message])).toEqual([message]);
  });

  test("creates a completed part for an orphan tool event", () => {
    const message = assistantMessage();
    apply(message, observation({ type: "tool", toolName: "read", toolCallId: "call_orphan", isError: false, result: { ok: true }, durationMs: 40 }), 4_000, []);
    expect(toolPart(message).state).toEqual({
      status: "completed",
      input: {},
      output: '{"ok":true}',
      title: "read",
      metadata: {},
      time: { start: 3_960, end: 4_000 },
    });
    expect(sessionMessagesSchema.parse([message])).toEqual([message]);
  });

  test("records the response model on a completed assistant message", () => {
    const response: PromptResponse = {
      text: "done",
      model: { provider: "openrouter", id: "openai/gpt-4o-mini" },
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const completed = completeAssistantMessage(assistantMessage(), response.text, 5_000, response);
    expect(completed.info).toMatchObject({ providerID: "openrouter", modelID: "openai/gpt-4o-mini" });
    expect(sessionMessagesSchema.parse([completed])).toEqual([completed]);
  });

  test("rejects a listed but unconnected provider with a credential error", () => {
    const provider: Provider = {
      id: "anthropic",
      name: "Anthropic",
      source: "config",
      env: ["ANTHROPIC_API_KEY"],
      options: {},
      models: {},
    };
    provider.models = {
      "claude-sonnet": {
        id: "claude-sonnet",
        providerID: "anthropic",
        api: { id: "anthropic-messages", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
        name: "Claude Sonnet",
        family: "anthropic",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 1_000, output: 100 },
        status: "active",
        options: {},
        headers: {},
        release_date: "2026-07-29",
      },
    };
    const error = promptModelAvailabilityError(
      { all: [provider], connected: [], default: {} },
      { providerID: "anthropic", modelID: "claude-sonnet" },
    );
    expect(error?.message).toBe("Provider anthropic has no credential");
  });
});
