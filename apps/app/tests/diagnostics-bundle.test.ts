import { describe, expect, test } from "bun:test";
import { connectionDiagnosticHistory } from "../src/app/lib/connection-diagnostic-history";

import {
  composeDiagnosticsBundleJson,
  type DiagnosticsBundleInputs,
} from "../src/app/lib/diagnostics-bundle";

function baseInputs(): DiagnosticsBundleInputs {
  return {
    capturedAt: "2026-07-06T00:00:00.000Z",
    desktopRuntime: false,
    appInfo: null,
    engineInfo: null,
    openworkServerSettings: {},
    hostInfo: null,
    developerLogs: [],
    perfLogs: [],
    context: {
      anyActiveRuns: false,
      canReloadWorkspace: false,
      clientConnected: false,
      developerMode: false,
      hostConnectUrl: "",
      hostConnectUrlUsesMdns: false,
      openworkServerStatus: "disconnected",
      openworkServerUrl: "",
      runtimeWorkspaceId: null,
    },
  };
}

describe("diagnostics bundle", () => {
  test("exports always-on bounded history even when developer and performance logs are empty", () => {
    const source = connectionDiagnosticHistory.createSource();
    source.record("den_request_http_failure", "failure", { httpStatus: 503 });
    const parsed = JSON.parse(composeDiagnosticsBundleJson(baseInputs()));
    expect(parsed.runtime.developerMode).toBe(false);
    expect(parsed.developerLogs.recent).toEqual([]);
    expect(parsed.performance.recent).toEqual([]);
    expect(parsed.connectionHistory.maxEvents).toBe(500);
    expect(parsed.connectionHistory.maxAgeMs).toBe(3_600_000);
    expect(parsed.connectionHistory.recent.at(-1)).toMatchObject({
      reason: "den_request_http_failure", kind: "failure", httpStatus: 503,
    });
    source.dispose();
  });

  test("redacts known token values while preserving token presence", () => {
    const settingsSecret = "settings-secret-token-1234";
    const settingsHostSecret = "settings-host-secret-1234";
    const clientSecret = "client-secret-1234";
    const ownerSecret = "owner-secret-1234";
    const hostSecret = "host-secret-1234";
    const opencodeSecret = "opencode-password-1234";
    const input = baseInputs();
    input.desktopRuntime = true;
    input.openworkServerSettings = {
      urlOverride: "http://127.0.0.1:4096",
      token: settingsSecret,
      hostToken: settingsHostSecret,
    };
    input.hostInfo = {
      running: true,
      remoteAccessEnabled: true,
      host: "127.0.0.1",
      port: 4096,
      baseUrl: "http://127.0.0.1:4096",
      connectUrl: "http://127.0.0.1:4096",
      mdnsUrl: null,
      lanUrl: null,
      clientToken: clientSecret,
      ownerToken: ownerSecret,
      hostToken: hostSecret,
      managedOpencodeBinPath: null,
      managedOpencodeBinSource: null,
      pid: 111,
      lastStdout: null,
      lastStderr: `server leaked ${settingsSecret} ${settingsHostSecret} ${clientSecret} ${ownerSecret} ${hostSecret}`,
      managedOpencodeExecution: null,
    };
    input.engineInfo = {
      running: true,
      runtime: "direct",
      managedByServer: true,
      baseUrl: "http://127.0.0.1:4097",
      projectDir: "/tmp/openwork",
      hostname: "127.0.0.1",
      port: 4097,
      opencodeUsername: "do-not-include-user",
      opencodePassword: opencodeSecret,
      opencodeBinPath: "/usr/local/bin/opencode",
      opencodeBinSource: "path",
      pid: 222,
      lastStdout: null,
      lastStderr: `engine leaked ${opencodeSecret}`,
      execution: null,
    };

    const json = composeDiagnosticsBundleJson(input);
    const parsed = JSON.parse(json);

    expect(json).toContain('"tokenPresent": true');
    expect(parsed.openworkServer.settings.tokenPresent).toBe(true);
    expect(parsed.openworkServer.host.lastStderr).toContain("[redacted]");
    expect(parsed.opencodeEngine.lastStderr).toContain("[redacted]");
    expect(json).not.toContain(settingsSecret);
    expect(json).not.toContain(settingsHostSecret);
    expect(json).not.toContain(clientSecret);
    expect(json).not.toContain(ownerSecret);
    expect(json).not.toContain(hostSecret);
    expect(json).not.toContain(opencodeSecret);
    expect(json).not.toContain("clientToken");
    expect(json).not.toContain("ownerToken");
    expect(json).not.toContain("hostToken");
    expect(json).not.toContain("opencodePassword");
    expect(json).not.toContain("do-not-include-user");
    expect(json).not.toContain("opencodeUsername");
  });

  test("produces valid JSON without desktop info", () => {
    const json = composeDiagnosticsBundleJson(baseInputs());
    const parsed = JSON.parse(json);

    expect(parsed.app).toBeNull();
    expect(parsed.opencodeEngine).toBeNull();
    expect(parsed.openworkServer.host).toBeNull();
    expect(parsed.openworkServer.settings.tokenPresent).toBe(false);
  });

  test("includes sanitized Cloud health without Den or MCP tokens", () => {
    const input = baseInputs();
    input.cloudMcpHealth = {
      desired: {
        config: {
          headers: {
            Authorization: "Bearer owt_mcp_synthetic_secret",
          },
        },
        token: {
          present: true,
          metadata: {
            fingerprint: "sha256:abc123",
            expiresAt: "2026-07-20T00:00:00.000Z",
            scopes: "mcp:read mcp:write",
          },
        },
      },
      firstFailure: {
        details: "den token Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signatureee leaked",
      },
      opaque: "owt_den_synthetic_secret",
    };

    const json = composeDiagnosticsBundleJson(input);
    const parsed = JSON.parse(json);

    expect(parsed.cloudMcp.desired.config.headers.Authorization).toBe("[REDACTED]");
    expect(JSON.stringify(parsed.cloudMcp)).toContain("sha256:abc123");
    expect(JSON.stringify(parsed.cloudMcp)).toContain("mcp:read mcp:write");
    expect(json).not.toContain("owt_mcp_synthetic_secret");
    expect(json).not.toContain("owt_den_synthetic_secret");
    expect(json).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});
