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
});
