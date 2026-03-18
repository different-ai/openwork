import { describe, expect, test, beforeEach } from "bun:test";
import { TokenService } from "./tokens.js";
import type { ServerConfig } from "./types.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

function createTestConfig(): ServerConfig {
  const tempDir = join(
    tmpdir(),
    `openwork-token-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return {
    host: "127.0.0.1",
    port: 8787,
    token: "test-client-token",
    hostToken: "test-host-token",
    configPath: join(tempDir, "server.json"),
    approval: { mode: "auto", timeoutMs: 30000 },
    corsOrigins: ["*"],
    workspaces: [],
    authorizedRoots: [],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

describe("TokenService", () => {
  let service: TokenService;

  beforeEach(() => {
    service = new TokenService(createTestConfig());
  });

  test("starts with empty token list", async () => {
    const list = await service.list();
    expect(list).toEqual([]);
  });

  test("creates a token with correct scope", async () => {
    const result = await service.create("collaborator");
    expect(result.scope).toBe("collaborator");
    expect(result.token).toMatch(/^owt_/);
    expect(result.id).toBeTruthy();
    expect(result.createdAt).toBeGreaterThan(0);
  });

  test("created token appears in list", async () => {
    await service.create("owner", { label: "My token" });
    const list = await service.list();
    expect(list.length).toBe(1);
    expect(list[0].scope).toBe("owner");
    expect(list[0].label).toBe("My token");
    // Hash should not be in the list output
    expect((list[0] as Record<string, unknown>).hash).toBeUndefined();
  });

  test("resolves scope for created token", async () => {
    const { token } = await service.create("viewer");
    const scope = await service.scopeForToken(token);
    expect(scope).toBe("viewer");
  });

  test("resolves scope for built-in client token", async () => {
    const scope = await service.scopeForToken("test-client-token");
    expect(scope).toBe("collaborator");
  });

  test("returns null for unknown token", async () => {
    const scope = await service.scopeForToken("unknown-token");
    expect(scope).toBeNull();
  });

  test("revokes a token", async () => {
    const { id, token } = await service.create("collaborator");
    const revoked = await service.revoke(id);
    expect(revoked).toBe(true);

    const scope = await service.scopeForToken(token);
    expect(scope).toBeNull();
  });

  test("revoke returns false for non-existent token", async () => {
    const revoked = await service.revoke("non-existent-id");
    expect(revoked).toBe(false);
  });

  test("multiple tokens with different scopes", async () => {
    const owner = await service.create("owner");
    const collab = await service.create("collaborator");
    const viewer = await service.create("viewer");

    expect(await service.scopeForToken(owner.token)).toBe("owner");
    expect(await service.scopeForToken(collab.token)).toBe("collaborator");
    expect(await service.scopeForToken(viewer.token)).toBe("viewer");

    const list = await service.list();
    expect(list.length).toBe(3);
  });
});
