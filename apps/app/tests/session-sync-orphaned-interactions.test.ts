import { afterEach, describe, expect, test } from "bun:test";
import type { Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { terminalToolCallIds } from "../src/react-app/domains/session/sync/orphaned-interactions";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  permissionKey,
  questionKey,
  seedPermissionState,
  seedQuestionState,
  seedSessionState,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";

// OpenCode 1.18 drops a question or permission whose turn was aborted or
// superseded by a newer prompt without publishing `question.rejected` /
// `permission.replied`; when the tool call is abandoned rather than
// interrupted the request even stays in `GET /question`. The transcript's
// terminal tool part is the only signal that nobody can answer it any more.

const workspaceId = "workspace-a";
const sessionId = "session-a";
const syncInput = { workspaceId, baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
const toolLink = { messageID: "msg-assistant", callID: "call-question" };

type ToolPart = Extract<Part, { type: "tool" }>;

function toolPart(status: "running" | "completed" | "error", overrides: Partial<ToolPart> = {}): ToolPart {
  const base = { id: "part-question", sessionID: sessionId, messageID: toolLink.messageID, type: "tool" as const,
    callID: toolLink.callID, tool: "question" };
  if (status === "running") return { ...base, ...overrides, state: { status: "running", input: {}, time: { start: 1 } } };
  if (status === "completed") {
    return { ...base, ...overrides, state: { status: "completed", input: {}, output: "ok", title: "Asked", metadata: {}, time: { start: 1, end: 2 } } };
  }
  return { ...base, ...overrides, state: { status: "error", input: {}, error: "Tool execution aborted", time: { start: 1, end: 2 } } };
}

function question(id: string): QuestionRequest {
  return { id, sessionID: sessionId, tool: toolLink,
    questions: [{ header: "Choice", question: "Pick one", options: [{ label: "Yes", description: "Proceed" }] }] };
}

function unlinkedQuestion(id: string): QuestionRequest {
  const { tool: _tool, ...rest } = question(id);
  return rest;
}

function permission(id: string): PermissionRequest {
  return { id, sessionID: sessionId, permission: "bash", patterns: ["echo ok"], metadata: {}, always: [], tool: toolLink };
}

function snapshotWithParts(parts: Part[]): OpenworkSessionSnapshot {
  return {
    session: { id: sessionId, title: "Test session", time: { created: 1, updated: 2 }, version: "0" },
    messages: [
      { info: { id: "msg-user", role: "user", sessionID: sessionId, time: { created: 1 } }, parts: [] },
      { info: { id: toolLink.messageID, role: "assistant", sessionID: sessionId, time: { created: 2 } }, parts },
    ],
    todos: [],
    status: { type: "idle" },
  } as unknown as OpenworkSessionSnapshot;
}

const status = () => useSessionActivityStore.getState().getStatus(workspaceId, sessionId);
const questions = () => getReactQueryClient().getQueryData(questionKey(workspaceId, sessionId));
const permissions = () => getReactQueryClient().getQueryData(permissionKey(workspaceId, sessionId));

afterEach(() => {
  getReactQueryClient().clear();
  useSessionActivityStore.getState().removeSession(workspaceId, sessionId);
});

describe("orphaned interaction settlement", () => {
  test("a live terminal tool part settles the question it asked without any rejected event", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, sessionId);
    try {
      __applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
      __applySessionSyncEventForTest(syncInput, { type: "message.updated",
        properties: { info: { id: toolLink.messageID, role: "assistant", sessionID: sessionId } } });
      __applySessionSyncEventForTest(syncInput, { type: "question.asked", properties: question("que-1") });
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: toolPart("running") } });
      expect(status()).toBe("waiting");

      // A newer prompt supersedes the turn: OpenCode marks the tool call as
      // errored and moves on, but never publishes question.rejected.
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: toolPart("error") } });
      expect(questions()).toEqual([]);
      expect(status()).toBe("responding");

      __applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: sessionId, status: { type: "idle" } } });
      expect(status()).toBe("idle");

      // The engine still lists the abandoned request; a later list read must
      // not resurrect it.
      seedQuestionState(workspaceId, sessionId, [question("que-1")], { snapshotStartedAt: Date.now() });
      expect(questions()).toEqual([]);
      expect(status()).toBe("idle");
    } finally {
      release();
      cleanup();
    }
  });

  test("an abandoned question listed by the engine is not seeded for a transcript whose tool call ended", () => {
    seedSessionState(workspaceId, snapshotWithParts([toolPart("error")]));
    expect(status()).toBe("idle");

    seedQuestionState(workspaceId, sessionId, [question("que-zombie")], { snapshotStartedAt: Date.now() });
    expect(questions()).toEqual([]);
    expect(status()).toBe("idle");
  });

  test("a transcript snapshot settles a question and permission that were listed before it loaded", () => {
    seedQuestionState(workspaceId, sessionId, [question("que-zombie")], { snapshotStartedAt: Date.now() });
    seedPermissionState(workspaceId, sessionId, [permission("perm-zombie")], { snapshotStartedAt: Date.now() });
    expect(status()).toBe("waiting");

    seedSessionState(workspaceId, snapshotWithParts([toolPart("completed")]));
    expect(questions()).toEqual([]);
    expect(permissions()).toEqual([]);
    expect(status()).toBe("idle");
  });

  test("a running tool call or a request without a tool link keeps the waiting marker", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, sessionId);
    try {
      __applySessionSyncEventForTest(syncInput, { type: "session.status", properties: { sessionID: sessionId, status: { type: "busy" } } });
      __applySessionSyncEventForTest(syncInput, { type: "question.asked", properties: question("que-live") });
      __applySessionSyncEventForTest(syncInput, { type: "question.asked", properties: unlinkedQuestion("que-unlinked") });
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: toolPart("running") } });
      expect(questions()).toMatchObject([{ id: "que-live" }, { id: "que-unlinked" }]);
      expect(status()).toBe("waiting");

      // Another tool call finishing must not settle this question.
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated",
        properties: { part: toolPart("completed", { id: "part-other", callID: "call-other", tool: "bash" }) } });
      seedQuestionState(workspaceId, sessionId, [question("que-live"), unlinkedQuestion("que-unlinked")], { snapshotStartedAt: Date.now() });
      expect(questions()).toMatchObject([{ id: "que-live" }, { id: "que-unlinked" }]);
      expect(status()).toBe("waiting");

      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: toolPart("error") } });
      expect(questions()).toMatchObject([{ id: "que-unlinked" }]);
      expect(status()).toBe("waiting");
    } finally {
      release();
      cleanup();
    }
  });

  test("a terminal part for an untracked session still clears its sidebar marker", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      __applySessionSyncEventForTest(syncInput, { type: "permission.asked", properties: permission("perm-1") });
      expect(status()).toBe("waiting");
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: toolPart("error", { tool: "bash" }) } });
      expect(permissions()).toEqual([]);
      expect(status()).toBe("idle");
      expect(getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId))).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("terminalToolCallIds reads only completed and errored tool calls from raw messages", () => {
    const ids = terminalToolCallIds([
      { parts: [toolPart("running"), toolPart("completed", { callID: "call-done" }), toolPart("error", { callID: "call-failed" })] },
      { parts: [{ id: "text", type: "text", text: "hi", sessionID: sessionId, messageID: "msg-user" }] },
    ]);
    expect([...ids].sort()).toEqual(["call-done", "call-failed"]);
  });
});
