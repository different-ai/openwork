import { afterEach, describe, expect, test } from "bun:test";
import type { Part, Session } from "@opencode-ai/sdk/v2/client";
import type { UIMessage } from "ai";

import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  trackWorkspaceSessionSync,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import {
  parseDynamicToolUIPart,
  parseStructuredOutputUIPart,
} from "../src/react-app/domains/session/sync/parse-tool-parts";
import { parseOpenWorkSessionCreateResult } from "../src/components/tools/openwork-session-create";

afterEach(() => {
  getReactQueryClient().clear();
});

function writeToolPart(
  status: "pending" | "running" | "completed" | "error",
  input: Record<string, unknown>,
  overrides: Partial<Extract<Part, { type: "tool" }>> = {},
  error = "failed",
): Extract<Part, { type: "tool" }> {
  const base = {
    id: "part-write",
    sessionID: "session-a",
    messageID: "msg-a",
    type: "tool" as const,
    callID: "call-write",
    tool: "write",
  };

  if (status === "completed") {
    return {
      ...base,
      ...overrides,
      state: {
        status: "completed",
        input,
        output: "ok",
        title: "Write",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    };
  }

  if (status === "error") {
    return {
      ...base,
      ...overrides,
      state: {
        status: "error",
        input,
        error,
        time: { start: 1, end: 2 },
      },
    };
  }

  if (status === "running") {
    return {
      ...base,
      ...overrides,
      state: {
        status: "running",
        input,
        time: { start: 1 },
      },
    };
  }

  return {
    ...base,
    ...overrides,
    state: {
      status: "pending",
      input,
      raw: "",
    },
  };
}

describe("tool part mapper", () => {
  test("defers in-progress tools with empty input", () => {
    // shouldDeferInProgressTool left with the legacy message list (#2016);
    // the deferral behavior itself is still pinned here via the parser and
    // end-to-end below via session sync.
    expect(parseDynamicToolUIPart(writeToolPart("pending", {}))).toBeNull();
    expect(parseDynamicToolUIPart(writeToolPart("running", {}))).toBeNull();
  });

  test("maps in-progress tools with partial input as input-streaming", () => {
    const part = writeToolPart("running", { content: "hello" });
    expect(parseDynamicToolUIPart(part)).toMatchObject({
      type: "dynamic-tool",
      toolName: "write",
      state: "input-streaming",
      input: { content: "hello" },
    });
  });

  test("maps completed tools", () => {
    const part = writeToolPart("completed", { content: "hello", filePath: "src/a.ts" });
    expect(parseDynamicToolUIPart(part)).toMatchObject({
      state: "output-available",
      input: { content: "hello", filePath: "src/a.ts" },
      output: "ok",
    });
  });

  test("preserves MCP Apps result metadata for the chat host", () => {
    const part = writeToolPart("completed", { configObjectId: "script_1" });
    if (part.state.status !== "completed") throw new Error("Expected completed fixture");
    part.state.metadata = {
      openworkMcpApp: {
        content: [{ type: "text", text: "Fallback" }],
        structuredContent: { schemaVersion: "1", value: 42 },
        _meta: { receiptId: "receipt_1" },
      },
    };

    expect(parseDynamicToolUIPart(part)?.callProviderMetadata).toEqual({
      opencode: { partId: "part-write" },
      openwork: {
        mcpResult: {
          content: [{ type: "text", text: "Fallback" }],
          structuredContent: { schemaVersion: "1", value: 42 },
          _meta: { receiptId: "receipt_1" },
        },
      },
    });
  });

  test("forwards the task tool's sub-agent session id for chat navigation", () => {
    const running = writeToolPart(
      "running",
      { description: "Explore", prompt: "look around", subagent_type: "explore" },
      { id: "part-task", tool: "task", callID: "call-task" },
    );
    if (running.state.status !== "running") throw new Error("Expected running fixture");
    running.state.metadata = { sessionId: "ses_child_1", model: { providerID: "p", modelID: "m" } };

    expect(parseDynamicToolUIPart(running)?.callProviderMetadata).toEqual({
      opencode: { partId: "part-task" },
      openwork: { childSessionId: "ses_child_1" },
    });

    const completed = writeToolPart(
      "completed",
      { description: "Explore", prompt: "look around", subagent_type: "explore" },
      { id: "part-task", tool: "task", callID: "call-task" },
    );
    if (completed.state.status !== "completed") throw new Error("Expected completed fixture");
    completed.state.metadata = { sessionId: "ses_child_1" };

    expect(parseDynamicToolUIPart(completed)?.callProviderMetadata).toEqual({
      opencode: { partId: "part-task" },
      openwork: { childSessionId: "ses_child_1" },
    });
  });

  test("does not forward session metadata for non-task tools", () => {
    const part = writeToolPart("completed", { filePath: "src/a.ts" });
    if (part.state.status !== "completed") throw new Error("Expected completed fixture");
    part.state.metadata = { sessionId: "ses_child_1" };

    expect(parseDynamicToolUIPart(part)?.callProviderMetadata).toEqual({
      opencode: { partId: "part-write" },
    });
  });

  test("recovers a connection-action MCP App from an errored capability result", () => {
    const error = JSON.stringify({
      error: "needs_connection",
      message: "Connect Acme Tracker.",
      connectionStatus: {
        connectionId: "emc_acme",
        connectionName: "Acme Tracker",
        state: "needs_connection",
        actor: "member",
        message: "Acme Tracker is not connected.",
        action: {
          type: "connect",
          label: "Connect Acme Tracker",
          surface: "openwork_your_connections",
          url: "https://app.openworklabs.com/dashboard/your-connections?connectionId=emc_acme",
        },
      },
    });

    expect(parseDynamicToolUIPart(writeToolPart("error", {}, {}, error))).toMatchObject({
      state: "output-error",
      callProviderMetadata: {
        openwork: {
          mcpResult: {
            structuredContent: {
              schemaVersion: "1",
              connectionId: "emc_acme",
              state: "needs_connection",
            },
            _meta: {
              "openwork/mcpApp": {
                toolName: "connection_action",
                resourceUri: "ui://openwork/connection-action/v1/view.html",
                arguments: { connectionId: "emc_acme" },
              },
            },
          },
        },
      },
    });
  });

  test("summarizes and clamps huge HTML tool errors at ingestion", () => {
    const htmlError = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>${"x".repeat(1_024 * 1_024)}</body></html>`;
    const parsed = parseDynamicToolUIPart(writeToolPart("error", {}, {}, htmlError));

    expect(parsed?.state).toBe("output-error");
    if (!parsed || parsed.state !== "output-error") throw new Error("Expected a parsed tool error");
    expect(parsed.errorText).toContain("Upstream returned an HTML error page (502 Bad Gateway)");
    expect(parsed.errorText.length).toBeLessThanOrEqual(4_096);
    expect(parsed.errorText.toLowerCase()).not.toContain("<!doctype");
  });

  test("maps env var request tools for rich chat rendering", () => {
    const part = writeToolPart("running", { key: "NOTION_TOKEN" }, { tool: "request_env_var" });
    expect(parseDynamicToolUIPart(part)).toMatchObject({
      type: "dynamic-tool",
      toolName: "request_env_var",
      input: { key: "NOTION_TOKEN" },
    });
  });

  test("parses session creation output for rich chat rendering", () => {
    expect(parseOpenWorkSessionCreateResult(JSON.stringify({
      ok: true,
      workspaceId: "workspace-a",
      workspace: "Research",
      created: [{
        sessionId: "session-dolphins",
        title: "Dolphin research",
        started: true,
        route: "/workspace/workspace-a/session/session-dolphins",
      }],
      failures: [],
    }))).toEqual({
      ok: true,
      workspaceId: "workspace-a",
      workspace: "Research",
      created: [{
        sessionId: "session-dolphins",
        title: "Dolphin research",
        started: true,
        route: "/workspace/workspace-a/session/session-dolphins",
      }],
      failures: [],
    });
  });

  test("skips empty structured output while streaming", () => {
    const part = writeToolPart("running", {}, { tool: "StructuredOutput" });
    expect(parseStructuredOutputUIPart(part)).toBeNull();
    expect(Object.keys(part.state.input).length).toBe(0);
  });

  test("keeps completed structured output even when input is {}", () => {
    const part = writeToolPart("completed", {}, { tool: "StructuredOutput" });
    expect(parseStructuredOutputUIPart(part)).toMatchObject({
      type: "text",
      text: "{}",
      state: "done",
    });
  });

  test("session sync defers empty in-progress write tools until input arrives", () => {
    const syncInput = { workspaceId: "workspace-a", baseUrl: "http://127.0.0.1:1234", openworkToken: "token" };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);
    const release = trackWorkspaceSessionSync(syncInput, "session-a");

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "message.updated",
        properties: { info: { id: "msg-a", role: "assistant", sessionID: "session-a" } },
      } as any);
      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: { part: writeToolPart("pending", {}) },
      } as any);

      let transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts ?? []).toEqual([]);

      __applySessionSyncEventForTest(syncInput, {
        type: "message.part.updated",
        properties: {
          part: writeToolPart("running", { content: "hello", filePath: "src/main.ts" }),
        },
      } as any);

      transcript = getReactQueryClient().getQueryData<UIMessage[]>(transcriptKey("workspace-a", "session-a"));
      expect(transcript?.[0]?.parts[0]).toMatchObject({
        type: "dynamic-tool",
        toolName: "write",
        state: "input-streaming",
        input: { content: "hello", filePath: "src/main.ts" },
      });
    } finally {
      release();
      cleanup();
    }
  });

  test("delivers untracked session lifecycle events for sidebar synchronization", () => {
    const created: Session = {
      id: "session-created",
      slug: "session-created",
      projectID: "project-a",
      directory: "/tmp/workspace-a",
      title: "Created in the background",
      version: "1",
      time: { created: 1, updated: 1 },
    };
    const createdIds: string[] = [];
    const deletedIds: string[] = [];
    const syncInput = {
      workspaceId: "workspace-a",
      baseUrl: "http://127.0.0.1:1234",
      openworkToken: "token",
      onSessionCreated: (session: Session) => createdIds.push(session.id),
      onSessionDeleted: (sessionId: string) => deletedIds.push(sessionId),
    };
    const cleanup = __createWorkspaceSessionSyncForTest(syncInput);

    try {
      __applySessionSyncEventForTest(syncInput, {
        type: "session.created",
        properties: { sessionID: created.id, info: created },
      });
      __applySessionSyncEventForTest(syncInput, {
        type: "session.deleted",
        properties: { sessionID: created.id, info: created },
      });

      expect(createdIds).toEqual([created.id]);
      expect(deletedIds).toEqual([created.id]);
    } finally {
      cleanup();
    }
  });
});
