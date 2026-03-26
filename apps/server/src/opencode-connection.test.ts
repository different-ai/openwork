import { describe, expect, test } from "bun:test";

import { inheritWorkspaceOpencodeConnection, resolveWorkspaceOpencodeConnection } from "./opencode-connection.js";

describe("resolveWorkspaceOpencodeConnection", () => {
  test("falls back to server-level OpenCode settings when a workspace entry is missing them", () => {
    const connection = resolveWorkspaceOpencodeConnection(
      {
        opencodeBaseUrl: "http://127.0.0.1:54235",
        opencodeUsername: "user",
        opencodePassword: "pass",
      },
      {
        id: "ws_test",
        name: "Test",
        path: "/tmp/test",
        preset: "starter",
        workspaceType: "local",
      },
    );

    expect(connection.baseUrl).toBe("http://127.0.0.1:54235");
    expect(connection.authHeader).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
  });

  test("prefers workspace-specific settings when present", () => {
    const connection = resolveWorkspaceOpencodeConnection(
      {
        opencodeBaseUrl: "http://127.0.0.1:54235",
        opencodeUsername: "user",
        opencodePassword: "pass",
      },
      {
        id: "ws_test",
        name: "Test",
        path: "/tmp/test",
        preset: "starter",
        workspaceType: "local",
        baseUrl: "http://127.0.0.1:6000",
        opencodeUsername: "local-user",
        opencodePassword: "local-pass",
      },
    );

    expect(connection.baseUrl).toBe("http://127.0.0.1:6000");
    expect(connection.authHeader).toBe(`Basic ${Buffer.from("local-user:local-pass").toString("base64")}`);
  });
});

describe("inheritWorkspaceOpencodeConnection", () => {
  test("copies server-level OpenCode connection into new local workspaces", () => {
    expect(
      inheritWorkspaceOpencodeConnection({
        opencodeBaseUrl: "http://127.0.0.1:54235",
        opencodeUsername: "user",
        opencodePassword: "pass",
      }),
    ).toEqual({
      baseUrl: "http://127.0.0.1:54235",
      opencodeUsername: "user",
      opencodePassword: "pass",
    });
  });
});
