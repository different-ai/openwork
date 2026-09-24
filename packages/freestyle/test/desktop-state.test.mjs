import assert from "node:assert/strict";
import test from "node:test";
import { observeDesktop, readDesktopProfile, inspectDesktop } from "../src/desktop-state.mjs";
import { prepareBlankSlateProfile } from "../../../apps/desktop/electron/blank-slate-profile.mjs";

const profile = prepareBlankSlateProfile({ argv: ["--blank-slate"], env: {}, platform: "linux", temporaryDirectory: "/opt/openwork-preview/desktop",
  createTempRoot: (prefix) => `${prefix}synthetic`, createDirectory: () => {},
});
const expectedWorkspacePath = `${profile.userDataPath}/openwork-dev-data/home/OpenWork Chat`;
const workspace = { id: "ws_initial", path: expectedWorkspacePath, name: "OpenWork Chat", displayName: "OpenWork Chat", workspaceType: "local", preset: "starter" };

function nativeFiles() {
  const files = new Map([
    ["/opt/openwork-preview/desktop/profile.json", profile],
    [`${profile.userDataPath}/openwork-workspaces.json`, { selectedId: workspace.id, workspaces: [{ ...workspace }] }],
  ]);
  return { files, read: async (path) => {
    if (files.has(path)) return JSON.stringify(files.get(path));
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  } };
}

test("native profile permits the automatic local workspace, including before server.json is persisted", async () => {
  const { files, read } = nativeFiles();
  const state = await readDesktopProfile(read);
  assert.equal(state.expectedWorkspacePath, expectedWorkspacePath);
  for (const value of Object.values(state).filter((value) => typeof value === "boolean")) assert.equal(value, true);
  files.set(profile.environment.OPENWORK_SERVER_CONFIG, { workspaces: [workspace] });
  assert.equal((await readDesktopProfile(read)).nativeWorkspaceValid, true);
});

for (const scenario of [
  { name: "Acme workspace", file: `${profile.userDataPath}/openwork-workspaces.json`, value: { workspaces: [{ ...workspace, path: "/root/Acme", name: "Acme" }] }, flag: "nativeWorkspaceValid" },
  { name: "renamed demo workspace", file: `${profile.userDataPath}/openwork-workspaces.json`, value: { workspaces: [{ ...workspace, name: "Acme" }] }, flag: "nativeWorkspaceValid" },
  { name: "extra persisted workspace", file: profile.environment.OPENWORK_SERVER_CONFIG, value: { workspaces: [workspace, { ...workspace, id: "ws_demo" }] }, flag: "nativeWorkspaceValid" },
  { name: "legacy remote workspace", file: `${profile.userDataPath}/workspace-state.json`, value: { workspaces: [{ ...workspace, workspaceType: "remote" }] }, flag: "nativeWorkspaceValid" },
  { name: "bootstrap grant", file: profile.environment.OPENWORK_DESKTOP_BOOTSTRAP_PATH, value: { handoff: { grant: "SYNTHETIC_SECRET" } }, flag: "noBootstrap" },
  { name: "null bootstrap file", file: profile.environment.OPENWORK_DESKTOP_BOOTSTRAP_PATH, value: null, flag: "noBootstrap" },
  { name: "provider auth", file: `${profile.userDataPath}/openwork-dev-data/xdg/data/opencode/auth.json`, value: { gateway: { key: "SYNTHETIC_SECRET" } }, flag: "noNativeProviderCredentials" },
  { name: "cloud MCP auth", file: `${profile.environment.XDG_DATA_HOME}/opencode/mcp-auth.json`, value: { "openwork-cloud": { token: "SYNTHETIC_SECRET" } }, flag: "noNativeProviderCredentials" },
  { name: "injected model credentials", file: profile.environment.OPENWORK_ENV_STORE, value: { variables: [{ key: "OPENWORK_MODELS_API_KEY", value: "SYNTHETIC_SECRET" }] }, flag: "noNativeProviderCredentials" },
]) {
  test(`native inspection rejects ${scenario.name} without returning credentials`, async () => {
    const { files, read } = nativeFiles();
    files.set(scenario.file, scenario.value);
    const state = await readDesktopProfile(read);
    assert.equal(state[scenario.flag], false);
    assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_SECRET/);
  });
}

