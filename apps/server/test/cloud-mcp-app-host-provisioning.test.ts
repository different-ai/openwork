import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { reconcileOpenworkCloudMcp } from "../src/cloud-mcp-health.js";
import { readOpenWorkConnectMcpAppHostAuthorization } from "../src/connect-mcp-server-catalog.js";
import { readGlobalRuntimeOpencodeConfig } from "../src/runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "../src/types.js";

const trustedEndpoint = "https://api.openworklabs.com/mcp/agent";
const appHostAuthorization = "Bearer private-app-host-test-token";
const cloudConfig = {
  type: "remote",
  url: trustedEndpoint,
  enabled: true,
  oauth: false,
  headers: { Authorization: "Bearer model-facing-test-token" },
};

async function isolatedEnvironment() {
  const root = await mkdtemp(join(tmpdir(), "openwork-app-host-provisioning-"));
  const environment = {
    OPENWORK_RUNTIME_DB: join(root, "runtime.sqlite"),
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: join(root, "desktop-bootstrap.json"),
  };
  const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const workspace: WorkspaceInfo = {
    id: "app-host-provisioning", name: "Test workspace", path: join(root, "workspace"),
    preset: "default", workspaceType: "local",
  };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [workspace], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const restore = async () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  };
  let engineCalls = 0;
  const engineMustNotBeTouched = () => {
    engineCalls += 1;
    throw new Error("Provisioning private App-host auth must not touch an unconfigured engine");
  };
  return {
    config, workspace, restore,
    engineCalls: () => engineCalls,
    reconcile: (desired: Record<string, unknown>) => reconcileOpenworkCloudMcp({
      config, workspace, directory: workspace.path,
      body: { config: desired, appHostAuthorization },
      createWorkspaceOpencodeClient: engineMustNotBeTouched,
      registerRuntimeMcp: engineMustNotBeTouched,
    }),
  };
}

test("trusted Cloud reconciliation provisions private App-host auth before reporting the engine unconfigured", async () => {
  const fixture = await isolatedEnvironment();
  try {
    await mkdir(fixture.workspace.path);
    assert.equal(fixture.workspace.baseUrl, undefined);
    assert.equal(fixture.config.opencodeBaseUrl, undefined);
    assert.equal(await readOpenWorkConnectMcpAppHostAuthorization(fixture.config, fixture.workspace.id, trustedEndpoint), null);

    const health = await fixture.reconcile(cloudConfig);

    assert.equal(health.usable, false);
    assert.equal(health.firstFailure?.code, "opencode_unconfigured");
    assert.equal(fixture.engineCalls(), 0);
    assert.equal(await readOpenWorkConnectMcpAppHostAuthorization(fixture.config, fixture.workspace.id, trustedEndpoint), appHostAuthorization);
    assert.equal(health.appHostAuthorizationReady, true);
    // Desired model config is still persisted, but only with its member token.
    const runtimeConfig = await readGlobalRuntimeOpencodeConfig(fixture.config);
    assert.deepEqual(runtimeConfig.mcp?.["openwork-cloud"], cloudConfig);
    assert.equal(JSON.stringify(runtimeConfig).includes("private-app-host-test-token"), false);
  } finally {
    await fixture.restore();
  }
});

test("untrusted Cloud reconciliation does not provision private App-host auth without an engine", async () => {
  const fixture = await isolatedEnvironment();
  const endpoint = "https://untrusted.invalid/mcp/agent";
  try {
    await mkdir(fixture.workspace.path);
    const health = await fixture.reconcile({ ...cloudConfig, url: endpoint });
    assert.equal(health.usable, false);
    assert.equal(health.firstFailure?.code, "opencode_unconfigured");
    assert.equal(fixture.engineCalls(), 0);
    assert.equal(await readOpenWorkConnectMcpAppHostAuthorization(fixture.config, fixture.workspace.id, endpoint), null);
    assert.equal(await readOpenWorkConnectMcpAppHostAuthorization(fixture.config, fixture.workspace.id, trustedEndpoint), null);
  } finally {
    await fixture.restore();
  }
});

for (const scenario of [
  { name: "malformed", desired: { ...cloudConfig, url: "not-a-cloud-endpoint" }, failure: "cloud_endpoint_invalid" },
  { name: "disabled", desired: { ...cloudConfig, enabled: false }, failure: "cloud_mcp_disabled" },
]) {
  test(`${scenario.name} desired Cloud config does not provision private App-host auth`, async () => {
    const fixture = await isolatedEnvironment();
    try {
      await mkdir(fixture.workspace.path);
      const health = await fixture.reconcile(scenario.desired);
      assert.equal(health.usable, false);
      assert.equal(health.firstFailure?.code, scenario.failure);
      assert.equal(fixture.engineCalls(), 0);
      assert.equal(await readOpenWorkConnectMcpAppHostAuthorization(fixture.config, fixture.workspace.id, trustedEndpoint), null);
      assert.equal((await readGlobalRuntimeOpencodeConfig(fixture.config)).mcp?.["openwork-cloud"], undefined);
    } finally {
      await fixture.restore();
    }
  });
}
