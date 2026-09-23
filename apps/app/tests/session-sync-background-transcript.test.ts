import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import type { UIMessage } from "ai";

import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  __setSessionSyncDeltaFlushSchedulerForTest,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";

// The transcript cache is written by the module-singleton SSE sync and only
// observed by the mounted SessionSurface. When the user switches to another
// session while this one is still streaming, the transcript query has zero
// observers but events keep arriving (the session stays tracked/retained).
//
// TanStack GC is scheduled on query creation and when the last observer
// leaves; `Query.setData` never reschedules it. With a bounded gcTime the
// transcript was deleted mid-stream, the next delta flush rebuilt it from []
// without the in-flight text part, and every later delta was parked in
// pendingDeltas — invisible until the terminal message.part.updated arrived
// with the full text. The user saw a stalled conversation on return that
// "finished" all at once.

const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
const previousQueryClient = Reflect.get(globalThis, "__owReactQueryClient");
const key = transcriptKey("workspace-a", "session-a");

function transcript() {
  return getReactQueryClient().getQueryData<UIMessage[]>(key);
}

function hasTranscriptQuery() {
  return getReactQueryClient().getQueryCache().find({ queryKey: key, exact: true }) !== undefined;
}

function textPart(text: string) {
  return { id: "part-text", messageID: "msg-a", sessionID: "session-a", type: "text" as const, text };
}

function delta(text: string) {
  __applySessionSyncEventForTest(syncInput, {
    type: "message.part.delta",
    properties: { sessionID: "session-a", messageID: "msg-a", partID: "part-text", field: "text", delta: text },
  });
}

beforeEach(() => {
  Reflect.deleteProperty(globalThis, "__owReactQueryClient");
  jest.useFakeTimers();
  // Flush deltas synchronously so the test observes exactly one commit per event.
  __setSessionSyncDeltaFlushSchedulerForTest((_lane, flush) => {
    flush();
    return () => {};
  });
  useSessionActivityStore.getState().removeSession("workspace-a", "session-a");
});

afterEach(() => {
  __setSessionSyncDeltaFlushSchedulerForTest(null);
  jest.useRealTimers();
  getReactQueryClient().clear();
});

afterAll(() => {
  if (previousQueryClient === undefined) Reflect.deleteProperty(globalThis, "__owReactQueryClient");
  else Reflect.set(globalThis, "__owReactQueryClient", previousQueryClient);
});

describe("background session transcript", () => {
  test("deltas keep landing after the user has been away longer than any gc window", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a", time: { created: 1 } } },
      });
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Hel") } });
      delta("lo");
      expect(transcript()?.[0]?.parts).toMatchObject([{ type: "text", text: "Hello", state: "streaming" }]);

      // User switches to another session: the surface's observer leaves, the
      // sync keeps the session retained because the run is still live.
      release();
      jest.advanceTimersByTime(60_000);
      expect(hasTranscriptQuery()).toBe(true);

      // Deltas streamed while away must extend the existing part, not be
      // parked against a rebuilt empty transcript.
      delta(", world");
      delta("!");
      expect(transcript()?.[0]?.parts).toMatchObject([{ type: "text", text: "Hello, world!", state: "streaming" }]);

      // Coming back re-tracks the session and sees the up-to-date text.
      const retrack = trackWorkspaceSessionSync(syncInput, "session-a");
      expect(transcript()).toMatchObject([{ id: "msg-a", role: "assistant", parts: [{ type: "text", text: "Hello, world!" }] }]);
      retrack();
    } finally {
      cleanup();
    }
  });

  test("an old endpoint cannot release the replacement endpoint's conversation", () => {
    const replacement = { ...syncInput, baseUrl: "http://127.0.0.1:1235" };
    const cleanupOld = __createWorkspaceSessionSyncForTest(syncInput);
    const cleanupNew = __createWorkspaceSessionSyncForTest(replacement);
    const releaseOld = trackWorkspaceSessionSync(syncInput, "session-a");
    const releaseNew = trackWorkspaceSessionSync(replacement, "session-a");
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a", time: { created: 1 } } },
      });
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Done") } });
      const current = transcript();
      releaseOld();
      __applySessionSyncEventForTest(syncInput, { type: "session.idle", properties: { sessionID: "session-a" } });
      jest.advanceTimersByTime(10_001);
      expect(transcript()).toBe(current);

      releaseNew();
      __applySessionSyncEventForTest(replacement, { type: "session.idle", properties: { sessionID: "session-a" } });
      jest.advanceTimersByTime(10_001);
      expect(hasTranscriptQuery()).toBe(false);
    } finally {
      cleanupOld();
      cleanupNew();
    }
  });

  test("tracked-session lifecycle owns transcript cleanup once the run is idle", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a", time: { created: 1 } } },
      });
      __applySessionSyncEventForTest(syncInput, { type: "message.part.updated", properties: { part: textPart("Done") } });
      release();
      expect(hasTranscriptQuery()).toBe(true);

      __applySessionSyncEventForTest(syncInput, { type: "session.idle", properties: { sessionID: "session-a" } });
      // Idle shrinks retention to a short grace window; when it elapses the
      // transcript is released with the rest of the session caches.
      jest.advanceTimersByTime(10_001);
      expect(hasTranscriptQuery()).toBe(false);
    } finally {
      cleanup();
    }
  });
});
