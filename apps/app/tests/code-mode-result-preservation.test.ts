import { expect, test } from "bun:test";
import { createV2EventTranslationState, translateV2Event } from "../src/app/lib/opencode-v2-adapter";
import { codeModeToolCalls } from "../src/lib/code-mode-tools";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";

const data = { sessionID: "session-code", assistantMessageID: "message-code", id: "execute-code" };
const calls = [
  { tool: "service.search", input: { query: "first" }, status: "completed" },
  { tool: "service.search", input: { query: "second" }, status: "completed" },
];
const details = calls.map((call, ordinal) => ({
  ...call, tool: "service_search", ordinal, invocationId: `${data.id}:${ordinal}`,
  startedAt: 1_000 + ordinal, endedAt: 2_000 + ordinal, output: { rows: [ordinal] },
}));

function openExecution() {
  const state = createV2EventTranslationState();
  translateV2Event({ type: "session.tool.input.started", data: { ...data, name: "execute" } }, state);
  translateV2Event({ type: "session.tool.called", data: { ...data, input: { code: "recorded code" } } }, state);
  return state;
}

function translatedPart(events: ReturnType<typeof translateV2Event>) {
  const part = events?.find(event => event.type === "message.part.updated")?.properties.part;
  if (!part || part.type !== "tool") throw new Error("Expected the translated execution part");
  return part;
}

test("native call updates retain enriched results through partial and stale progress", () => {
  const state = openExecution();
  translateV2Event({ type: "session.tool.progress", data: { ...data, metadata: {
    toolCalls: calls, openworkToolDetails: details,
  } } }, state);
  const part = translatedPart(translateV2Event({ type: "session.tool.progress", data: { ...data, metadata: {
    toolCalls: [{ ...calls[0], status: "running" }],
    openworkToolDetails: [{ ...details[0], status: "running", output: undefined }],
  } } }, state));
  expect(part.state).toMatchObject({ metadata: { toolCalls: calls, openworkToolDetails: details } });
  const completed = translatedPart(translateV2Event({ type: "session.tool.success", data: {
    ...data, metadata: { toolCalls: calls }, content: [{ type: "text", text: "Combined answer" }],
  } }, state));
  expect(completed.state).toMatchObject({ output: "Combined answer", metadata: { toolCalls: calls, openworkToolDetails: details } });
});

test("live and restored Code Mode parts project the same invocation results", () => {
  const state = openExecution();
  const part = translatedPart(translateV2Event({ type: "session.tool.success", data: {
    ...data, metadata: { toolCalls: calls, openworkToolDetails: details },
    content: [{ type: "text", text: "Combined answer" }],
  } }, state));
  const live = parseDynamicToolUIPart(part);
  if (!live) throw new Error("Expected the Code Mode UI part");
  const history = snapshotToUIMessages({ messages: [{
    info: { id: data.assistantMessageID, role: "assistant", sessionID: data.sessionID,
      time: { created: 1_000, completed: 2_000 }, parentID: "prompt", modelID: "fixture", providerID: "fixture",
      mode: "fixture", path: { cwd: "/fixture", root: "/fixture" }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    parts: [part],
  }] });
  expect(history[0]?.parts[0]).toEqual(live);
  const projected = codeModeToolCalls(live);
  expect(projected?.map(call => call.toolCallId)).toEqual(["execute-code:call:0", "execute-code:call:1"]);
  expect(projected?.map(call => call.state === "output-available" ? call.output : undefined)).toEqual([{ rows: [0] }, { rows: [1] }]);
  expect(projected?.[0]?.callProviderMetadata?.openwork).toMatchObject({ toolStartedAt: 1_000, toolEndedAt: 2_000 });
});

test("ambiguous and wrong-parent detail stays unavailable instead of crossing invocations", () => {
  for (const retained of [
    [{ ...details[0], invocationId: "another-execution:0" }],
    [details[0], { ...details[0], output: "wrong duplicate" }],
  ]) {
    const part = translatedPart(translateV2Event({ type: "session.tool.progress", data: { ...data, metadata: {
      toolCalls: calls, openworkToolDetails: retained,
    } } }, openExecution()));
    const ui = parseDynamicToolUIPart(part);
    if (!ui) throw new Error("Expected Code Mode part");
    const call = codeModeToolCalls(ui)?.[0];
    expect(call).toMatchObject({ state: "output-available", output: undefined });
  }
});

test("failed and truncated inner calls keep their recorded outcome", () => {
  const part = translatedPart(translateV2Event({ type: "session.tool.success", data: {
    ...data, metadata: {
      toolCalls: [{ ...calls[0], status: "error" }],
      openworkToolDetails: [{ tool: "service_search", ordinal: 0, invocationId: `${data.id}:0`,
        startedAt: 1_000, endedAt: 2_000, status: "error", error: "Fixture access expired", truncated: true }],
      openworkToolDetailsTruncated: true,
    }, content: [{ type: "text", text: "Script finished" }],
  } }, openExecution()));
  const ui = parseDynamicToolUIPart(part);
  if (!ui) throw new Error("Expected Code Mode part");
  expect(ui.callProviderMetadata?.openwork?.codeMode).toMatchObject({ detailsTruncated: true });
  expect(codeModeToolCalls(ui)?.[0]).toMatchObject({ state: "output-error", errorText: "Fixture access expired",
    callProviderMetadata: { openwork: { resultTruncated: true } } });
});
