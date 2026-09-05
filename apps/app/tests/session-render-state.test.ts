import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";

function snapshotWithHistory(): OpenworkSessionSnapshot {
  const sessionId = "session-render-cycle";
  return {
    session: {
      id: sessionId,
      title: "Render-cycle history",
      time: { created: 1, updated: 2 },
      version: "0",
    },
    messages: [
      { id: "historical-user", role: "user", text: "First prompt" },
      { id: "historical-assistant", role: "assistant", text: "First answer" },
    ].map((message, index) => ({
      info: {
        id: message.id,
        role: message.role,
        sessionID: sessionId,
        time: { created: index + 1 },
      },
      parts: [{
        id: `part-${message.id}`,
        type: "text",
        text: message.text,
        sessionID: sessionId,
        messageID: message.id,
      }],
    })),
    todos: [],
    status: { type: "idle" },
  } as unknown as OpenworkSessionSnapshot;
}

function message(id: string, role: "user" | "assistant", text: string, created: number): UIMessage {
  return {
    id,
    role,
    metadata: { opencode: { created } },
    parts: [{ type: "text", text, state: "done" }],
  };
}

describe("session render state", () => {
  test("preserves completed message references while the active answer advances", () => {
    const snapshot = snapshotWithHistory();
    const historicalUser = message("historical-user", "user", "First prompt", 1);
    const historicalAssistant = message("historical-assistant", "assistant", "First answer", 2);
    const activeUser = message("active-user", "user", "Second prompt", 3);
    const first = deriveRenderedSessionMessages({
      snapshot,
      transcriptState: [
        historicalUser,
        historicalAssistant,
        activeUser,
        message("active-assistant", "assistant", "chunk-1 ", 4),
      ],
    });
    const second = deriveRenderedSessionMessages({
      snapshot: snapshotWithHistory(),
      transcriptState: [
        ...first.slice(0, 3),
        message("active-assistant", "assistant", "chunk-1 chunk-2 ", 4),
      ],
    });

    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
    expect(second[3]).not.toBe(first[3]);
    expect(second[3]?.parts).toEqual([{ type: "text", text: "chunk-1 chunk-2 ", state: "done" }]);
  });
});