function renderer(t) {
  const model = { providerID: "stock-provider", modelID: "stock-model-from-product" };
  const storage = new Map([
    ["openwork.preferences", JSON.stringify({ hasCompletedOnboarding: false, defaultModel: model })],
    ["openwork.defaultModel", `${model.providerID}/${model.modelID}`],
  ]);
  const route = {
    loading: false, connected: true, connectionPending: false, routeError: null, selectedSessionId: null,
    selectedWorkspaceId: workspace.id, workspaces: [{ ...workspace, displayNameResolved: "OpenWork Chat", sessionCount: 0, loading: false, error: null }],
    sessionsByWorkspaceId: { [workspace.id]: [] },
  };
  const info = { running: true, remoteAccessEnabled: false, baseUrl: "http://127.0.0.1:4444", clientToken: "SYNTHETIC_CLIENT_SECRET", hostToken: "SYNTHETIC_HOST_SECRET" };
  const bootstrap = { fromFile: false };
  const prefix = `/workspace/${workspace.id}`;
  const responses = {
    "/workspaces": { items: [{ ...workspace, baseUrl: "http://127.0.0.1:4096", opencode: { baseUrl: "http://127.0.0.1:4096", password: "SYNTHETIC_ENGINE_SECRET" } }] },
    "/cloud-provider-sync/status": { hasSession: false, providers: [], skippedProviders: [], lastRun: null },
    "/runtime-config/providers": { provider: {} },
    [`${prefix}/config`]: { opencode: {}, openwork: {} },
    [`${prefix}/runtime-config`]: { runtime: {}, effectiveRuntime: { agent: { openwork: {} }, plugin: ["builtin"] }, sources: { projectOpencode: { config: {} }, globalOpencode: { config: {} } } },
    [`${prefix}/opencode/session?limit=1`]: [],
  };
  const requestPaths = [];
  const globals = {
    localStorage: { getItem: (key) => storage.get(key) ?? null },
    window: { __openwork: { slice: (name) => { assert.equal(name, "route"); return route; } } },
    document: { querySelectorAll: () => [{ textContent: "Sign in" }] },
  };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]);
      else delete globalThis[key];
    }
  });
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, "http://127.0.0.1:4444");
    assert.equal(options.method, undefined);
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    const path = url.pathname + url.search;
    assert.ok(Object.hasOwn(responses, path));
    requestPaths.push(path);
    return Response.json(responses[path]);
  });
  const observe = () => observeDesktop({ nonce: null, expectedWorkspacePath }, async () => [{ DEFAULT_MODEL: model }, {
    openworkServerInfo: async () => info, getDesktopBootstrapConfig: async () => bootstrap,
  }]);
  return { model, storage, route, info, bootstrap, responses, requestPaths, observe };
}

test("pristine desktop uses product DEFAULT_MODEL, reads only local native state, and returns booleans", async (t) => {
  const fixture = renderer(t);
  const observed = await fixture.observe();
  assert.ok(Object.values(observed).every((value) => value === true));
  assert.equal(fixture.requestPaths.length, 6);
  assert.doesNotMatch(JSON.stringify(observed), /SYNTHETIC|stock-provider|ws_initial|4444|OpenWork Chat/);
});

