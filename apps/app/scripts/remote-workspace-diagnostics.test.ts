import { describe, expect, test } from "bun:test";

import type { OpenworkServerClient } from "../src/app/lib/openwork-server";
import type { WorkspaceInfo } from "../src/app/lib/desktop";
import { getWorkspaceTaskLoadErrorDisplay } from "../src/app/utils";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  redactRemoteDiagnosticText,
  resolveRemoteWorkspaceConnectionTarget,
  testRemoteWorkspaceConnection,
} from "../src/react-app/domains/workspace/remote-workspace-diagnostics";

function workspace(overrides: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    id: "ws_local",
    name: "Remote worker",
    path: "",
    preset: "remote",
    workspaceType: "remote",
    remoteType: "openwork",
    openworkHostUrl: "https://worker.example.com/w/ws_remote",
    openworkToken: "ow-token",
    ...overrides,
  };
}

function client(overrides: Partial<OpenworkServerClient> = {}): OpenworkServerClient {
  return {
    baseUrl: "https://worker.example.com/w/ws_remote",
    token: "ow-token",
    health: async () => ({ ok: true, version: "0.1.0", uptimeMs: 10 }),
    status: async () => ({
      ok: true,
      version: "0.1.0",
      uptimeMs: 10,
      readOnly: false,
      approval: { mode: "manual", timeoutMs: 30_000 },
      corsOrigins: [],
      workspaceCount: 1,
      activeWorkspaceId: "ws_remote",
      selectedWorkspaceId: "ws_remote",
      workspace: {
        id: "ws_remote",
        name: "Worker project",
        path: "/workspace",
        preset: "starter",
        workspaceType: "local",
      },
      authorizedRoots: ["/workspace"],
      server: { host: "127.0.0.1", port: 8787 },
      tokenSource: { client: "file", host: "file" },
    }),
    capabilities: async () => ({
      skills: { read: true, write: true, source: "openwork" },
      plugins: { read: true, write: true },
      mcp: { read: true, write: true },
      commands: { read: true, write: true },
      config: { read: true, write: true },
    }),
    listWorkspaces: async () => ({
      items: [
        {
          id: "ws_remote",
          name: "Worker project",
          path: "/workspace",
          preset: "starter",
          workspaceType: "local",
        },
      ],
      activeId: "ws_remote",
    }),
    ...overrides,
  } as OpenworkServerClient;
}

function serverError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

describe("resolveRemoteWorkspaceConnectionTarget", () => {
  test("builds a host-scoped OpenWork target from saved worker credentials", () => {
    const target = resolveRemoteWorkspaceConnectionTarget(
      workspace({
        openworkHostUrl: "https://worker.example.com",
        openworkWorkspaceId: "ws_remote",
      }),
    );

    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.target.baseUrl).toBe("https://worker.example.com");
    expect(target.target.workspaceId).toBe("ws_remote");
    expect(target.target.token).toBe("ow-token");
  });

  test("parses workspace id from a workspace-scoped connect URL", () => {
    const target = resolveRemoteWorkspaceConnectionTarget(workspace());

    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.target.workspaceId).toBe("ws_remote");
    expect(target.target.baseUrl).toBe("https://worker.example.com");
  });

  test("fails fast when a remote worker has no endpoint", () => {
    const target = resolveRemoteWorkspaceConnectionTarget(
      workspace({
        openworkHostUrl: "",
        baseUrl: "",
      }),
    );

    expect(target.ok).toBe(false);
    if (target.ok) return;
    expect(target.state.status).toBe("error");
    expect(target.state.message).toContain("URL is missing");
  });

  test("fails fast when a remote worker endpoint is invalid", () => {
    const target = resolveRemoteWorkspaceConnectionTarget(
      workspace({
        openworkHostUrl: "not a url",
      }),
    );

    expect(target.ok).toBe(false);
    if (target.ok) return;
    expect(target.state.status).toBe("error");
    expect(target.state.message).toContain("URL is invalid");
  });

  test("does not run OpenWork probes against non-OpenWork remote workspaces", () => {
    const target = resolveRemoteWorkspaceConnectionTarget(
      workspace({
        remoteType: "opencode",
        openworkHostUrl: "",
        openworkToken: "",
        baseUrl: "https://opencode.example.com",
      }),
    );

    expect(target.ok).toBe(false);
    if (target.ok) return;
    expect(target.state.status).toBe("error");
    expect(target.state.message).toContain("OpenWork remote workers");
  });

  test("does not run OpenWork probes against stale OpenWork fields on non-OpenWork remotes", () => {
    const target = resolveRemoteWorkspaceConnectionTarget(
      workspace({
        remoteType: "opencode",
        openworkHostUrl: "https://worker.example.com/w/ws_remote",
        openworkToken: "owt_secret",
        baseUrl: "https://opencode.example.com",
      }),
    );

    expect(target.ok).toBe(false);
    if (target.ok) return;
    expect(target.state.message).toContain("OpenWork remote workers");
  });
});

