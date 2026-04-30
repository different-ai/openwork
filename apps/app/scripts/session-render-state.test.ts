import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import {
  deriveRenderedSessionMessages,
  resolveRenderedSessionSnapshot,
} from "../src/react-app/domains/session/surface/session-render-state";
import { mergeSnapshotIntoCachedMessages } from "../src/react-app/domains/session/sync/message-merge";

function snapshotWithMessages(
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>,
  sessionId = "ses_test",
): OpenworkSessionSnapshot {
  return {
    session: {
      id: sessionId,
      parentID: undefined,
      title: "Test session",
      time: { created: 1, updated: 2 },
      share: undefined,
      version: "0",
    },
    messages: messages.map((message, index) => ({
      info: {
        id: message.id,
        role: message.role,
        sessionID: sessionId,
        time: { created: index + 1 },
      },
      parts: [
        {
          id: `part_${message.id}`,
          type: "text",
          text: message.text,
          sessionID: sessionId,
          messageID: message.id,
        },
      ],
    })),
    todos: [],
    status: { type: "idle" },
  } as unknown as OpenworkSessionSnapshot;
}

function uiMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text, state: "done" }],
  };
}

function snapshotWithText(text: string, sessionId = "ses_test"): OpenworkSessionSnapshot {
  return snapshotWithMessages([{ id: "msg_user", role: "user", text }], sessionId);
}

describe("mergeSnapshotIntoCachedMessages", () => {
  it("keeps older cached messages when a busy snapshot only contains the active tail", () => {
    const merged = mergeSnapshotIntoCachedMessages(
      [uiMessage("msg_current_user", "user", "latest prompt")],
      [
        uiMessage("msg_old_user", "user", "old prompt"),
        uiMessage("msg_old_assistant", "assistant", "old answer"),
        uiMessage("msg_current_user", "user", "latest"),
      ],
    );

    expect(merged.map((message) => message.id)).toEqual([
      "msg_old_user",
      "msg_old_assistant",
      "msg_current_user",
    ]);
    expect(merged[2]?.parts[0]).toMatchObject({ text: "latest prompt" });
  });
});

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

  it("keeps live transcript cache when it covers the snapshot", () => {
    const cached: UIMessage[] = [
      {
        id: "msg_user",
        role: "assistant",
        parts: [{ type: "text", text: "live text", state: "done" }],
      },
    ];

    expect(deriveRenderedSessionMessages({
      transcriptState: cached,
      snapshot: snapshotWithText("snapshot text"),
    })).toBe(cached);
  });

  it("keeps snapshot history visible when the live cache only has the active turn", () => {
    const messages = deriveRenderedSessionMessages({
      transcriptState: [
        {
          id: "msg_current_user",
          role: "user",
          parts: [{ type: "text", text: "latest prompt", state: "done" }],
        },
        {
          id: "msg_current_assistant",
          role: "assistant",
          parts: [{ type: "text", text: "streaming answer", state: "streaming" }],
        },
      ],
      snapshot: snapshotWithMessages([
        { id: "msg_old_user", role: "user", text: "old prompt" },
        { id: "msg_old_assistant", role: "assistant", text: "old answer" },
      ]),
      includeLiveOnlyMessages: true,
    });

    expect(messages.map((message) => message.id)).toEqual([
      "msg_old_user",
      "msg_old_assistant",
      "msg_current_user",
      "msg_current_assistant",
    ]);
  });

  it("returns an empty list only when there is no cache or snapshot content", () => {
    expect(deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot: null,
    })).toEqual([]);
  });

  it("does not use a cached snapshot from a different session", () => {
    const snapshot = resolveRenderedSessionSnapshot({
      sessionId: "ses_next",
      currentSnapshot: null,
      cachedRendered: {
        sessionId: "ses_previous",
        snapshot: snapshotWithText("previous session", "ses_previous"),
      },
    });

    expect(snapshot).toBeNull();
    expect(deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot,
    })).toEqual([]);
  });

  it("keeps a cached snapshot for the current session while live cache is empty", () => {
    const cached = snapshotWithText("current session", "ses_current");
    const snapshot = resolveRenderedSessionSnapshot({
      sessionId: "ses_current",
      currentSnapshot: null,
      cachedRendered: {
        sessionId: "ses_current",
        snapshot: cached,
      },
    });

    expect(snapshot).toBe(cached);
    expect(deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot,
    })[0]?.parts[0]).toMatchObject({ text: "current session" });
  });
});
