import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { UIMessage } from "ai";
import type { OpenWorkSessionStreamFrame } from "@openwork/session-contracts";

import { OpenworkSessionEventStreamError } from "../src/app/lib/openwork-server";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionStreamFrameForTest,
  __createWorkspaceSessionSyncForTest,
  __getUnknownSessionEventDiagnosticsForTest,
  __resetUnknownSessionEventDiagnosticsForTest,
  __shouldUseLegacySessionEventStreamForTest,
  snapshotKey,
  statusKey,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";

const syncInput = {
  workspaceId: "workspace-a",
  baseUrl: "http://127.0.0.1:1234/workspace/workspace-a/opencode",
  openworkBaseUrl: "http://127.0.0.1:1234",
  openworkToken: "token",
};

function eventFrame(event: Extract<OpenWorkSessionStreamFrame, { kind: "event" }>['event']): OpenWorkSessionStreamFrame {
  return {
    schemaVersion: 1,
    kind: "event",
    workspaceId: "workspace-a",
    source: {
      adapterId: "builtin/opencode",
      eventType: event.kind === "compatibility" ? event.sourceType : event.kind,
    },
    event,
  };
}

afterEach(() => {
  getReactQueryClient().clear();
  __resetUnknownSessionEventDiagnosticsForTest();
});

describe("canonical session event sync", () => {
  test("applies normalized updates through the same snapshot behavior", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    getReactQueryClient().setQueryData(snapshotKey("workspace-a", "session-a"), {
      session: { id: "session-a", revert: { messageID: "old" } },
      messages: [],
      todos: [],
      status: { type: "idle" },
    });

    try {
      __applySessionStreamFrameForTest(syncInput, eventFrame({
        kind: "session.updated",
        sessionId: "session-a",
        info: { id: "session-a", revert: { messageID: "msg-user" } },
      }));

      expect(getReactQueryClient().getQueryData(snapshotKey("workspace-a", "session-a"))).toMatchObject({
        session: { id: "session-a", revert: { messageID: "msg-user" } },
      });
    } finally {
      release();
      cleanup();
    }
  });

  test("applies normalized failures with stable user-facing detail", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    getReactQueryClient().setQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"), [
      { id: "msg-user", role: "user", parts: [{ type: "text", text: "go" }] },
      { id: "msg-assistant", role: "assistant", parts: [{ type: "text", text: "partial" }] },
    ]);

    try {
      __applySessionStreamFrameForTest(syncInput, eventFrame({
        kind: "session.failed",
        sessionId: "session-a",
        failure: {
          code: "upstream_api",
          message: "Rate limited",
          retryable: true,
          providerId: "openai",
          statusCode: 429,
          responseBody: "try later",
          retries: 2,
        },
      }));

      const transcript = getReactQueryClient().getQueryData<UIMessage[]>(
        transcriptKey("workspace-a", "session-a"),
      );
      expect(transcript).toHaveLength(3);
      const errorPart = transcript?.[2]?.parts[0];
      const errorText = errorPart && "text" in errorPart ? errorPart.text : undefined;
      expect(typeof errorText).toBe("string");
      expect(errorText as string).toContain("Rate limited");
      expect(errorText as string).toContain("Status: 429");
      expect(errorText as string).toContain("Provider: openai");
      expect(errorText as string).toContain("Retries: 2");
    } finally {
      release();
      cleanup();
    }
  });

  test("routes compatibility frames through existing behavior", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    try {
      __applySessionStreamFrameForTest(syncInput, eventFrame({
        kind: "compatibility",
        sourceType: "session.status",
        properties: { sessionID: "session-a", status: { type: "busy" } },
      }));
      expect(getReactQueryClient().getQueryData(statusKey("workspace-a", "session-a"))).toEqual({
        type: "busy",
      });
    } finally {
      release();
      cleanup();
    }
  });

  test("records unknown diagnostics once and performs no cache mutation", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");
    const before = [{ id: "msg-user", role: "user", parts: [{ type: "text", text: "unchanged" }] }] as UIMessage[];
    getReactQueryClient().setQueryData(transcriptKey("workspace-a", "session-a"), before);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const frame = eventFrame({
      kind: "unknown",
      sourceType: "session.future",
      reason: "unsupported_type",
    });

    try {
      __applySessionStreamFrameForTest(syncInput, frame);
      __applySessionStreamFrameForTest(syncInput, frame);
      expect(getReactQueryClient().getQueryData(transcriptKey("workspace-a", "session-a"))).toEqual(before);
      expect(__getUnknownSessionEventDiagnosticsForTest().get(
        "builtin/opencode:session.future:unsupported_type",
      )).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      release();
      cleanup();
    }
  });

  test("bounds diagnostics for untrusted unknown source types", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (let index = 0; index < 130; index += 1) {
        __applySessionStreamFrameForTest(syncInput, eventFrame({
          kind: "unknown",
          sourceType: `session.future.${index}`,
          reason: "unsupported_type",
        }));
      }
      const diagnostics = __getUnknownSessionEventDiagnosticsForTest();
      expect(diagnostics.size).toBe(128);
      expect(diagnostics.get("builtin/opencode:session.future.0:unsupported_type")).toBe(1);
      expect(diagnostics.get("builtin/opencode:session.future.126:unsupported_type")).toBe(1);
      expect(diagnostics.has("builtin/opencode:session.future.127:unsupported_type")).toBe(false);
      expect(diagnostics.get("__overflow__")).toBe(3);
      expect(warn).toHaveBeenCalledTimes(128);
    } finally {
      warn.mockRestore();
      cleanup();
    }
  });

  test("treats stable stream error frames as retry-policy errors", () => {
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    try {
      expect(() => __applySessionStreamFrameForTest(syncInput, {
        schemaVersion: 1,
        kind: "stream.error",
        workspaceId: "workspace-a",
        source: { adapterId: "builtin/opencode", eventType: "stream.error" },
        error: {
          code: "OPENWORK_SESSION_STREAM_FORBIDDEN",
          message: "Forbidden",
          retryable: false,
          status: 403,
        },
      })).toThrow(OpenworkSessionEventStreamError);
    } finally {
      cleanup();
    }
  });

  test("allows legacy fallback only for old-server route statuses", () => {
    for (const status of [404, 405, 501]) {
      expect(__shouldUseLegacySessionEventStreamForTest(status)).toBe(true);
    }
    for (const status of [0, 400, 401, 403, 409, 429, 500, 502, 503]) {
      expect(__shouldUseLegacySessionEventStreamForTest(status)).toBe(false);
    }
  });
});
