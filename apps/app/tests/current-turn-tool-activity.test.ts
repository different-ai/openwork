import { expect, test } from "bun:test";

import { collectLatestAssistantToolParts } from "../src/lib/latest-assistant-tool-parts";

type MessageHistory = Parameters<typeof collectLatestAssistantToolParts>[0];

const staleHistory: MessageHistory = [
  {
    id: "user-old",
    role: "user",
    parts: [{ type: "text", text: "Run the old action" }],
  },
  {
    id: "assistant-old",
    role: "assistant",
    parts: [{
      type: "dynamic-tool",
      toolName: "openwork_execute",
      toolCallId: "old-call",
      state: "input-streaming",
      input: {},
    }],
  },
  {
    id: "assistant-replacement",
    role: "assistant",
    parts: [{ type: "text", text: "The replacement run is responding" }],
  },
];

const newTurnWithoutAssistant: MessageHistory = [
  ...staleHistory.slice(0, 2),
  {
    id: "user-current",
    role: "user",
    parts: [{ type: "text", text: "Start a new turn" }],
  },
];

test("live activity ignores unfinished tools from earlier turns", () => {
  expect(collectLatestAssistantToolParts(staleHistory)).toEqual([]);
  expect(collectLatestAssistantToolParts(newTurnWithoutAssistant)).toEqual([]);

  const currentHistory: MessageHistory = [
    ...newTurnWithoutAssistant,
    {
      id: "assistant-current",
      role: "assistant",
      parts: [{
        type: "dynamic-tool",
        toolName: "read",
        toolCallId: "current-call",
        state: "input-streaming",
        input: { filePath: "/workspace/current.txt" },
      }],
    },
  ];

  expect(collectLatestAssistantToolParts(currentHistory).map((part) => part.toolCallId)).toEqual(["current-call"]);
});
