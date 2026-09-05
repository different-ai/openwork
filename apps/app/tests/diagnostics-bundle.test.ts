import { describe, expect, test } from "bun:test";

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
      execution: {
        command: "opencode", args: ["serve", "--api-key", "synthetic-argument"],
        cwd: "/tmp/synthetic-workspace",
        env: [{ name: "OPENAI_API_KEY", value: "synthetic-environment-value", redacted: false }],
      },
    };

    const json = composeDiagnosticsBundleJson(input);
    const parsed = JSON.parse(json);

    expect(json).not.toContain("synthetic-argument");
    expect(json).not.toContain("synthetic-environment-value");
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

test("redacts pasted credentials and nested diagnostic fields while retaining context", () => {
  const input = baseInputs();
  input.cloudMcpHealth = {
    phase: "engine_failed",
    nested: {
      accessToken: "synthetic-access",
      refresh_token: "synthetic-refresh",
      apiKey: "synthetic-key",
      "set-cookie": "synthetic-cookie",
    },
    error: "request failed Bearer synthetic-bearer-123",
  };
  input.context = { openworkServerUrl: "https://example.invalid/?access_token=synthetic-query&status=failed" };
  const json = composeDiagnosticsBundleJson(input);
  for (const secret of ["synthetic-access", "synthetic-refresh", "synthetic-key", "synthetic-cookie", "synthetic-bearer", "synthetic-query"]) {
    expect(json).not.toContain(secret);
  }
  expect(json).toContain("engine_failed");
  expect(json).toContain("status=failed");
});

test("shared sanitizer handles freeform credentials before truncation without removing useful metadata", async () => {
  const { sanitizeDiagnosticString, sanitizeDiagnosticRecord } = await import("../src/app/lib/diagnostic-sanitizer");
  const examples = [
    "Bearer synthetic-bearer",
    "Cookie: session=synthetic-cookie; other=synthetic-other",
    "OPENAI_API_KEY=synthetic-environment",
    "sk-proj-synthetic-api-credential",
    "xoxb-synthetic-oauth-credential",
    "ya29.synthetic-oauth-credential",
    "github_pat_synthetic-credential",
    'please inspect api_key="synthetic-key with spaces"',
    '{"refreshToken":"synthetic-refresh","status":"failed"}',
    "--client-secret synthetic-cli",
    "https://synthetic-user:synthetic-password@example.invalid",
  ];
  for (const example of examples) {
    const redacted = sanitizeDiagnosticString(example);
    expect(redacted).not.toContain("synthetic");
    expect(redacted).toContain("[REDACTED]");
    expect(sanitizeDiagnosticString(redacted)).toBe(redacted);
  }
  expect(sanitizeDiagnosticRecord({ appVersion: "1.2.3", statusCode: 401, tokenPresent: true })).toEqual({
    appVersion: "1.2.3", statusCode: 401, tokenPresent: true,
  });
});
