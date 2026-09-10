import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { UIMessage } from "ai";
import type { PermissionRequest, PermissionV2Request, QuestionRequest } from "@opencode-ai/sdk/v2/client";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import { createClient } from "../src/app/lib/opencode";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { useSessionInteractions, type UseSessionInteractionsInput } from "../src/react-app/domains/session/sync/use-session-interactions";
import type { OpenworkSessionSnapshot } from "../src/app/lib/openwork-server";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { deriveRenderedSessionMessages } from "../src/react-app/domains/session/surface/session-render-state";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  __disposeWorkspaceSessionSyncForTest,
  __hasWorkspaceSessionSyncForTest,
  __queueSessionSyncDeltaForTest,
  __setSessionSyncDeltaFlushSchedulerForTest,
  __setWorkspaceSessionSyncPermissionFetcherForTest,
  __setWorkspaceSessionSyncStatusFetcherForTest,
  __revalidateWorkspaceSyncsForTest,
  applyPendingDeltasToTranscript,
  coalescePendingDeltas,
  ensureWorkspaceSessionSync,
  revalidateWorkspaceSessionSync,
  permissionKey,
  markSessionSnapshotFetchStart,
  snapshotKey,
  statusKey,
  todoKey,
  questionKey,
  seedPermissionState,
  seedQuestionState,
  settleQuestionState,
  settlePermissionState,
  seedSessionState,
  trackWorkspaceSessionSync,
  transcriptKey,
  type DeltaFlushLane,
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
  __setWorkspaceSessionSyncPermissionFetcherForTest(null);
  __setWorkspaceSessionSyncStatusFetcherForTest(null);
  setSystemTime();
  getReactQueryClient().clear();
  for (const sessionId of ["session-a", "session-b", "session-child"]) {
    useSessionActivityStore.getState().removeSession("workspace-a", sessionId);
  }
});

