import { describe, expect, it } from "bun:test";
import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import {
  deriveRenderedSessionMessages,
  resolveRenderedSessionSnapshot,
} from "../src/react-app/domains/session/surface/session-render-state";
import {
  applyRevertCursor,
  reconcileTranscriptMessages,
  resolveForkBoundaryId,
} from "../src/react-app/domains/session/sync/transcript-reconcile";
import { describeOpencodeSessionError } from "../src/react-app/domains/session/sync/usechat-adapter";

function snapshotWithMessages(
  messages: Array<{ id: string; role: "user" | "assistant"; text: string; created?: number }>,
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
        time: { created: message.created ?? index + 1 },
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

function uiMessage(id: string, role: "user" | "assistant", text: string, created?: number): UIMessage {
  return {
    id,
    role,
    ...(typeof created === "number" ? { metadata: { opencode: { created } } } : {}),
    parts: [{ type: "text", text, state: "done" }],
  };
}

function snapshotWithText(text: string, sessionId = "ses_test"): OpenworkSessionSnapshot {
  return snapshotWithMessages([{ id: "msg_user", role: "user", text }], sessionId);
}

describe("reconcileTranscriptMessages", () => {
  it("hydrates an empty transcript cache from the snapshot", () => {
    const snapshot = [uiMessage("msg_user", "user", "hello")];

    expect(reconcileTranscriptMessages({
      currentMessages: [],
      snapshotMessages: snapshot,
      reason: "snapshot",
    })).toBe(snapshot);
  });

  it("does not clear live messages when a snapshot is temporarily empty", () => {
    const current = [
      uiMessage("msg_user", "user", "latest prompt"),
      uiMessage("msg_assistant", "assistant", "latest answer"),
    ];

    expect(reconcileTranscriptMessages({
      currentMessages: current,
      snapshotMessages: [],
      reason: "snapshot",
    })).toBe(current);
  });

  it("keeps older cached messages when a busy snapshot only contains the active tail", () => {
    const merged = reconcileTranscriptMessages({
      snapshotMessages: [uiMessage("msg_current_user", "user", "latest prompt")],
      currentMessages: [
        uiMessage("msg_old_user", "user", "old prompt"),
        uiMessage("msg_old_assistant", "assistant", "old answer"),
        uiMessage("msg_current_user", "user", "latest"),
      ],
      reason: "snapshot",
    });

    expect(merged.map((message) => message.id)).toEqual([
      "msg_old_user",
      "msg_old_assistant",
      "msg_current_user",
    ]);
    expect(merged[2]?.parts[0]).toMatchObject({ text: "latest prompt" });
  });

  it("keeps snapshot history and live-only tail messages together", () => {
    const merged = reconcileTranscriptMessages({
      currentMessages: [
        uiMessage("msg_current_user", "user", "latest prompt"),
        uiMessage("msg_current_assistant", "assistant", "streaming answer"),
      ],
      snapshotMessages: [
        uiMessage("msg_old_user", "user", "old prompt"),
        uiMessage("msg_old_assistant", "assistant", "old answer"),
      ],
      reason: "snapshot",
    });

    expect(merged.map((message) => message.id)).toEqual([
      "msg_old_user",
      "msg_old_assistant",
      "msg_current_user",
      "msg_current_assistant",
    ]);
  });

  it("keeps longer live text when the snapshot lags the event stream", () => {
    const merged = reconcileTranscriptMessages({
      currentMessages: [
        uiMessage("msg_user", "user", "hello"),
        uiMessage("msg_assistant", "assistant", "finished answer"),
      ],
      snapshotMessages: [
        uiMessage("msg_user", "user", "hello"),
        uiMessage("msg_assistant", "assistant", "finished"),
      ],
      reason: "snapshot",
    });

    expect(merged[1]?.parts[0]).toMatchObject({ text: "finished answer" });
  });

  it("inserts cached-only message blocks by timestamp instead of appending them", () => {
    const merged = reconcileTranscriptMessages({
      currentMessages: [
        uiMessage("msg_block1", "user", "block 1", 1),
        uiMessage("msg_block2", "assistant", "block 2", 2),
        uiMessage("msg_block3", "user", "block 3", 3),
        uiMessage("msg_block4", "assistant", "block 4", 4),
        uiMessage("msg_streaming", "assistant", "streaming", 5),
      ],
      snapshotMessages: [
        uiMessage("msg_block1", "user", "block 1", 1),
        uiMessage("msg_block3", "user", "block 3", 3),
        uiMessage("msg_block4", "assistant", "block 4", 4),
      ],
      reason: "snapshot",
    });

    expect(merged.map((message) => message.id)).toEqual([
      "msg_block1",
      "msg_block2",
      "msg_block3",
      "msg_block4",
      "msg_streaming",
    ]);
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

  it("keeps longer live text when the cache covers the snapshot", () => {
    const cached: UIMessage[] = [
      uiMessage("msg_user", "user", "snapshot text plus live tail", 1),
    ];

    const messages = deriveRenderedSessionMessages({
      transcriptState: cached,
      snapshot: snapshotWithText("snapshot text"),
    });

    expect(messages[0]?.parts[0]).toMatchObject({ text: "snapshot text plus live tail" });
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
    });

    expect(messages.map((message) => message.id)).toEqual([
      "msg_old_user",
      "msg_old_assistant",
      "msg_current_user",
      "msg_current_assistant",
    ]);
  });

  it("keeps live-only tail messages after the stream flips idle before the snapshot catches up", () => {
    const messages = deriveRenderedSessionMessages({
      transcriptState: [
        uiMessage("msg_current_user", "user", "latest prompt"),
        uiMessage("msg_current_assistant", "assistant", "latest answer"),
      ],
      snapshot: snapshotWithMessages([
        { id: "msg_old_user", role: "user", text: "old prompt" },
        { id: "msg_old_assistant", role: "assistant", text: "old answer" },
      ]),
    });

    expect(messages.map((message) => message.id)).toEqual([
      "msg_old_user",
      "msg_old_assistant",
      "msg_current_user",
      "msg_current_assistant",
    ]);
  });

  it("renders cached-only message blocks by timestamp instead of appending them", () => {
    const messages = deriveRenderedSessionMessages({
      transcriptState: [
        uiMessage("msg_block1", "user", "block 1", 1),
        uiMessage("msg_block2", "assistant", "block 2", 2),
        uiMessage("msg_block3", "user", "block 3", 3),
        uiMessage("msg_block4", "assistant", "block 4", 4),
        uiMessage("msg_streaming", "assistant", "streaming", 5),
      ],
      snapshot: snapshotWithMessages([
        { id: "msg_block1", role: "user", text: "block 1", created: 1 },
        { id: "msg_block3", role: "user", text: "block 3", created: 3 },
        { id: "msg_block4", role: "assistant", text: "block 4", created: 4 },
      ]),
    });

    expect(messages.map((message) => message.id)).toEqual([
      "msg_block1",
      "msg_block2",
      "msg_block3",
      "msg_block4",
      "msg_streaming",
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

describe("describeOpencodeSessionError", () => {
  it("includes API error status and response details", () => {
    expect(describeOpencodeSessionError({
      name: "APIError",
      data: {
        message: "Service unavailable",
        statusCode: 503,
        isRetryable: true,
        responseBody: "upstream overloaded",
      },
    })).toBe("Service unavailable\nStatus: 503\nResponse: upstream overloaded");
  });

  it("uses named error defaults when opencode omits a message", () => {
    expect(describeOpencodeSessionError({
      name: "MessageOutputLengthError",
      data: {},
    })).toBe("The model reached its output limit before finishing");
  });

  it("surfaces structured output retry counts", () => {
    expect(describeOpencodeSessionError({
      name: "StructuredOutputError",
      data: {
        message: "Invalid JSON",
        retries: 3,
      },
    })).toBe("Invalid JSON\nRetries: 3");
  });
});

describe("applyRevertCursor", () => {
  const transcript = [
    uiMessage("msg_1", "user", "turn one"),
    uiMessage("msg_2", "assistant", "answer one"),
    uiMessage("msg_3", "user", "turn two"),
    uiMessage("msg_4", "assistant", "answer two"),
  ];

  it("hides the reverted message itself and everything after it", () => {
    // OpenCode marks revert.messageID as the FIRST reverted message.
    const result = applyRevertCursor(transcript, "msg_3");
    expect(result.map((message) => message.id)).toEqual(["msg_1", "msg_2"]);
  });

  it("returns the transcript unchanged without a revert cursor", () => {
    expect(applyRevertCursor(transcript, null)).toBe(transcript);
    expect(applyRevertCursor(transcript, undefined)).toBe(transcript);
  });

  it("returns the transcript unchanged when the cursor id is unknown", () => {
    expect(applyRevertCursor(transcript, "msg_missing")).toBe(transcript);
  });

  it("hides everything when the first message is reverted", () => {
    expect(applyRevertCursor(transcript, "msg_1")).toEqual([]);
  });
});

describe("deriveRenderedSessionMessages with revert", () => {
  it("hides reverted messages from the rendered transcript", () => {
    const snapshot = snapshotWithMessages([
      { id: "msg_1", role: "user", text: "turn one" },
      { id: "msg_2", role: "assistant", text: "answer one" },
      { id: "msg_3", role: "user", text: "turn two" },
      { id: "msg_4", role: "assistant", text: "answer two" },
    ]);
    (snapshot.session as { revert?: { messageID: string } }).revert = { messageID: "msg_3" };

    const rendered = deriveRenderedSessionMessages({
      transcriptState: [],
      snapshot,
    });

    expect(rendered.map((message) => message.id)).toEqual(["msg_1", "msg_2"]);
  });
});

describe("resolveForkBoundaryId", () => {
  const transcript = [
    uiMessage("msg_1", "user", "turn one"),
    uiMessage("msg_2", "assistant", "answer one"),
    uiMessage("msg_3", "user", "turn two"),
    uiMessage("msg_4", "assistant", "answer two"),
  ];

  it("returns the next message so the fork includes the branch point", () => {
    expect(resolveForkBoundaryId(transcript, "msg_2")).toBe("msg_3");
    expect(resolveForkBoundaryId(transcript, "msg_3")).toBe("msg_4");
  });

  it("returns null when branching at the last message (fork everything)", () => {
    expect(resolveForkBoundaryId(transcript, "msg_4")).toBeNull();
  });

  it("returns null for unknown ids instead of corrupting the boundary", () => {
    expect(resolveForkBoundaryId(transcript, "msg_missing")).toBeNull();
  });

  it("skips synthetic session-error messages when picking the boundary", () => {
    const withSynthetic = [
      ...transcript.slice(0, 2),
      uiMessage("session-error:msg_2", "assistant", "boom"),
      ...transcript.slice(2),
    ];
    expect(resolveForkBoundaryId(withSynthetic, "msg_2")).toBe("msg_3");
    // Branching at the synthetic message itself falls through to the next real message.
    expect(resolveForkBoundaryId(withSynthetic, "session-error:msg_2")).toBe("msg_3");
  });
});
