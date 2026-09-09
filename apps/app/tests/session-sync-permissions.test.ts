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
  permissionKey,
  markSessionSnapshotFetchStart,
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

  for (const declared of [true, false]) {
    test(`snapshot reconciles buffered deltas exactly once (declared=${declared})`, () => {
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
      try {
        if (declared) seedSessionState("workspace-a", snapshotWithMessages([
          { id: "answer", role: "assistant", text: "hello" },
        ]));
        const delta = (messageId: string, text: string) => __applySessionSyncEventForTest(input, {
          type: "message.part.delta", properties: {
            sessionID: "session-a", messageID: messageId, partID: `part_${messageId}`, delta: text,
          },
        });
        delta("answer", declared ? " world" : "hello world");
        delta("unknown", "retained");
        seedSessionState("workspace-a", snapshotWithMessages([
          { id: "answer", role: "assistant", text: "hello world" },
        ]));
        for (const run of scheduled.splice(0)) run();
        expect(queryClient.getQueryData<UIMessage[]>(key)?.find((m) => m.id === "answer")?.parts[0])
          .toMatchObject({ text: "hello world" });
        delta("answer", "!");
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
      } finally { release(); cleanup(); __setSessionSyncDeltaFlushSchedulerForTest(null); }
    });
  }

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
