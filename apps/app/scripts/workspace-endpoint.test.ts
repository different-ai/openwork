import { describe, expect, test } from "bun:test";
import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";

describe("resolveWorkspaceEndpoint", () => {
  test("does not use remote host token as bearer authorization", () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_ws_123",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
      openworkHostUrl: "https://worker.example.test",
      openworkToken: null,
      openworkClientToken: null,
      openworkHostToken: "host-token-must-not-be-bearer",
      openworkWorkspaceId: "ws_123",
    } as never, { baseUrl: "http://127.0.0.1:8791", token: "local-token" });

    expect(endpoint?.token).toBe("");
  });

  test("uses remote client token before local server token", () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_ws_123",
      workspaceType: "remote",
      baseUrl: "https://worker.example.test",
      openworkHostUrl: "https://worker.example.test",
      openworkToken: null,
      openworkClientToken: "remote-client-token",
      openworkHostToken: "host-token",
      openworkWorkspaceId: "ws_123",
    } as never, { baseUrl: "http://127.0.0.1:8791", token: "local-token" });

    expect(endpoint?.token).toBe("remote-client-token");
  });
});