describe("session permission sync", () => {
  for (const engine of ["v1", "v2"]) {
    test(`${engine} hydration reads only its required protocols and cancels obsolete reads`, async () => {
      GlobalRegistrator.register({ url: "http://localhost/" });
      Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
      const originalFetch = globalThis.fetch;
      const calls: Request[] = [];
      const delayed = Promise.withResolvers<Response>();
      const delayedQuestion = Promise.withResolvers<Response>();
      const v2 = engine === "v2";
      let hold = false;
      const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        calls.push(request);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/api/session")) throw new Error("Unrelated session sweep must not run");
        if (path.endsWith("/api/session/session-a/permission") && hold) return delayed.promise;
        if ((path.endsWith("/form/request") || path.endsWith("/question")) && hold) return delayedQuestion.promise;
        if (path.endsWith("/api/session/session-child/permission")) {
          return Response.json({ data: [v2Permission("perm-child", "session-child")] });
        }
        if (path.endsWith("/api/session/session-a/permission")) return Response.json({ data: [] });
        if (!v2 && path.endsWith("/permission")) {
          return Response.json([permission("perm-legacy", "session-a"), permission("perm-other", "session-b")]);
        }
        return Response.json(v2 ? { data: [] } : []);
      };
      Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: fetchStub });
      const client = v2 ? createClientV2("http://localhost/opencode2", "/project", {}) : createClient("http://localhost/opencode", "/project");
      function Interactions(props: UseSessionInteractionsInput) {
        const interactions = useSessionInteractions(props);
        return createElement("div", null, interactions.activePermission?.id);
      }
      const container = document.createElement("div");
      const root = createRoot(container);
      const render = (sessionId: string, interactionSessionIds: string[] = []) => root.render(createElement(Interactions, {
        client, workspaceId: "workspace-a", workspaceRoot: "/project", sessionId, interactionSessionIds,
      }));
      const cached = (id: string) => getReactQueryClient().getQueryData(permissionKey("workspace-a", id));
      try {
        await act(async () => render("session-a", ["session-child", "session-a", "session-child"]));
        expect(calls.filter((request) => new URL(request.url).pathname.endsWith("/permission")).map((request) => new URL(request.url).pathname))
          .toEqual([
            ...(!v2 ? ["/opencode/permission"] : []),
            `/${v2 ? "opencode2" : "opencode"}/api/session/session-a/permission`,
            `/${v2 ? "opencode2" : "opencode"}/api/session/session-child/permission`,
          ]);
        expect(cached("session-child")).toMatchObject([{ id: "perm-child", sessionID: "session-child", protocol: "v2" }]);
        expect(cached("session-a")).toEqual(v2 ? [] : expect.arrayContaining([expect.objectContaining({ id: "perm-legacy" })]));
        expect(cached("session-b")).toBeUndefined();

        // A request finishing after navigation must not overwrite newer live state,
        // even when its transport ignores cancellation and returns a stale body.
        hold = true;
        await act(async () => render("session-a"));
        const oldPermission = calls.findLast((request) => new URL(request.url).pathname.endsWith("/session-a/permission"));
        const oldQuestion = calls.findLast((request) => /\/(question|form\/request)$/.test(new URL(request.url).pathname));
        expect(oldPermission?.signal.aborted).toBe(false);
        expect(oldQuestion?.signal.aborted).toBe(false);
        await act(async () => render("session-b"));
        // V1's shared timeout transport replaces Request signals. The hook still
        // suppresses its late result; v2's native web transport also aborts I/O.
        if (v2) {
          expect(oldPermission?.signal.aborted).toBe(true);
          expect(oldQuestion?.signal.aborted).toBe(true);
        }
        await act(async () => {
          seedPermissionState("workspace-a", "session-a", [v2Permission("perm-live", "session-a")]);
          delayed.resolve(Response.json({ data: [] }));
          delayedQuestion.resolve(Response.json(v2 ? { data: [] } : []));
        });
        expect(cached("session-a")).toMatchObject([{ id: "perm-live" }]);
      } finally {
        await act(async () => root.unmount());
        Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: originalFetch });
        await GlobalRegistrator.unregister();
      }
    });
  }

  test("terminal cancellation and reconnect reconcile native permissions without reply events", async () => {
    const input = { workspaceId: "workspace-a", baseUrl: "http://permissions.test/opencode2", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const reads: string[] = [];
    __setWorkspaceSessionSyncPermissionFetcherForTest(async (_url, _token, sessionID) => {
      reads.push(sessionID);
      return sessionID === "session-b" ? [v2Permission("other", "session-b")] : [];
    });
    __setWorkspaceSessionSyncStatusFetcherForTest(async () => ({}));
    try {
      setSystemTime(100);
      seedPermissionState("workspace-a", "session-a", [v2Permission("cancelled", "session-a")]);
      seedPermissionState("workspace-a", "session-b", [v2Permission("other", "session-b")]);
      // An unchanged cache revision also settles requests from the same clock tick.
      __applySessionSyncEventForTest(input, { type: "session.execution.interrupted", properties: {
        sessionID: "session-a", reason: "user", sequence: 2,
      } });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(reads).toEqual(["session-a"]);
      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toEqual([]);
      expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-a")).toBe("idle");
      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-b"))).toMatchObject([{ id: "other" }]);
      seedPermissionState("workspace-a", "session-child", [v2Permission("missed", "session-child")]);
      setSystemTime(300);
      __revalidateWorkspaceSyncsForTest();
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(reads).toContain("session-child");
      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-child"))).toEqual([]);
      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-b"))).toMatchObject([{ id: "other" }]);
    } finally { cleanup(); }
  });

  test("late reads cannot clear a same-clock new approval, resurrect a reply, or undo a newer cancellation snapshot", async () => {
    const input = { workspaceId: "workspace-a", baseUrl: "http://permissions.test/opencode2", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    let resolve: (items: PermissionV2Request[]) => void = () => {};
    __setWorkspaceSessionSyncPermissionFetcherForTest(() => new Promise((done) => { resolve = done; }));
    try {
      setSystemTime(100);
      seedPermissionState("workspace-a", "session-a", [v2Permission("cancelled", "session-a"), v2Permission("replied", "session-a")]);
      setSystemTime(200);
      __applySessionSyncEventForTest(input, { type: "session.execution.interrupted", properties: { sessionID: "session-a", reason: "user" } });
      __applySessionSyncEventForTest(input, { type: "session.execution.started", properties: { sessionID: "session-a" } });
      __applySessionSyncEventForTest(input, { type: "permission.v2.asked", properties: v2Permission("new", "session-a") });
      settlePermissionState("workspace-a", "session-a", "replied");
      resolve([v2Permission("replied", "session-a")]);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      seedPermissionState("workspace-a", "session-a", [v2Permission("cancelled", "session-a")], { snapshotStartedAt: 150 });
      __applySessionSyncEventForTest(input, { type: "permission.v2.asked", properties: v2Permission("replied", "session-a") });
      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toMatchObject([{ id: "new" }]);
      expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-a")).toBe("waiting");
    } finally { cleanup(); }
  });

  test("failed permission reconciliation preserves the pending request", async () => {
    const input = { workspaceId: "workspace-a", baseUrl: "http://permissions.test/opencode2", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    __setWorkspaceSessionSyncPermissionFetcherForTest(async () => { throw new Error("offline"); });
    try {
      seedPermissionState("workspace-a", "session-a", [v2Permission("pending", "session-a")]);
      __applySessionSyncEventForTest(input, { type: "session.execution.interrupted", properties: { sessionID: "session-a", reason: "shutdown" } });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-a"))).toMatchObject([{ id: "pending" }]);
    } finally { cleanup(); }
  });
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
    expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-a")).toBe("waiting");
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

  test("keeps a child permission that arrives before the child session is tracked", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "permission.v2.asked",
        properties: v2Permission("perm-child", "session-child"),
      });

      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-child"))).toMatchObject([
        { id: "perm-child", sessionID: "session-child", protocol: "v2" },
      ]);

      __applySessionSyncEventForTest(syncInput, {
        type: "permission.v2.replied",
        properties: { sessionID: "session-child", requestID: "perm-child", reply: "reject" },
      });

      expect(getReactQueryClient().getQueryData(permissionKey("workspace-a", "session-child"))).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("session question sync", () => {
  test("a late snapshot cannot resurrect a settled child request or clear another request", () => {
    const answered = question("question-answered", "session-child");
    const pending = question("question-pending", "session-child");
    seedQuestionState("workspace-a", "session-child", [answered, pending]);
    settleQuestionState("workspace-a", "session-child", answered.id);
    seedQuestionState("workspace-a", "session-child", [answered, pending], { snapshotStartedAt: 100 });
    expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-child"))).toMatchObject([
      { id: pending.id, sessionID: "session-child" },
    ]);
    expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-child")).toBe("waiting");

    settleQuestionState("workspace-a", "session-child", pending.id);
    seedQuestionState("workspace-a", "session-child", [answered, pending], { snapshotStartedAt: 100 });
    expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-child"))).toEqual([]);
    expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-child")).not.toBe("waiting");
  });

  test("retains a child question before its transcript is tracked and settles only that request", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      for (const request of [question("question-child", "session-child"), question("question-other", "session-b")]) {
        __applySessionSyncEventForTest(syncInput, { type: "question.asked", properties: request });
      }
      expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-child"))).toMatchObject([
        { id: "question-child", sessionID: "session-child" },
      ]);
      expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-child")).toBe("waiting");
      expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-a"))).toBeUndefined();

      __applySessionSyncEventForTest(syncInput, {
        type: "question.replied",
        properties: { sessionID: "session-child", requestID: "question-child", answers: [["Yes"]] },
      });
      expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-child"))).toEqual([]);
      expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-child")).not.toBe("waiting");
      expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-b"))).toMatchObject([
        { id: "question-other", sessionID: "session-b" },
      ]);
      expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-b")).toBe("waiting");

      __applySessionSyncEventForTest(syncInput, {
        type: "question.rejected",
        properties: { sessionID: "session-b", requestID: "question-other" },
      });
      expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-b"))).toEqual([]);
      expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-b")).not.toBe("waiting");
    } finally {
      cleanup();
    }
  });

  test("retains the waiting marker for a live question newer than the snapshot", () => {
    getReactQueryClient().setQueryData(questionKey("workspace-a", "session-child"), [
      { ...question("question-live", "session-child"), receivedAt: 200 },
    ]);
    seedQuestionState("workspace-a", "session-child", [], { snapshotStartedAt: 100 });
    expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-child"))).toMatchObject([
      { id: "question-live", sessionID: "session-child", receivedAt: 200 },
    ]);
    expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-child")).toBe("waiting");

    seedQuestionState("workspace-a", "session-child", [], { snapshotStartedAt: 300 });
    expect(getReactQueryClient().getQueryData(questionKey("workspace-a", "session-child"))).toEqual([]);
    expect(useSessionActivityStore.getState().getStatus("workspace-a", "session-child")).not.toBe("waiting");
  });

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

  test("applies a frame of deltas with stable history references", () => {
    const history = Array.from({ length: 200 }, (_, index) =>
      uiMessage(`history-${index}`, index % 2 === 0 ? "user" : "assistant", `history ${index}`),
    );
    const active: UIMessage = {
      id: "active-assistant",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          text: "think",
          state: "streaming",
          providerMetadata: { opencode: { partId: "reasoning-part" } },
        },
        {
          type: "text",
          text: "answer",
          state: "streaming",
          providerMetadata: { opencode: { partId: "text-part" } },
        },
        {
          type: "file",
          url: "file:///tmp/result.txt",
          mediaType: "text/plain",
          providerMetadata: { opencode: { partId: "file-part" } },
        },
      ],
    };
    const transcript = [...history, active];

    const result = applyPendingDeltasToTranscript(transcript, [
      { sessionId: "session-a", messageId: active.id, partId: "reasoning-part", reasoning: false, delta: " more" },
      { sessionId: "session-a", messageId: active.id, partId: "text-part", reasoning: false, delta: " one" },
      { sessionId: "session-a", messageId: active.id, partId: "text-part", reasoning: false, delta: " two" },
      { sessionId: "session-a", messageId: active.id, partId: "not-declared", reasoning: false, delta: "later" },
    ]);

    expect(result.unapplied.map((item) => item.delta)).toEqual(["later"]);
    expect(result.messages).not.toBe(transcript);
    expect(result.messages.slice(0, history.length).every((message, index) => message === history[index])).toBe(true);
    expect(result.messages.at(-1)).not.toBe(active);
    expect(result.messages.at(-1)?.parts[0]).toMatchObject({ type: "reasoning", text: "think more" });
    expect(result.messages.at(-1)?.parts[1]).toMatchObject({ type: "text", text: "answer one two" });
    expect(result.messages.at(-1)?.parts[2]).toBe(active.parts[2]);
  });

  test("commits visible deltas before background-session deltas", () => {
    const scheduled: Array<{
      lane: DeltaFlushLane;
      run: () => void;
      cancelled: boolean;
    }> = [];
    __setSessionSyncDeltaFlushSchedulerForTest((lane, run) => {
      const task = { lane, run, cancelled: false };
      scheduled.push(task);
      return () => {
        task.cancelled = true;
      };
    });

    const syncInput = {
      workspaceId: "workspace-priority",
      baseUrl: "http://127.0.0.1:4321",
      openworkToken: "token",
      visibleSessionId: "session-visible",
    };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const releaseVisible = trackWorkspaceSessionSync(syncInput, "session-visible");
    const releaseBackground = trackWorkspaceSessionSync(syncInput, "session-background");
    const streamMessage = (messageId: string, partId: string): UIMessage => ({
      id: messageId,
      role: "assistant",
      parts: [{
        type: "text",
        text: "",
        state: "streaming",
        providerMetadata: { opencode: { partId } },
      }],
    });
    const queryClient = getReactQueryClient();
    queryClient.setQueryData(
      transcriptKey(syncInput.workspaceId, "session-visible"),
      [streamMessage("message-visible", "part-visible")],
    );
    queryClient.setQueryData(
      transcriptKey(syncInput.workspaceId, "session-background"),
      [streamMessage("message-background", "part-background")],
    );
    const commits = { visible: 0, background: 0 };
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const queryKey = event.query.queryKey;
      if (queryKey[0] !== "react-session-transcript" || queryKey[1] !== syncInput.workspaceId) return;
      if (queryKey[2] === "session-visible") commits.visible += 1;
      if (queryKey[2] === "session-background") commits.background += 1;
    });

    try {
      for (let index = 0; index < 24; index += 1) {
        __queueSessionSyncDeltaForTest(syncInput, {
          sessionId: "session-background",
          messageId: "message-background",
          partId: "part-background",
          reasoning: false,
          delta: "b",
        });
      }
      for (let index = 0; index < 24; index += 1) {
        __queueSessionSyncDeltaForTest(syncInput, {
          sessionId: "session-visible",
          messageId: "message-visible",
          partId: "part-visible",
          reasoning: false,
          delta: "v",
        });
      }

      expect(scheduled.map((task) => task.lane)).toEqual(["background", "foreground"]);
      expect(scheduled[0]?.cancelled).toBe(true);
      scheduled[1]?.run();

      expect(commits).toEqual({ visible: 1, background: 0 });
      expect(queryClient.getQueryData<UIMessage[]>(
        transcriptKey(syncInput.workspaceId, "session-visible"),
      )?.[0]?.parts[0]).toMatchObject({ text: "v".repeat(24) });
      expect(queryClient.getQueryData<UIMessage[]>(
        transcriptKey(syncInput.workspaceId, "session-background"),
      )?.[0]?.parts[0]).toMatchObject({ text: "" });

      expect(scheduled[2]?.lane).toBe("background");
      scheduled[2]?.run();
      expect(commits).toEqual({ visible: 1, background: 1 });
      expect(queryClient.getQueryData<UIMessage[]>(
        transcriptKey(syncInput.workspaceId, "session-background"),
      )?.[0]?.parts[0]).toMatchObject({ text: "b".repeat(24) });

      __queueSessionSyncDeltaForTest(syncInput, {
        sessionId: "session-background",
        messageId: "message-background",
        partId: "part-background",
        reasoning: false,
        delta: " complete",
      });
      expect(scheduled[3]?.lane).toBe("background");
      __applySessionSyncEventForTest(syncInput, {
        type: "session.idle",
        properties: { sessionID: "session-background" },
      });
      expect(scheduled[3]?.cancelled).toBe(true);
      expect(commits).toEqual({ visible: 1, background: 2 });
      expect(queryClient.getQueryData<UIMessage[]>(
        transcriptKey(syncInput.workspaceId, "session-background"),
      )?.[0]?.parts[0]).toMatchObject({ text: `${"b".repeat(24)} complete` });
    } finally {
      unsubscribe();
      releaseBackground();
      releaseVisible();
      cleanup();
      __setSessionSyncDeltaFlushSchedulerForTest(null);
    }
  });

  test.each([false, true])("both pane attachments stay foreground across owner ordering and release (reverse: %s)", async (reverse) => {
    const input = { workspaceId: "workspace-panes", baseUrl: "http://localhost/panes", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const scheduled: Array<{ lane: DeltaFlushLane; run: () => void; cancelled: boolean }> = [];
    __setSessionSyncDeltaFlushSchedulerForTest((lane, run) => {
      const task = { lane, run, cancelled: false };
      scheduled.push(task);
      return () => { task.cancelled = true; };
    });
    const client = getReactQueryClient();
    const releases: Array<() => void> = [];
    const ids = ["pane-a", "pane-b", "hidden"];
    for (const id of ids) {
      releases.push(trackWorkspaceSessionSync(input, id));
      client.setQueryData<UIMessage[]>(transcriptKey(input.workspaceId, id), [{
        id: "message", role: "assistant", parts: [{ type: "text", text: "", providerMetadata: { opencode: { partId: "part" } } }],
      }]);
    }
    const queue = (id: string, delta: string) => __applySessionSyncEventForTest(input, {
      type: "message.part.delta",
      properties: { sessionID: id, messageID: "message", partID: "part", field: "text", delta },
    });
    const text = (id: string) => client.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, id))?.[0]?.parts[0];
    const flush = (lane: DeltaFlushLane) => {
      const task = scheduled.findLast((task) => !task.cancelled);
      expect(task?.lane).toBe(lane);
      if (!task) throw new Error("Missing scheduled flush");
      task.cancelled = true;
      task.run();
    };
    try {
      queue("pane-a", "1");
      expect(scheduled.at(-1)?.lane).toBe("background");
      const paneOrder = reverse ? ["pane-b", "pane-a"] : ["pane-a", "pane-b"];
      const owners = paneOrder.map((visibleSessionId) => ensureWorkspaceSessionSync({ ...input, visibleSessionId }));
      releases.push(...owners);
      const duplicate = ensureWorkspaceSessionSync({ ...input, visibleSessionId: "pane-a" });
      const background = ensureWorkspaceSessionSync(input);
      releases.push(duplicate, background);
      __setWorkspaceSessionSyncStatusFetcherForTest(async () => Object.fromEntries(ids.map((id) => [id, { type: "busy" }])));
      await revalidateWorkspaceSessionSync(input);
      queue("pane-a", "2");
      queue("pane-b", "b");
      queue("hidden", "h");
      expect(scheduled[0]?.cancelled).toBe(true);
      flush("foreground");
      expect(text("pane-a")).toMatchObject({ text: "12" });
      expect(text("pane-b")).toMatchObject({ text: "b" });
      expect(text("hidden")).toMatchObject({ text: "" });
      flush("background");
      expect(text("hidden")).toMatchObject({ text: "h" });

      // Releasing either route first cannot remove the other pane or a second
      // attachment of the same pane. Cleanup is idempotent.
      owners[paneOrder.indexOf("pane-a")]!();
      owners[paneOrder.indexOf("pane-a")]!();
      background();
      queue("pane-a", "3");
      flush("foreground");
      expect(text("pane-a")).toMatchObject({ text: "123" });
      queue("pane-a", "4");
      const foregroundTask = scheduled.at(-1);
      duplicate();
      expect(foregroundTask?.cancelled).toBe(true);
      flush("background");
      expect(text("pane-a")).toMatchObject({ text: "1234" });
      queue("pane-b", "2");
      flush("foreground");

      seedPermissionState(input.workspaceId, "pane-b", [permission("pending", "pane-b")]);
      seedQuestionState(input.workspaceId, "pane-b", [question("question", "pane-b")]);
      owners[paneOrder.indexOf("pane-b")]!();
      queue("pane-b", "3");
      flush("background");
      expect(text("pane-b")).toMatchObject({ text: "b23" });
      expect(client.getQueryData(permissionKey(input.workspaceId, "pane-b"))).toMatchObject([{ id: "pending" }]);
      expect(client.getQueryData(questionKey(input.workspaceId, "pane-b"))).toMatchObject([{ id: "question" }]);
      await revalidateWorkspaceSessionSync(input);
      expect(useSessionActivityStore.getState().getStatus(input.workspaceId, "pane-b")).toBe("waiting");
      expect(useSessionActivityStore.getState().recordsByWorkspaceId[input.workspaceId]?.hidden?.runActive).toBe(true);
      queue("hidden", "2");
      flush("background");
      expect(text("hidden")).toMatchObject({ text: "h2" });
      expect(__hasWorkspaceSessionSyncForTest(input)).toBe(true);
    } finally {
      for (const release of releases) release();
      cleanup();
      __setSessionSyncDeltaFlushSchedulerForTest(null);
      for (const id of ids) useSessionActivityStore.getState().removeSession(input.workspaceId, id);
    }
  });

  test("foreground membership is isolated by workspace and server, not the session ID", () => {
    const input = { workspaceId: "workspace-owner", baseUrl: "http://localhost/one", openworkToken: "token" };
    const otherServer = { ...input, baseUrl: "http://localhost/two" };
    const otherWorkspace = { ...input, workspaceId: "workspace-other" };
    const cleanups = [input, otherServer, otherWorkspace].map(__createWorkspaceSessionSyncForTest);
    const lanes: DeltaFlushLane[] = [];
    __setSessionSyncDeltaFlushSchedulerForTest((lane) => { lanes.push(lane); return () => {}; });
    const release = ensureWorkspaceSessionSync({ ...input, visibleSessionId: "same-id" });
    try {
      for (const owner of [input, otherServer, otherWorkspace]) {
        __queueSessionSyncDeltaForTest(owner, { sessionId: "same-id", messageId: "m", partId: "p", reasoning: false, delta: "x" });
      }
      expect(lanes).toEqual(["foreground", "background", "background"]);
    } finally {
      release();
      for (const cleanup of cleanups) cleanup();
      __setSessionSyncDeltaFlushSchedulerForTest(null);
    }
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

  test("rendering and hydration reuse unchanged history across cached revisits and tail refreshes", () => {
    const snapshot = snapshotWithMessages(Array.from({ length: 140 }, (_, index) => ({
      id: `history-${index}`, role: "assistant", text: `answer-${index}`,
    })));
    let projectionReads = 0;
    for (const message of snapshot.messages) {
      for (const part of message.parts) {
        if (part.type !== "text") continue;
        const text = part.text;
        Object.defineProperty(part, "text", { get() { projectionReads += 1; return text; } });
      }
    }
    const queryClient = getReactQueryClient();
    const key = transcriptKey("workspace-a", "session-a");
    const render = (current: OpenworkSessionSnapshot) => deriveRenderedSessionMessages({
      snapshot: current, transcriptState: queryClient.getQueryData<UIMessage[]>(key),
    });
    render(snapshot);
    seedSessionState("workspace-a", snapshot);
    const first = render(snapshot);
    projectionReads = 0;
    for (let index = 0; index < 20; index += 1) {
      // A status/title envelope update still contains the exact same history.
      const revisited = { ...snapshot, session: { ...snapshot.session, title: `title-${index}` } };
      seedSessionState("workspace-a", revisited);
      const rendered = render(revisited);
      expect(rendered.every((message, at) => message === first[at])).toBe(true);
    }
    console.info(`cached hydration: history=140, revisits=20, projectionReads=${projectionReads}`);
    expect(projectionReads).toBe(0);

    const fresh = snapshotWithMessages([{ id: "history-139", role: "assistant", text: "fresh answer" }]);
    const changed = fresh.messages[0]!;
    const refreshed = {
      ...snapshot,
      messages: [...snapshot.messages.slice(0, -1), {
        ...changed, info: { ...changed.info, time: { created: 140 } },
      }],
    };
    seedSessionState("workspace-a", refreshed);
    const rendered = render(refreshed);
    expect(projectionReads).toBe(0);
    expect(rendered.slice(0, -1).every((message, at) => message === first[at])).toBe(true);
    expect(rendered.at(-1)?.parts[0]).toMatchObject({ text: "fresh answer" });
    expect(snapshotToUIMessages(snapshot).at(-1)?.parts[0]).toMatchObject({ text: "answer-139" });
  });

  test("todo hydration rejects old reads and cached reapplication but accepts newer snapshots", () => {
    const input = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, "session-a");
    const old = snapshotWithMessages([]);
    old.todos = [{ id: "todo-a", content: "Check output", status: "pending", priority: "high" }];
    const completed = old.todos.map((todo) => ({ ...todo, status: "completed" }));
    const queryClient = getReactQueryClient();
    try {
      setSystemTime(100);
      markSessionSnapshotFetchStart(old, 100);
      seedSessionState("workspace-a", old);
      const unmarked = snapshotWithMessages([]);
      unmarked.todos = old.todos;
      seedSessionState("workspace-a", unmarked);
      seedSessionState("workspace-a", snapshotWithMessages([], "session-b"));
      setSystemTime(200);
      __applySessionSyncEventForTest(input, {
        type: "todo.updated", properties: { sessionID: "session-a", todos: completed },
      });
      setSystemTime(300);
      seedSessionState("workspace-a", old);
      seedSessionState("workspace-a", unmarked);
      const late = snapshotWithMessages([]);
      markSessionSnapshotFetchStart(late, 150);
      seedSessionState("workspace-a", late);
      const tied = snapshotWithMessages([]);
      markSessionSnapshotFetchStart(tied, 200);
      seedSessionState("workspace-a", tied);
      expect(queryClient.getQueryData(todoKey("workspace-a", "session-a"))).toEqual(completed);
      expect(queryClient.getQueryData(todoKey("workspace-a", "session-b"))).toEqual([]);
      const fresh = snapshotWithMessages([]);
      markSessionSnapshotFetchStart(fresh, 250);
      seedSessionState("workspace-a", fresh);
      expect(queryClient.getQueryData(todoKey("workspace-a", "session-a"))).toEqual([]);
      seedSessionState("workspace-a", old);
      expect(queryClient.getQueryData(todoKey("workspace-a", "session-a"))).toEqual([]);
    } finally { release(); cleanup(); }
  });

  for (const preview of [true, false]) for (const declared of [true, false]) {
    test(`snapshot reconciles buffered deltas exactly once (declared=${declared}, preview=${preview})`, () => {
      const scheduled: Array<() => void> = [];
      __setSessionSyncDeltaFlushSchedulerForTest((_lane, run) => {
        scheduled.push(run);
        return () => {};
      });
      const input = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
      const cleanup = __createWorkspaceSessionSyncForTest(input);
      const release = trackWorkspaceSessionSync(input, "session-a");
      const queryClient = getReactQueryClient();
      const key = transcriptKey("workspace-a", "session-a");
      const releaseNeighbor = trackWorkspaceSessionSync(input, "session-b");
      try {
        if (declared) seedSessionState("workspace-a", snapshotWithMessages([
          { id: "answer", role: "assistant", text: "hello" },
        ]));
        __applySessionSyncEventForTest(input, {
          type: "message.part.delta", properties: {
            sessionID: "session-b", messageID: "answer", partID: "part_answer", delta: "neighbor text stays separate",
          },
        });
        for (const run of scheduled.splice(0)) run();
        const delta = (messageId: string, text: string) => __applySessionSyncEventForTest(input, {
          type: "message.part.delta", properties: {
            sessionID: "session-a", messageID: messageId, partID: `part_${messageId}`, delta: text,
          },
        });
        delta("answer", declared ? " world" : "hello world");
        delta("unknown", "retained");
        const snapshot = snapshotWithMessages([
          { id: "history", role: "user", text: "unchanged history" },
          { id: "answer", role: "assistant", text: declared ? "hello world" : "hello" },
        ]);
        const projected = snapshotToUIMessages(snapshot);
        for (const message of projected) {
          for (const part of message.parts) Object.freeze(part);
          Object.freeze(message.parts);
          Object.freeze(message);
        }
        Object.freeze(projected);
        seedSessionState("workspace-a", snapshot, { preview });
        expect(projected[1]?.parts[0]).toMatchObject({ text: declared ? "hello world" : "hello" });
        expect(snapshotToUIMessages(snapshot)).toBe(projected);
        expect(queryClient.getQueryData<UIMessage[]>(key)?.find((message) => message.id === "history")).toEqual(projected[0]);
        expect(snapshot.messages[1]?.parts[0]).toMatchObject({ text: declared ? "hello world" : "hello" });
        for (const run of scheduled.splice(0)) run();
        expect(queryClient.getQueryData<UIMessage[]>(key)?.find((m) => m.id === "answer")?.parts[0])
          .toMatchObject({ text: "hello world" });
        delta("answer", "!");
        seedSessionState("workspace-a", snapshot);
        for (const run of scheduled.splice(0)) run();
        expect(queryClient.getQueryData<UIMessage[]>(key)?.find((m) => m.id === "answer")?.parts[0])
          .toMatchObject({ text: "hello world!" });
        __applySessionSyncEventForTest(input, {
          type: "message.part.updated", properties: { part: {
            id: "part_unknown", sessionID: "session-a", messageID: "unknown", type: "text", text: "",
          } },
        });
        expect(queryClient.getQueryData<UIMessage[]>(key)?.find((m) => m.id === "unknown")?.parts[0])
          .toMatchObject({ text: "retained" });
        __applySessionSyncEventForTest(input, {
          type: "message.part.updated", properties: { part: {
            id: "part_answer", sessionID: "session-b", messageID: "answer", type: "text", text: "",
          } },
        });
        expect(queryClient.getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-b"))?.[0]?.parts[0])
          .toMatchObject({ text: "neighbor text stays separate" });
        __applySessionSyncEventForTest(input, {
          type: "message.part.delta", properties: {
            sessionID: "session-b", messageID: "answer", partID: "part_answer", delta: "!",
          },
        });
        __applySessionSyncEventForTest(input, {
          type: "message.part.updated", properties: { part: {
            id: "part_answer", sessionID: "session-a", messageID: "answer", type: "text", text: "hello world!",
          } },
        });
        for (const run of scheduled.splice(0)) run();
        expect(queryClient.getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-b"))?.[0]?.parts[0])
          .toMatchObject({ text: "neighbor text stays separate!" });
      } finally { releaseNeighbor(); release(); cleanup(); __setSessionSyncDeltaFlushSchedulerForTest(null); }
    });
  }

  test("a preview supplies live part baselines without seeding status, todos, admission, or complete history", () => {
    const scheduled: Array<() => void> = [];
    __setSessionSyncDeltaFlushSchedulerForTest((_lane, run) => { scheduled.push(run); return () => {}; });
    const input = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(input);
    const release = trackWorkspaceSessionSync(input, "session-a");
    const queryClient = getReactQueryClient();
    const key = transcriptKey("workspace-a", "session-a");
    try {
      const preview = snapshotWithMessages([{ id: "answer", role: "assistant", text: "Existing answer" }]);
      markSessionSnapshotFetchStart(preview, Date.now());
      const activity = useSessionActivityStore.getState().recordsByWorkspaceId;
      seedSessionState("workspace-a", preview, { preview: true });
      expect(queryClient.getQueryData(snapshotKey("workspace-a", "session-a"))).toBeUndefined();
      expect(queryClient.getQueryData(statusKey("workspace-a", "session-a"))).toBeUndefined();
      expect(queryClient.getQueryData(todoKey("workspace-a", "session-a"))).toBeUndefined();
      expect(useSessionActivityStore.getState().recordsByWorkspaceId).toBe(activity);
      __applySessionSyncEventForTest(input, { type: "message.part.delta", properties: {
        sessionID: "session-a", messageID: "answer", partID: "part_answer", delta: " continues",
      } });
      for (const run of scheduled.splice(0)) run();
      expect(deriveRenderedSessionMessages({ snapshot: preview, transcriptState: queryClient.getQueryData(key), historyComplete: false })[0]?.parts[0])
        .toMatchObject({ text: "Existing answer continues" });
      seedSessionState("workspace-a", snapshotWithMessages([
        { id: "earlier", role: "user", text: "Earlier prompt" },
        { id: "answer", role: "assistant", text: "Existing answer" },
      ]));
      for (const run of scheduled.splice(0)) run();
      expect(queryClient.getQueryData<UIMessage[]>(key)?.map((message) => message.id)).toEqual(["earlier", "answer"]);
      expect(queryClient.getQueryData<UIMessage[]>(key)?.[1]?.parts[0]).toMatchObject({ text: "Existing answer continues" });
    } finally { release(); cleanup(); __setSessionSyncDeltaFlushSchedulerForTest(null); }
  });

  test("a reverted preview neither seeds its suffix nor truncates a known live transcript", () => {
    const queryClient = getReactQueryClient();
    const key = transcriptKey("workspace-a", "session-a");
    const current = [uiMessage("before", "user", "Kept")];
    queryClient.setQueryData(key, current);
    const preview = snapshotWithMessages([{ id: "hidden", role: "assistant", text: "Reverted away" }]);
    preview.session.revert = { messageID: "missing-cursor" };
    seedSessionState("workspace-a", preview, { preview: true });
    expect(queryClient.getQueryData(key)).toEqual(current);
    expect(queryClient.getQueryData(snapshotKey("workspace-a", "session-a"))).toBeUndefined();
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
