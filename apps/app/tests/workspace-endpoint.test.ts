import { describe, expect, test } from "bun:test";

import { resolveWorkspaceEndpoint, workspaceServerId } from "../src/app/lib/workspace-endpoint";

describe("workspace endpoint resolution", () => {
  test("local workspaces use the local server and local workspace id", () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "ws_local",
      name: "Local",
      path: "/tmp/ws-local",
      preset: "minimal",
      workspaceType: "local",
    }, {
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token",
    });

    expect(endpoint?.workspaceId).toBe("ws_local");
    expect(endpoint?.baseUrl).toBe("http://127.0.0.1:4096");
    expect(endpoint?.isRemote).toBe(false);
    expect(endpoint?.mountedBaseUrl).toBe("http://127.0.0.1:4096/workspace/ws_local");
  });

  test("remote workspaces use the owning worker URL and server-side workspace id", () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_ui-workspace-b",
      name: "Remote",
      path: "/workspace/server-workspace-b",
      preset: "minimal",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
      openworkToken: "remote-token",
      openworkWorkspaceId: "server-workspace-b",
    }, {
      baseUrl: "http://127.0.0.1:4096",
      token: "local-token",
    });

    expect(endpoint?.workspaceId).toBe("server-workspace-b");
    expect(endpoint?.baseUrl).toBe("https://worker.example.test");
    expect(endpoint?.isRemote).toBe(true);
    expect(endpoint?.mountedBaseUrl).toBe("https://worker.example.test/workspace/server-workspace-b");
  });

  test("remote workspace ids fall back to stripping rem_ when no explicit server id exists", () => {
    expect(workspaceServerId({
      id: "rem_workspace-c",
      name: "Remote fallback",
      path: "/workspace/workspace-c",
      preset: "minimal",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
    })).toBe("workspace-c");
  });
});