for (const scenario of [
  { name: "demo app token", mutate: (f) => f.storage.set("openwork.den.authToken", "SYNTHETIC_SECRET"), flag: "noAppCloudIdentity" },
  { name: "retained organization", mutate: (f) => f.storage.set("openwork.den.activeOrgId", "org_demo"), flag: "noAppCloudIdentity" },
  { name: "completed onboarding", mutate: (f) => f.storage.set("openwork.preferences", JSON.stringify({ hasCompletedOnboarding: true })), flag: "firstRun" },
  { name: "Gateway model", mutate: (f) => f.storage.set("openwork.defaultModel", "ipr_gateway/provisioned"), flag: "ordinaryDefaultModel" },
  { name: "Gateway preference", mutate: (f) => f.storage.set("openwork.preferences", JSON.stringify({ defaultModel: { providerID: "lpr_acme", modelID: "demo" } })), flag: "ordinaryDefaultModel" },
  { name: "Acme route", mutate: (f) => { f.route.workspaces[0].path = "/root/Acme"; }, flag: "routeWorkspaceValid" },
  { name: "hidden native demo workspace", mutate: (f) => f.responses["/workspaces"].items.push({ ...workspace, id: "ws_demo" }), flag: "nativeWorkspaceMatches" },
  { name: "route conversation", mutate: (f) => { f.route.sessionsByWorkspaceId[workspace.id] = [{ id: "ses_demo" }]; }, flag: "noRouteConversations" },
  { name: "hidden native conversation", mutate: (f) => { f.responses[`/workspace/${workspace.id}/opencode/session?limit=1`] = [{ id: "ses_demo" }]; }, flag: "noNativeConversations" },
  { name: "native Den token", mutate: (f) => { f.responses["/cloud-provider-sync/status"].hasSession = true; }, flag: "noNativeCloudSession" },
  { name: "provisioned native provider", mutate: (f) => { f.responses["/runtime-config/providers"].provider.ipr_gateway = { apiKey: "SYNTHETIC_SECRET" }; }, flag: "noProvisionedModel" },
  { name: "persisted global provider", mutate: (f) => { f.responses[`/workspace/${workspace.id}/runtime-config`].sources.globalOpencode.config.provider = { lpr_acme: {} }; }, flag: "noProvisionedModel" },
  { name: "persisted cloud MCP credential", mutate: (f) => { f.responses[`/workspace/${workspace.id}/config`].opencode.mcp = { "openwork-cloud": { headers: { Authorization: "SYNTHETIC_SECRET" } } }; }, flag: "noCloudConfiguration" },
  { name: "imported cloud resources", mutate: (f) => { f.responses[`/workspace/${workspace.id}/config`].openwork.cloudImports = { skills: { demo: {} } }; }, flag: "noCloudConfiguration" },
  { name: "non-local engine", mutate: (f) => { f.responses["/workspaces"].items[0].opencode.baseUrl = "https://do-not-contact.invalid"; }, flag: "nativeWorkspaceMatches" },
  { name: "non-local runtime", mutate: (f) => { f.info.baseUrl = "https://do-not-contact.invalid"; }, flag: "nativeLocalOnly", noRequests: true },
  { name: "native bootstrap identity", mutate: (f) => { f.bootstrap.handoff = { grant: "SYNTHETIC_SECRET" }; }, flag: "nativeLocalOnly", noRequests: true },
]) {
  test(`renderer inspection rejects ${scenario.name}`, async (t) => {
    const fixture = renderer(t);
    scenario.mutate(fixture);
    const observed = await fixture.observe();
    assert.equal(observed[scenario.flag], false);
    assert.ok(Object.values(observed).every((value) => typeof value === "boolean"));
    assert.doesNotMatch(JSON.stringify(observed), /SYNTHETIC|org_demo|ipr_gateway|ses_demo/);
    if (scenario.noRequests) assert.deepEqual(fixture.requestPaths, []);
  });
}

test("failed readiness reports only allowlisted last-state booleans even when probes throw secrets", async () => {
  let report;
  await assert.rejects(inspectDesktop({ timeoutMs: 1, readProfile: async () => { throw new Error("SYNTHETIC_SECRET"); }, report: (flags) => { report = flags; }, loadCdp: async () => ({
    attachSurface: async () => ({ client: {}, stop: async () => {} }),
    probeAppState: async () => { throw new Error("SYNTHETIC_SECRET"); },
  }) }), (error) => {
    assert.doesNotMatch(error.message, /SYNTHETIC/);
    assert.equal(error.diagnostics.profileRead, false);
    return true;
  });
  assert.ok(Object.values(report).every((value) => typeof value === "boolean"));
  assert.equal(report.profileRead, false);
  assert.equal(report.cdpRead, false);
});