describe("testRemoteWorkspaceConnection", () => {
  test("returns a connected state after health, token, capabilities, and workspace checks pass", async () => {
    const result = await testRemoteWorkspaceConnection(workspace(), {
      now: () => 123,
      createClient: () => client(),
    });

    expect(result.ok).toBe(true);
    expect(result.state).toEqual({
      status: "connected",
      message: "Connected to Worker project.",
      checkedAt: 123,
    });
  });

  test("reports a missing token after proving the worker endpoint is reachable", async () => {
    const result = await testRemoteWorkspaceConnection(workspace({ openworkToken: "" }), {
      createClient: () => client(),
    });

    expect(result.ok).toBe(false);
    expect(result.state.status).toBe("error");
    expect(result.state.message).toContain("Token is missing");
    expect(result.state.message).toContain("Upgrade the OpenWork host");
    expect(result.state.message).toContain("team@openworklabs.com");
  });

  test("reports unhealthy health responses as endpoint failures", async () => {
    const result = await testRemoteWorkspaceConnection(workspace(), {
      createClient: () =>
        client({
          health: async () => ({ ok: false, version: "0.1.0", uptimeMs: 10 }),
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.state.status).toBe("error");
    expect(result.state.message).toContain("unhealthy response");
    expect(result.state.message).toContain("Upgrade the OpenWork host");
    expect(result.state.message).toContain("team@openworklabs.com");
  });

  test("uses fallback OpenWork tokens saved on older workspace records", async () => {
    const result = await testRemoteWorkspaceConnection(
      workspace({
        openworkToken: "",
        openworkClientToken: "legacy-client-token",
      }),
      {
        createClient: (target) => {
          expect(target.token).toBe("legacy-client-token");
          return client();
        },
      },
    );

    expect(result.ok).toBe(true);
  });

  test("reports rejected credentials without hiding the endpoint", async () => {
    const result = await testRemoteWorkspaceConnection(workspace(), {
      createClient: () =>
        client({
          capabilities: async () => {
            throw serverError(401, "invalid_token", "Invalid token");
          },
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.state.status).toBe("error");
    expect(result.state.message).toContain("Token was rejected by worker.example.com");
    expect(result.state.message).toContain("Upgrade the OpenWork host");
    expect(result.state.message).toContain("team@openworklabs.com");
  });

  test("reports a missing workspace separately from a dead worker", async () => {
    const result = await testRemoteWorkspaceConnection(workspace(), {
      createClient: () =>
        client({
          listWorkspaces: async () => {
            return { items: [], activeId: null };
          },
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.state.status).toBe("error");
    expect(result.state.message).toContain("Workspace ws_remote was not found");
    expect(result.state.message).toContain("Upgrade the OpenWork host");
    expect(result.state.message).toContain("team@openworklabs.com");
  });

  test("uses workspace list when the saved remote target is not workspace-scoped", async () => {
    const result = await testRemoteWorkspaceConnection(
      workspace({
        openworkHostUrl: "https://worker.example.com",
        openworkWorkspaceId: "",
        baseUrl: "",
      }),
      {
        createClient: (target) => {
          expect(target.baseUrl).toBe("https://worker.example.com");
          expect(target.workspaceId).toBe(null);
          return client({
            status: async () => {
              throw new Error("status should not be called");
            },
          });
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.state.message).toBe("Connected to Worker project.");
  });

  test("reports rejected credentials from the workspace list fallback", async () => {
    const result = await testRemoteWorkspaceConnection(
      workspace({
        openworkHostUrl: "https://worker.example.com",
        openworkWorkspaceId: "",
        baseUrl: "",
      }),
      {
        createClient: () =>
          client({
            listWorkspaces: async () => {
              throw serverError(401, "invalid_token", "Invalid token");
            },
          }),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.state.status).toBe("error");
    expect(result.state.message).toContain("Token was rejected by worker.example.com");
    expect(result.state.message).toContain("Upgrade the OpenWork host");
    expect(result.state.message).toContain("team@openworklabs.com");
  });

  test("reports unauthorized workspace status separately from bad credentials", async () => {
    const result = await testRemoteWorkspaceConnection(workspace(), {
      createClient: () =>
        client({
          listWorkspaces: async () => {
            throw serverError(403, "forbidden", "Forbidden");
          },
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.state.status).toBe("error");
    expect(result.state.message).toContain("is not authorized");
    expect(result.state.message).toContain("Upgrade the OpenWork host");
    expect(result.state.message).toContain("team@openworklabs.com");
  });

  test("reports endpoint reachability failures from the health probe", async () => {
    const result = await testRemoteWorkspaceConnection(workspace(), {
      createClient: () =>
        client({
          health: async () => {
            throw new Error("Failed to fetch");
          },
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.state.status).toBe("error");
    expect(result.state.message).toContain("Cannot reach worker.example.com");
    expect(result.state.message).toContain("Upgrade the OpenWork host");
    expect(result.state.message).toContain("team@openworklabs.com");
  });

  test("redacts token-like values from diagnostic error messages", async () => {
    const result = await testRemoteWorkspaceConnection(workspace(), {
      createClient: () =>
        client({
          health: async () => {
            throw new Error("Failed with Bearer owt_live_secret and ?token=abc123");
          },
        }),
    });

    expect(result.ok).toBe(false);
    expect(result.state.message).toContain("Bearer [redacted]");
    expect(result.state.message).toContain("?token=[redacted]");
    expect(result.state.message).not.toContain("owt_live_secret");
    expect(result.state.message).not.toContain("abc123");
  });
});

describe("remote diagnostic identity", () => {
  test("redacts common token shapes", () => {
    const redacted = redactRemoteDiagnosticText(
      "Authorization: Bearer abc.def and https://x.test/?access_token=secret&ok=1 and owt_live_secret",
    );

    expect(redacted).toContain("Authorization: Bearer [redacted]");
    expect(redacted).toContain("?access_token=[redacted]&ok=1");
    expect(redacted).toContain("owt_[redacted]");
    expect(redacted).not.toContain("abc.def");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("owt_live_secret");
  });

  test("changes when connection credentials change", () => {
    const before = getRemoteWorkspaceConnectionKey(workspace({ openworkToken: "old-token" }));
    const after = getRemoteWorkspaceConnectionKey(workspace({ openworkToken: "new-token" }));

    expect(before).not.toBe(after);
  });
});

describe("diagnoseRemoteWorkspaceTaskLoadFailure", () => {
  test("keeps the task load error when the worker itself is reachable", async () => {
    const state = await diagnoseRemoteWorkspaceTaskLoadFailure(
      workspace(),
      "Session list failed",
      {
        now: () => 456,
        createClient: () => client(),
      },
    );

    expect(state).toEqual({
      status: "error",
      message: "Worker is reachable, but tasks failed to load: Session list failed",
      checkedAt: 456,
    });
  });

  test("prefers the blocking connection diagnostic when the worker is unreachable", async () => {
    const state = await diagnoseRemoteWorkspaceTaskLoadFailure(
      workspace(),
      "Session list failed",
      {
        createClient: () =>
          client({
            health: async () => {
              throw new Error("Failed to fetch");
            },
          }),
      },
    );

    expect(state.status).toBe("error");
    expect(state.message).toContain("Cannot reach worker.example.com");
  });

  test("redacts token-like values from task load fallbacks", async () => {
    const state = await diagnoseRemoteWorkspaceTaskLoadFailure(
      workspace(),
      "Session failed with bearer owt_live_secret and ?token=abc123",
      {
        createClient: () => client(),
      },
    );

    expect(state.message).toContain("bearer [redacted]");
    expect(state.message).toContain("?token=[redacted]");
    expect(state.message).not.toContain("owt_live_secret");
    expect(state.message).not.toContain("abc123");
  });
});

describe("getWorkspaceTaskLoadErrorDisplay", () => {
  test("redacts remote worker task load errors before rendering", () => {
    const display = getWorkspaceTaskLoadErrorDisplay(
      workspace(),
      "failed with Authorization: Bearer owt_live_secret and ?token=abc123",
    );

    expect(display.message).toContain("Authorization: Bearer [redacted]");
    expect(display.message).toContain("?token=[redacted]");
    expect(display.message).not.toContain("owt_live_secret");
    expect(display.message).not.toContain("abc123");
  });
});
