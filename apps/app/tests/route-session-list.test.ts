import { describe, expect, test } from "bun:test";

import { resolveWorkspaceEndpoint } from "../src/app/lib/workspace-endpoint";
import { listRouteSessions, readRouteSessionsWithRetry } from "../src/react-app/shell/route-workspaces";

describe("workspace route native session lists", () => {
  test("loads a bare session array through the local native transport input", async () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "local workspace",
      workspaceType: "local",
    }, {
      baseUrl: "https://local.example.test",
      token: "local-token",
    });
    if (!endpoint) throw new Error("Expected a local endpoint");

    const inputs: unknown[] = [];

    await expect(listRouteSessions(endpoint, async (input) => {
      inputs.push(input);
      return {
        data: [{ id: "ses_local", directory: "/tmp/local" }],
        request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
        response: Response.json([{ id: "ses_local", directory: "/tmp/local" }]),
      };
    })).resolves.toEqual([
      { id: "ses_local", directory: "/tmp/local" },
    ]);
    expect(inputs).toEqual([{ endpoint, limit: 200 }]);
    expect(endpoint.opencodeBaseUrl).toBe("https://local.example.test/workspace/local%20workspace/opencode");
    expect(endpoint.token).toBe("local-token");
  });

  test("retries a remote native list failure on the remote endpoint and token", async () => {
    const endpoint = resolveWorkspaceEndpoint({
      id: "rem_ui-id",
      workspaceType: "remote",
      baseUrl: "https://remote.example.test/worker",
      openworkToken: "remote-token",
      openworkWorkspaceId: "server/id",
    }, {
      baseUrl: "https://local.example.test",
      token: "local-token",
    });
    if (!endpoint) throw new Error("Expected a remote endpoint");

    const inputs: unknown[] = [];
    const waits: number[] = [];

    await expect(readRouteSessionsWithRetry({
      load: () => listRouteSessions(endpoint, async (input) => {
        inputs.push(input);
        const response = inputs.length === 1
          ? Response.json({ code: "opencode_engine_unreachable", message: "engine starting" }, { status: 503 })
          : Response.json([{ id: "ses_remote", directory: "/workspace/remote" }]);
        return inputs.length === 1
          ? {
              error: { code: "opencode_engine_unreachable", message: "engine starting" },
              request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
              response,
            }
          : {
              data: [{ id: "ses_remote", directory: "/workspace/remote" }],
              request: new Request(`${endpoint.opencodeBaseUrl}/session?limit=200`),
              response,
            };
      }),
      retryDelaysMs: [250],
      wait: async (delayMs) => { waits.push(delayMs); },
    })).resolves.toEqual([{ id: "ses_remote", directory: "/workspace/remote" }]);
    expect(waits).toEqual([250]);
    expect(inputs).toEqual([
      { endpoint, limit: 200 },
      { endpoint, limit: 200 },
    ]);
    expect(endpoint.opencodeBaseUrl).toBe("https://remote.example.test/worker/workspace/server%2Fid/opencode");
    expect(endpoint.token).toBe("remote-token");
  });
});
