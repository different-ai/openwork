import { describe, expect, test } from "bun:test";

import type { WorkspaceInfo } from "../src/app/lib/desktop";
import { stripOpenworkWorkspaceMount } from "../src/app/lib/openwork-server";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";

describe("stripOpenworkWorkspaceMount", () => {
  test("strips trailing workspace mounts", () => {
    expect(stripOpenworkWorkspaceMount("https://worker.example.test/base/workspace/ws_123")).toBe("https://worker.example.test/base");
    expect(stripOpenworkWorkspaceMount("https://worker.example.test/base/w/ws_123")).toBe("https://worker.example.test/base");
    expect(stripOpenworkWorkspaceMount("https://worker.example.test/base/workspace/ws_123/api")).toBe("https://worker.example.test/base");
  });

  test("preserves non-mount path segments named workspace", () => {
    expect(stripOpenworkWorkspaceMount("https://worker.example.test/base/workspace/docs/api")).toBe("https://worker.example.test/base/workspace/docs/api");
  });
});

describe("resolveWorkspaceEndpoint", () => {
  test("strips stale OpenWork workspace mounts before composing endpoint URLs", () => {
    const workspace: WorkspaceInfo = {
      id: "rem_ws_123",
      name: "Remote workspace",
      path: "",
      preset: "remote",
      workspaceType: "remote",
      remoteType: "openwork",
      baseUrl: "https://worker.example.test/base/workspace/ws_123",
      openworkToken: "client-token",
    };

    const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl: "http://127.0.0.1:8787", token: null });

    expect(endpoint?.baseUrl).toBe("https://worker.example.test/base");
    expect(endpoint?.workspaceId).toBe("ws_123");
    expect(endpoint?.mountedBaseUrl).toBe("https://worker.example.test/base/workspace/ws_123");
  });
});
