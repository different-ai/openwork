import { describe, expect, test } from "bun:test";

import {
  mergeTransformInputWithFactoryContext,
  normalizeOpenCodeContext,
  readContext,
  readEngineMcpStatusClient,
  readProviderModel,
} from "./context.js";

describe("OpenCode context helpers", () => {
  test("normalizes every supported direct context property", () => {
    expect(normalizeOpenCodeContext({
      agent: "agent",
      sessionID: "session",
      messageID: "message",
      directory: "/workspace",
      worktree: "/worktree",
      workspaceId: "workspace-lower",
      workspaceID: "workspace-upper",
      ignored: "value",
    })).toEqual({
      agent: "agent",
      sessionID: "session",
      messageID: "message",
      directory: "/workspace",
      worktree: "/worktree",
      workspaceId: "workspace-lower",
      workspaceID: "workspace-upper",
    });
  });

  test("uses a nested context record and preserves accepted property whitespace", () => {
    expect(normalizeOpenCodeContext({
      directory: "/outer",
      context: {
        directory: "  /nested  ",
        worktree: "   ",
      },
    })).toEqual({ directory: "  /nested  " });
    expect(normalizeOpenCodeContext({ context: "not-a-record", directory: "/outer" })).toEqual({
      directory: "/outer",
    });
    expect(normalizeOpenCodeContext(null)).toEqual({});
  });

  test("returns the original transform input when factory context is empty", () => {
    const input = { context: { directory: "/input" } };
    expect(mergeTransformInputWithFactoryContext(input, {})).toBe(input);
    expect(mergeTransformInputWithFactoryContext("input", {})).toBe("input");
  });

  test("merges factory context below transform context", () => {
    expect(mergeTransformInputWithFactoryContext({
      sessionID: "session",
      context: {
        directory: "/input",
        messageID: "message",
      },
    }, {
      directory: "/factory",
      worktree: "/worktree",
    })).toEqual({
      sessionID: "session",
      context: {
        directory: "/input",
        worktree: "/worktree",
        messageID: "message",
      },
    });

    expect(mergeTransformInputWithFactoryContext(null, { directory: "/factory" })).toEqual({
      context: { directory: "/factory" },
    });
  });

  test("reads context using the existing source precedence and trims strings", () => {
    expect(readContext({
      directory: "  /direct  ",
      worktree: "  /direct-worktree  ",
      workspaceID: "  direct-workspace  ",
      context: {
        directory: "/context",
        worktree: "/context-worktree",
        workspaceId: "context-workspace",
      },
      session: {
        directory: "/session",
        worktree: "/session-worktree",
      },
    })).toEqual({
      directory: "/direct",
      worktree: "/direct-worktree",
      workspaceId: "direct-workspace",
    });

    expect(readContext({
      context: { directory: "/context", workspaceID: "context-workspace" },
      session: { directory: "/session", worktree: "/session-worktree" },
    })).toEqual({
      directory: "/context",
      worktree: "/session-worktree",
      workspaceId: "context-workspace",
    });
    expect(readContext(null)).toEqual({});
  });

  test("reads provider and model from structured aliases", () => {
    expect(readProviderModel({ model: { providerID: "  anthropic  ", modelID: "  claude-sonnet-4  " } })).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    expect(readProviderModel({ model: { provider: "openai", id: "gpt-5" } })).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    expect(readProviderModel({ provider: "google", modelID: "gemini-2.5-pro" })).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
    });
  });

  test("reads slash-delimited provider models from each fallback", () => {
    expect(readProviderModel({ modelID: "anthropic/claude/sonnet" })).toEqual({
      provider: "anthropic",
      model: "claude/sonnet",
    });
    expect(readProviderModel({ model: " openai/gpt-5 " })).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    expect(readProviderModel({ model: { name: "google/gemini-2.5-pro" } })).toEqual({
      provider: "google",
      model: "gemini-2.5-pro",
    });
    expect(readProviderModel({ model: "missing-provider" })).toBeUndefined();
    expect(readProviderModel({ model: "/missing-provider" })).toBeUndefined();
  });

  test("reads an MCP status client and preserves the method receiver", async () => {
    const calls: unknown[] = [];
    const mcp = {
      prefix: "mcp",
      async status(request?: unknown) {
        calls.push({ receiver: this.prefix, request });
        return { ok: true };
      },
    };
    const client = readEngineMcpStatusClient({ client: { mcp } });

    expect(client).toBeDefined();
    await expect(client?.mcp.status({ query: { directory: "/workspace" } })).resolves.toEqual({ ok: true });
    expect(calls).toEqual([{
      receiver: "mcp",
      request: { query: { directory: "/workspace" } },
    }]);
  });

  test("rejects incomplete MCP status clients", () => {
    expect(readEngineMcpStatusClient(null)).toBeUndefined();
    expect(readEngineMcpStatusClient({ client: {} })).toBeUndefined();
    expect(readEngineMcpStatusClient({ client: { mcp: {} } })).toBeUndefined();
    expect(readEngineMcpStatusClient({ client: { mcp: { status: "connected" } } })).toBeUndefined();
  });
});
