import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";

function snapshotWithText(text: string): OpenworkSessionSnapshot {
  return {
    session: {
      id: "ses_test",
      parentID: undefined,
      title: "Test session",
      time: { created: 1, updated: 2 },
      share: undefined,
      version: "0",
    },
    messages: [
      {
        info: {
          id: "msg_user",
          role: "user",
          sessionID: "ses_test",
          time: { created: 1 },
        },
        parts: [
          {
            id: "part_text",
            type: "text",
            text,
            sessionID: "ses_test",
            messageID: "msg_user",
          },
        ],
      },
    ],
    todos: [],
    status: { type: "idle" },
  } as unknown as OpenworkSessionSnapshot;
}

describe("deriveRenderedSessionMessages", () => {
  it("falls back to snapshot messages when transcript cache is empty", () => {
    const messages = deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot: snapshotWithText("still here"),
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts[0]).toMatchObject({
      type: "text",
      text: "still here",
    });
  });

  it("keeps live transcript cache when present", () => {
    const cached: UIMessage[] = [
      {
        id: "msg_live",
        role: "assistant",
        parts: [{ type: "text", text: "live text", state: "done" }],
      },
    ];

    expect(deriveRenderedSessionMessages({
      transcriptState: cached,
      snapshot: snapshotWithText("snapshot text"),
    })).toBe(cached);
  });

  it("returns an empty list only when there is no cache or snapshot content", () => {
    expect(deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot: null,
    })).toEqual([]);
  });
});
