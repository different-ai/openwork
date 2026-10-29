import { expect, test } from "bun:test"
import type { DynamicToolUIPart, UIMessage } from "ai"
import { getAssistantRenderGroups } from "../src/components/chat/utils"
import { reasoningProviderMetadata } from "../src/lib/reasoning-timing"
import { getToolCallStartedAt, trackToolCallDuration } from "../src/lib/tool-call-duration"

function tool(callId: string, state: DynamicToolUIPart["state"], openwork: Record<string, unknown>) {
  return {
    type: "dynamic-tool", toolName: "read", toolCallId: callId, state, input: {},
    ...(state === "output-available" ? { output: "" } : {}), callProviderMetadata: { openwork },
  } as unknown as DynamicToolUIPart
}

test("a finished tool shows the duration the engine recorded", () => {
  expect(trackToolCallDuration(tool("native", "output-available", { toolStartedAt: 1_000, toolCompletedAt: 3_500 }))).toBe("2.5s")
})

test("a tool from old history without native timing shows no duration", () => {
  expect(trackToolCallDuration(tool("old-finished", "output-available", { timingUnavailable: true }))).toBeNull()
  expect(getToolCallStartedAt(tool("old-running", "input-available", { timingUnavailable: true }))).toBeNull()
})

test("reasoning keeps its native start and end, and shows as thinking before any text", () => {
  expect(reasoningProviderMetadata({ id: "r1", time: { start: 1_000, end: 4_000 } })).toEqual({ opencode: { partId: "r1", startedAt: 1_000, endedAt: 4_000 } })
  const reasoning = (metadata: ReturnType<typeof reasoningProviderMetadata>, text: string): UIMessage["parts"] =>
    [{ type: "reasoning", text, state: "done", providerMetadata: metadata }]
  const thinking = getAssistantRenderGroups(reasoning(reasoningProviderMetadata({ id: "r1", time: { start: 1_000 } }), ""), true)
  expect(thinking).toEqual([expect.objectContaining({ kind: "reasoning", isStreaming: true, startedAt: 1_000 })])
  const done = getAssistantRenderGroups(reasoning(reasoningProviderMetadata({ id: "r1", time: { start: 1_000, end: 4_000 } }), "Checked the file."), true)
  expect(done).toEqual([expect.objectContaining({ kind: "reasoning", isStreaming: false, startedAt: 1_000, endedAt: 4_000 })])
})
