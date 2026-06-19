import { afterEach, describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import type { PermissionRequest, PermissionV2Request, QuestionRequest } from "@opencode-ai/sdk/v2/client";

import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  __disposeWorkspaceSessionSyncForTest,
  __hasWorkspaceSessionSyncForTest,
  coalescePendingDeltas,
  ensureWorkspaceSessionSync,
  permissionKey,
  questionKey,
  seedPermissionState,
  seedQuestionState,
  seedSessionState,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";

function permission(id: string, sessionID: string): PermissionRequest {
  return {
    id,
    sessionID,
    permission: "bash",
    patterns: ["echo ok"],
    metadata: {},
    always: [],
  };
}

function v2Permission(id: string, sessionID: string): PermissionV2Request {
  return {
    id,
    sessionID,
    action: "file.read",
    resources: ["/outside/project/secrets.txt"],
    metadata: { path: "/outside/project/secrets.txt" },
    save: ["/outside/project/*"],
  };
}

function question(id: string, sessionID: string): QuestionRequest {
  return {
    id,
    sessionID,
    questions: [
      {
        header: "Choice",
        question: "Pick one",
        options: [{ label: "Yes", description: "Proceed" }],
      },
    ],
  };
}

function uiMessage(id: string, role: "user" | "assistant", text: string): UIMessage {
  return {
    id,
    role,
    parts: [{ type: "text", text, state: "done" }],
  };
}

function snapshotWithMessages(
  messages: Array<{ id: string; role: "user" | "assistant"; text: string }>,
  sessionId = "session-a",
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

afterEach(() => {
  getReactQueryClient().clear();
});

describe("session permission sync", () => {
  test("seeds only permissions for the selected session", () => {
    seedPermissionState("workspace-a", "session-a", [
      permission("perm-a", "session-a"),
      permission("perm-b", "session-b"),
    ]);

    expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toMatchObject([
      { id: "perm-a", sessionID: "session-a", permission: "bash" },
    ]);
  });

  test("preserves received time when refreshing an existing permission", () => {
    seedPermissionState("workspace-a", "session-a", [permission("perm-a", "session-a")]);
    const first = getReactQueryClient().getQueryData<Array<{ id: string; receivedAt: number }>>(
      permissionKey("workspace-a", "session-a"),
    )!;

    seedPermissionState("workspace-a", "session-a", [permission("perm-a", "session-a")]);
    const second = getReactQueryClient().getQueryData<Array<{ id: string; receivedAt: number }>>(
      permissionKey("workspace-a", "session-a"),
    )!;

    expect(second[0]!.receivedAt).toBe(first[0]!.receivedAt);
  });

  test("keeps live permissions that arrive after a snapshot starts", () => {
    getReactQueryClient().setQueryData(permissionKey("workspace-a", "session-a"), [
      {
        ...permission("perm-live", "session-a"),
        receivedAt: 200,
      },
    ]);

    seedPermissionState("workspace-a", "session-a", [], { snapshotStartedAt: 100 });

    expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toMatchObject([
      { id: "perm-live", sessionID: "session-a", permission: "bash" },
    ]);
  });

  test("drops stale permissions that predate a fresh snapshot", () => {
    getReactQueryClient().setQueryData(permissionKey("workspace-a", "session-a"), [
      {
        ...permission("perm-stale", "session-a"),
        receivedAt: 100,
      },
    ]);

    seedPermissionState("workspace-a", "session-a", [], { snapshotStartedAt: 200 });

    expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toEqual([]);
  });

  test("seeds v2 permissions for the selected session", () => {
    seedPermissionState("workspace-a", "session-a", [
      v2Permission("perm-v2-a", "session-a"),
      v2Permission("perm-v2-b", "session-b"),
    ]);

    expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toMatchObject([
      {
        id: "perm-v2-a",
        sessionID: "session-a",
        permission: "read",
        patterns: ["/outside/project/secrets.txt"],
        protocol: "v2",
      },
    ]);
  });

  test("adds and removes live v2 permission events", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const releaseSession = trackWorkspaceSessionSync(syncInput, "session-a");

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "permission.v2.asked",
        properties: v2Permission("perm-v2-live", "session-a"),
      });

      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toMatchObject([
        { id: "perm-v2-live", sessionID: "session-a", permission: "read", protocol: "v2" },
      ]);

      __applySessionSyncEventForTest(syncInput, {
        type: "permission.v2.replied",
        properties: { sessionID: "session-a", requestID: "perm-v2-live", reply: "once" },
      });

      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toEqual([]);
    } finally {
      releaseSession();
      cleanup();
    }
  });
});

