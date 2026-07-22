import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import {
  buildContextTranscriptUsage,
  buildContextUsage,
  estimateTextTokens,
  getLatestReportedContextTokens,
  getSelectedModelContextLimit,
} from "../src/react-app/domains/session/surface/context-usage";

function snapshot(messages: OpenworkSessionSnapshot["messages"]): OpenworkSessionSnapshot {
  return {
    session: {
      id: "session-1",
      slug: "session-1",
      projectID: "project-1",
      directory: "/workspace",
      title: "Session",
      version: "1.0.0",
      time: { created: 1, updated: 1 },
    },
    messages,
    todos: [],
    status: { type: "idle" },
  };
}

function assistantMessage(id: string, tokens: { total?: number; input: number; output: number; reasoning: number }): OpenworkSessionSnapshot["messages"][number] {
  return {
    info: {
      id,
      sessionID: "session-1",
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "user-1",
      modelID: "model-a",
      providerID: "provider-a",
      mode: "chat",
      agent: "openwork",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: {
        ...tokens,
        cache: { read: 0, write: 0 },
      },
    },
    parts: [],
  };
}

function uiTextMessage(id: string, role: UIMessage["role"], text: string): UIMessage {
  return {
    id,
    role,
    parts: [{
      type: "text",
      text,
      state: "done",
    }],
  };
}

function buildUsage(input: {
  contextLimit: number | null;
  snapshot: OpenworkSessionSnapshot | null;
  renderedMessages?: UIMessage[];
  draftText: string;
}) {
  return buildContextUsage({
    contextLimit: input.contextLimit,
    transcriptUsage: buildContextTranscriptUsage({
      snapshot: input.snapshot,
      renderedMessages: input.renderedMessages,
    }),
    draftText: input.draftText,
  });
}

describe("session context usage", () => {
  test("does not render usage without a known context limit", () => {
    const usage = buildUsage({
      contextLimit: null,
      snapshot: snapshot([assistantMessage("assistant-1", { input: 60, output: 8, reasoning: 0 })]),
      draftText: "abcdefgh",
    });

    expect(usage).toBeNull();
  });

  test("looks up the selected model context limit", () => {
    const limit = getSelectedModelContextLimit({
      all: [{
        id: "provider-a",
        models: {
          "model-a": { limit: { context: 128_000 } },
        },
      }],
    }, { providerID: "provider-a", modelID: "model-a" });

    expect(limit).toBe(128_000);
  });

  test("uses the latest reported assistant token load instead of summing every turn", () => {
    const contextSnapshot = snapshot([
      assistantMessage("assistant-old", { input: 800, output: 100, reasoning: 0 }),
      assistantMessage("assistant-new", { input: 450, output: 50, reasoning: 0 }),
    ]);
    const usage = buildUsage({
      contextLimit: 1_000,
      snapshot: contextSnapshot,
      draftText: "",
    });

    expect(getLatestReportedContextTokens(contextSnapshot)).toBe(500);
    expect(usage?.usedTokens).toBe(500);
    expect(usage?.label).toBe("ctx 500 / 1k - 50%");
    expect(usage?.isEstimate).toBe(false);
  });

  test("adds live rendered messages after the latest exact snapshot token load", () => {
    const contextSnapshot = snapshot([
      assistantMessage("assistant-old", { input: 450, output: 50, reasoning: 0 }),
    ]);
    const usage = buildUsage({
      contextLimit: 1_000,
      snapshot: contextSnapshot,
      renderedMessages: [
        uiTextMessage("assistant-old", "assistant", "already persisted"),
        uiTextMessage("assistant-live", "assistant", "abcdefgh"),
      ],
      draftText: "",
    });

    expect(usage?.usedTokens).toBe(502);
    expect(usage?.label).toBe("ctx ~502 / 1k - 50%");
    expect(usage?.isEstimate).toBe(true);
  });

  test("uses rendered transcript estimate when the snapshot is behind", () => {
    const usage = buildUsage({
      contextLimit: 1_000,
      snapshot: snapshot([]),
      renderedMessages: [
        uiTextMessage("user-live", "user", "abcdefghijkl"),
        uiTextMessage("assistant-live", "assistant", "abcdefghijkl"),
      ],
      draftText: "",
    });

    expect(usage?.usedTokens).toBe(7);
    expect(usage?.label).toBe("ctx ~7 / 1k - 1%");
  });

  test("marks draft text as estimated and moves into warning state", () => {
    const usage = buildUsage({
      contextLimit: 100,
      snapshot: snapshot([assistantMessage("assistant-1", { input: 60, output: 8, reasoning: 0 })]),
      draftText: "abcdefgh",
    });

    expect(estimateTextTokens("abcdefgh")).toBe(2);
    expect(usage?.usedTokens).toBe(70);
    expect(usage?.label).toBe("ctx ~70 / 100 - 70%");
    expect(usage?.tone).toBe("warning");
  });

  test("reuses transcript usage while only adding the current draft estimate", () => {
    const transcriptUsage = buildContextTranscriptUsage({
      snapshot: snapshot([assistantMessage("assistant-1", { input: 40, output: 10, reasoning: 0 })]),
    });

    const emptyDraftUsage = buildContextUsage({
      contextLimit: 100,
      transcriptUsage,
      draftText: "",
    });
    const nextDraftUsage = buildContextUsage({
      contextLimit: 100,
      transcriptUsage,
      draftText: "abcdefgh",
    });

    expect(transcriptUsage.tokens).toBe(50);
    expect(emptyDraftUsage?.usedTokens).toBe(50);
    expect(nextDraftUsage?.usedTokens).toBe(52);
    expect(nextDraftUsage?.isEstimate).toBe(true);
  });

  test("falls back to visible text estimate when no reported assistant tokens exist", () => {
    const usage = buildUsage({
      contextLimit: 1_000,
      snapshot: snapshot([{
        info: {
          id: "user-1",
          sessionID: "session-1",
          role: "user",
          time: { created: 1 },
          agent: "openwork",
          model: { providerID: "provider-a", modelID: "model-a" },
        },
        parts: [{
          id: "part-1",
          sessionID: "session-1",
          messageID: "user-1",
          type: "text",
          text: "abcdefghijkl",
        }],
      }]),
      draftText: "",
    });

    expect(usage?.usedTokens).toBe(3);
    expect(usage?.label).toBe("ctx ~3 / 1k - 0%");
  });

  test("warns about compaction near the model limit", () => {
    const usage = buildUsage({
      contextLimit: 100,
      snapshot: snapshot([assistantMessage("assistant-1", { total: 95, input: 0, output: 0, reasoning: 0 })]),
      draftText: "",
    });

    expect(usage?.tone).toBe("danger");
    expect(usage?.showCompactionHint).toBe(true);
  });
});