describe("session question sync", () => {
  test("seeds only questions for the selected session", () => {
    seedQuestionState("workspace-a", "session-a", [
      question("question-a", "session-a"),
      question("question-b", "session-b"),
    ]);

    expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-a"))).toMatchObject([
      { id: "question-a", sessionID: "session-a" },
    ]);
  });

  test("adds and removes live question events", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const releaseSession = trackWorkspaceSessionSync(syncInput, "session-a");

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "question.asked",
        properties: question("question-live", "session-a"),
      } as any);

      expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-a"))).toMatchObject([
        { id: "question-live", sessionID: "session-a" },
      ]);

      __applySessionSyncEventForTest(syncInput, {
        type: "question.replied",
        properties: { sessionID: "session-a", requestID: "question-live", answers: [["Yes"]] },
      } as any);

      expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-a"))).toEqual([]);
    } finally {
      releaseSession();
      cleanup();
    }
  });
});

describe("session transcript sync", () => {
  test("coalesces token-sized deltas by transcript part", () => {
    const deltas = coalescePendingDeltas([
      { sessionId: "session-a", messageId: "msg-a", partId: "part-a", reasoning: false, delta: "hel" },
      { sessionId: "session-a", messageId: "msg-a", partId: "part-a", reasoning: false, delta: "lo" },
      { sessionId: "session-a", messageId: "msg-a", partId: "part-b", reasoning: true, delta: "think" },
      { sessionId: "session-b", messageId: "msg-b", partId: "part-a", reasoning: false, delta: "other" },
    ]);

    expect(deltas).toEqual([
      { sessionId: "session-a", messageId: "msg-a", partId: "part-a", reasoning: false, delta: "hello" },
      { sessionId: "session-a", messageId: "msg-a", partId: "part-b", reasoning: true, delta: "think" },
      { sessionId: "session-b", messageId: "msg-b", partId: "part-a", reasoning: false, delta: "other" },
    ]);
  });

  test("keeps live-only messages when an idle snapshot is stale", () => {
    getReactQueryClient().setQueryData(transcriptKey("workspace-a", "session-a"), [
      uiMessage("msg-user", "user", "hello"),
      uiMessage("msg-assistant", "assistant", "finished answer"),
    ]);

    seedSessionState("workspace-a", snapshotWithMessages([
      { id: "msg-user", role: "user", text: "hello" },
    ]));

    const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
    expect(transcript?.map((message) => message.id)).toEqual(["msg-user", "msg-assistant"]);
  });

  test("keeps longer live text when an idle snapshot lags the event stream", () => {
    getReactQueryClient().setQueryData(transcriptKey("workspace-a", "session-a"), [
      uiMessage("msg-user", "user", "hello"),
      uiMessage("msg-assistant", "assistant", "finished answer"),
    ]);

    seedSessionState("workspace-a", snapshotWithMessages([
      { id: "msg-user", role: "user", text: "hello" },
      { id: "msg-assistant", role: "assistant", text: "finished" },
    ]));

    const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
    expect(transcript?.[1]?.parts[0]).toMatchObject({ text: "finished answer" });
  });

  test("continues accepting stream deltas for a recently unselected session", async () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);

    try {
      const releaseSessionA = trackWorkspaceSessionSync(syncInput, "session-a");
      releaseSessionA();
      const releaseSessionB = trackWorkspaceSessionSync(syncInput, "session-b");

      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-assistant", role: "assistant", sessionID: "session-a" } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-assistant",
            type: "text",
            text: "",
            sessionID: "session-a",
            messageID: "msg-assistant",
          },
        },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.delta",
        properties: {
          sessionID: "session-a",
          messageID: "msg-assistant",
          partID: "part-assistant",
          delta: "still streaming after switch",
        },
      } as any);

      await Promise.resolve();

      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts[0]).toMatchObject({ text: "still streaming after switch" });

      releaseSessionB();
    } finally {
      cleanup();
    }
  });

  test("keeps workspace stream alive while retained sessions remain after route unmount", async () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
    const releaseWorkspace = ensureWorkspaceSessionSync(syncInput);
    const releaseSessionA = trackWorkspaceSessionSync(syncInput, "session-a");

    releaseSessionA();
    releaseWorkspace();

    try {
      expect(__hasWorkspaceSessionSyncForTest(syncInput)).toBe(true);

      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-route-leave", role: "assistant", sessionID: "session-a" } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-route-leave",
            type: "text",
            text: "",
            sessionID: "session-a",
            messageID: "msg-route-leave",
          },
        },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.delta",
        properties: {
          sessionID: "session-a",
          messageID: "msg-route-leave",
          partID: "part-route-leave",
          delta: "stream survived settings route",
        },
      } as any);

      await Promise.resolve();

      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts[0]).toMatchObject({ text: "stream survived settings route" });
    } finally {
      __disposeWorkspaceSessionSyncForTest(syncInput);
    }
  });
});
