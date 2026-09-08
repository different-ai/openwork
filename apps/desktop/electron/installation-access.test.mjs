import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInstallationSession, initializeInstallationAccess, installationRequiresSignin, INSTALLATION_ACCESS_FILENAME, DESKTOP_DEN_API_CACHE_MS } from "./installation-access.mjs";
import { createWorkspaceStore } from "./workspace-store.mjs";

function profile(t) {
  const root = mkdtempSync(path.join(tmpdir(), "openwork-installation-access-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, "profile");
  return { root, userDataPath, homeDir: root, env: {
    HOME: root,
    OPENWORK_DESKTOP_BOOTSTRAP_PATH: path.join(root, "bootstrap.json"),
    OPENWORK_SERVER_CONFIG: path.join(root, "server.json"),
  } };
}

test("only an exact legacy record permits optional sign-in", () => {
  assert.equal(installationRequiresSignin('{"version":1,"cohort":"legacy"}'), false);
  for (const raw of ["", "{", "null", "[]", '{"version":2,"cohort":"legacy"}', '{"version":1,"cohort":"required"}', '{"requireSignin":false}', '{"version":1,"cohort":"legacy"} trailing']) {
    assert.equal(installationRequiresSignin(raw), true, raw);
  }
});

test("fresh installation stays required after workspace manufacture, restart, and retained-state reinstall", (t) => {
  const input = profile(t);
  assert.equal(initializeInstallationAccess(input), true);
  const marker = path.join(input.userDataPath, INSTALLATION_ACCESS_FILENAME);
  const original = readFileSync(marker, "utf8");
  writeFileSync(path.join(input.userDataPath, "openwork-workspaces.json"), '{"workspaces":[]}');
  writeFileSync(input.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH, '{"baseUrl":"https://app.openworklabs.com","requireSignin":false}');
  assert.equal(initializeInstallationAccess(input), true);
  assert.equal(readFileSync(marker, "utf8"), original);
});

for (const evidence of ["empty-directory", "openwork-workspaces.json", "workspace-state.json", "migration-snapshot.v1.json", "migration-snapshot.v1.done.json", "Local Storage", "openwork-server-tokens.json", "server-config", "bootstrap", "empty-external-registry"]) {
  test(`retained ${evidence} stays legacy without inspecting onboarding or workspace population`, (t) => {
    const input = profile(t);
    if (evidence === "server-config") writeFileSync(input.env.OPENWORK_SERVER_CONFIG, "{}");
    else if (evidence === "bootstrap") writeFileSync(input.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH, "{}");
    else if (evidence === "empty-external-registry") {
      input.env.OPENWORK_DESKTOP_WORKSPACE_STATE_PATH = path.join(input.root, "workspaces.json");
      writeFileSync(input.env.OPENWORK_DESKTOP_WORKSPACE_STATE_PATH, '{"workspaces":[]}');
    } else {
      mkdirSync(input.userDataPath);
      if (evidence !== "empty-directory") writeFileSync(path.join(input.userDataPath, evidence), "{}");
    }
    assert.equal(initializeInstallationAccess(input), false);
    assert.equal(initializeInstallationAccess(input), false);
  });
}

test("corrupt marker fails closed without rewriting it or other profile data", (t) => {
  const input = profile(t);
  mkdirSync(input.userDataPath);
  const marker = path.join(input.userDataPath, INSTALLATION_ACCESS_FILENAME);
  writeFileSync(marker, "{truncated");
  assert.equal(initializeInstallationAccess(input), true);
  assert.equal(readFileSync(marker, "utf8"), "{truncated");
});

test("bootstrap IPC cannot opt the installation out or change enterprise policy", async (t) => {
  const input = profile(t);
  const previous = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = input.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
    else process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = previous;
  });
  const store = createWorkspaceStore({ app: { getPath: () => input.userDataPath }, defaultDenBaseUrl: "https://app.openworklabs.com", defaultRequireSignin: false, forceRequireSignin: true, installationRequiresSignin: true });
  const result = await store.setDesktopBootstrapConfig({ baseUrl: "https://org.openwork.test", requireSignin: false, installationRequiresSignin: false });
  assert.equal(result.installationRequiresSignin, true);
  assert.equal(result.requireSignin, true);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(input.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH, "utf8")), "installationRequiresSignin"), false);
  assert.equal(store.readDesktopBootstrapConfigSync().installationRequiresSignin, true);
  await store.clearDesktopBootstrapConfig();
  assert.equal((await store.getDesktopBootstrapConfig()).installationRequiresSignin, true);
});

test("no token makes no verification calls; verified session is checked again for every admission", async () => {
  let calls = 0;
  let configCalls = 0;
  let revoked = false;
  const access = createInstallationSession({ readBootstrapConfig: () => ({ baseUrl: "https://den.openwork.test", apiBaseUrl: "https://den.openwork.test" }), fetcher: async (url, options) => {
    if (url.endsWith("/api/runtime-config")) { configCalls++; return Response.json({}); }
    assert.equal(url, "https://den.openwork.test/v1/me");
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    calls++;
    return revoked ? Response.json({ error: "unauthorized" }, { status: 401 }) : Response.json({ user: { id: "member", email: "member@openwork.test" } });
  } });
  assert.deepEqual(await access.verify(), { status: "signed_out" });
  assert.equal(calls, 0);
  assert.equal(configCalls, 0);
  assert.equal((await access.setToken("fixture-token", "https://den.openwork.test")).status, "signed_in");
  revoked = true;
  assert.equal((await access.verify()).status, "signed_out");
  assert.equal(calls, 2);
  assert.equal(configCalls, 1);
  await access.setToken(null);
  assert.equal((await access.verify()).status, "signed_out");
  assert.equal(calls, 2);
});

test("offline, foreign unauthorized responses, and missing verified user never grant access", async () => {
  for (const fetchSession of [async () => { throw new Error("offline"); }, async () => Response.json({}, { status: 401 }), async () => Response.json({ code: "unauthorized" }, { status: 401 }), async () => Response.json({ error: "base_url_not_present" }, { status: 401 }), async () => Response.json({ error: "proxy_auth_required", code: "unauthorized" }, { status: 401 }), async () => new Response("Proxy sign-in required", { status: 401 }), async () => Response.json({}), async () => Response.json({ user: { id: "", email: "member@openwork.test" } })]) {
    const access = createInstallationSession({
      readBootstrapConfig: () => ({ baseUrl: "https://den.openwork.test" }),
      fetcher: (url) => url.endsWith("/api/runtime-config") ? Promise.resolve(Response.json({})) : fetchSession(),
    });
    assert.equal((await access.setToken("retained-token", "https://den.openwork.test")).status, "unavailable");
  }
});

test("a verification in flight cannot reopen access after logout or a server switch", async () => {
  for (const change of ["logout", "server"]) {
    /** @type {(response: Response) => void} */
    let finish = () => { throw new Error("Verification has not started"); };
    let sessionStarted = () => {};
    const started = new Promise((resolve) => { sessionStarted = () => resolve(undefined); });
    let baseUrl = "https://den.openwork.test";
    const access = createInstallationSession({ readBootstrapConfig: () => ({ baseUrl }), fetcher: (url) => {
      if (url.endsWith("/api/runtime-config")) return Promise.resolve(Response.json({}));
      return new Promise((resolve) => { finish = resolve; sessionStarted(); });
    } });
    const pending = access.setToken("fixture-token", baseUrl);
    await started;
    if (change === "logout") await access.setToken(null);
    else baseUrl = "https://other.openwork.test";
    finish(Response.json({ user: { id: "member", email: "member@openwork.test" } }));
    assert.equal((await pending).status, "signed_out");
    assert.equal((await access.verify()).status, "signed_out");
  }
});

test("Den error strings revoke a session; foreign 401s remain unavailable", async () => {
  for (const code of ["unauthorized", "invalid_session", "session_expired", "session_revoked", "invalid_token", "token_expired", "token_revoked"]) {
    const access = createInstallationSession({
      readBootstrapConfig: () => ({ baseUrl: "https://den.openwork.test" }),
      fetcher: async (url) => url.endsWith("/api/runtime-config") ? Response.json({}) : Response.json({ error: code }, { status: 401 }),
    });
    assert.equal((await access.setToken("expired-token", "https://den.openwork.test")).status, "signed_out", code);
  }
});

test("runtime API publication takes precedence; absent publication preserves explicit and deterministic endpoints", async () => {
  for (const { config, published, expected } of [
    { config: { baseUrl: "https://web.openwork.test", apiBaseUrl: "https://explicit.openwork.test" }, published: null, expected: "https://explicit.openwork.test" },
    { config: { baseUrl: "https://web.openwork.test", apiBaseUrl: "https://old.openwork.test" }, published: "https://current.openwork.test", expected: "https://current.openwork.test" },
    { config: { baseUrl: "https://web.openwork.test" }, published: null, expected: "https://web.openwork.test/api/den" },
    { config: { baseUrl: "https://api.openwork.test" }, published: null, expected: "https://api.openwork.test" },
    { config: { baseUrl: "http://localhost:3000/api/den/" }, published: null, expected: "http://localhost:3000/api/den" },
  ]) {
    const requests = [];
    const access = createInstallationSession({ readBootstrapConfig: () => config, fetcher: async (url, options) => {
      requests.push(url);
      if (url.endsWith("/api/runtime-config")) {
        assert.equal(url, new URL("/api/runtime-config", config.baseUrl).href);
        assert.equal(new Headers(options.headers).has("authorization"), false);
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        assert.equal(options.cache, "no-store");
        return published ? Response.json({ denApiUrl: published }) : new Response(null, { status: 404 });
      }
      assert.equal(url, `${expected}/v1/me`);
      return Response.json({ user: { id: "member", email: "member@openwork.test" } });
    } });
    assert.equal((await access.setToken("fixture-token", config.baseUrl)).status, "signed_in");
    assert.equal(requests.length, 2);
  }
});

test("default production same-origin handoff verifies its published API without writing bootstrap", async (t) => {
  const input = profile(t);
  const previous = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = input.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
    else process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = previous;
  });
  const store = createWorkspaceStore({ app: { getPath: () => input.userDataPath }, defaultDenBaseUrl: "https://app.openworklabs.com", defaultRequireSignin: false, forceRequireSignin: false });
  const original = store.readDesktopBootstrapConfigSync();
  const requests = [];
  const access = createInstallationSession({ readBootstrapConfig: store.readDesktopBootstrapConfigSync, fetcher: async (url, options) => {
    requests.push(url);
    if (url === "https://app.openworklabs.com/api/runtime-config") {
      assert.equal(new Headers(options.headers).has("authorization"), false);
      return Response.json({ denApiUrl: "https://api.openworklabs.com" });
    }
    assert.equal(url, "https://api.openworklabs.com/v1/me");
    return Response.json({ user: { id: "member", email: "member@openwork.test" } });
  } });
  assert.equal((await access.setToken("handoff-token", original.baseUrl)).status, "signed_in");
  assert.equal((await access.verify()).status, "signed_in");
  assert.deepEqual(requests, ["https://app.openworklabs.com/api/runtime-config", "https://api.openworklabs.com/v1/me", "https://api.openworklabs.com/v1/me"]);
  assert.deepEqual(store.readDesktopBootstrapConfigSync(), original);
  assert.equal(existsSync(input.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH), false);
});

test("bounded runtime cache rotates the API without a bootstrap write and never falls back to an obsolete API on refresh failure", async () => {
  let time = 0;
  let published = "https://first.openwork.test";
  let configUnavailable = false;
  let configCalls = 0;
  const authenticatedUrls = [];
  const config = { baseUrl: "https://web.openwork.test", apiBaseUrl: "https://obsolete.openwork.test" };
  const access = createInstallationSession({ readBootstrapConfig: () => config, now: () => time, fetcher: async (url, options) => {
    if (url.endsWith("/api/runtime-config")) {
      configCalls++;
      assert.equal(new Headers(options.headers).has("authorization"), false);
      if (configUnavailable) throw new Error("offline");
      return Response.json({ denApiUrl: published });
    }
    authenticatedUrls.push(url);
    return Response.json({ user: { id: "member", email: "member@openwork.test" } });
  } });
  assert.equal((await access.setToken("fixture-token", config.baseUrl)).status, "signed_in");
  time = DESKTOP_DEN_API_CACHE_MS - 1;
  assert.equal((await access.verify()).status, "signed_in");
  assert.equal(configCalls, 1);
  published = "https://second.openwork.test";
  time = DESKTOP_DEN_API_CACHE_MS;
  assert.equal((await access.verify()).status, "signed_in");
  assert.equal(configCalls, 2);
  configUnavailable = true;
  time += DESKTOP_DEN_API_CACHE_MS;
  assert.equal((await access.verify()).status, "unavailable");
  assert.deepEqual(authenticatedUrls, ["https://first.openwork.test/v1/me", "https://first.openwork.test/v1/me", "https://second.openwork.test/v1/me"]);
  configUnavailable = false;
  assert.equal((await access.verify()).status, "signed_in");
  assert.equal(authenticatedUrls.at(-1), "https://second.openwork.test/v1/me");
});

test("an origin switch discards in-flight runtime discovery and rejects stale token sources before sending credentials", async () => {
  let config = { baseUrl: "https://previous.openwork.test" };
  /** @type {(response: Response) => void} */
  let finishDiscovery = () => { throw new Error("Discovery has not started"); };
  const authenticated = [];
  const configUrls = [];
  const access = createInstallationSession({ readBootstrapConfig: () => config, fetcher: async (url, options) => {
    if (url.endsWith("/api/runtime-config")) {
      configUrls.push(url);
      assert.equal(new Headers(options.headers).has("authorization"), false);
      if (url.startsWith("https://previous.")) return new Promise((resolve) => { finishDiscovery = resolve; });
      return Response.json({ denApiUrl: "https://current-api.openwork.test" });
    }
    authenticated.push({ url, token: new Headers(options.headers).get("authorization") });
    return Response.json({ user: { id: "member", email: "member@openwork.test" } });
  } });
  const previous = access.setToken("previous-token", config.baseUrl);
  config = { baseUrl: "https://current.openwork.test" };
  assert.equal((await access.setToken("previous-token", "https://previous.openwork.test")).status, "signed_out");
  assert.equal((await access.setToken("current-token", config.baseUrl)).status, "signed_in");
  finishDiscovery(Response.json({ denApiUrl: "https://previous-api.openwork.test" }));
  assert.equal((await previous).status, "signed_out");
  assert.equal((await access.verify()).status, "signed_in");
  assert.deepEqual(configUrls, ["https://previous.openwork.test/api/runtime-config", "https://current.openwork.test/api/runtime-config"]);
  assert.deepEqual(authenticated, [
    { url: "https://current-api.openwork.test/v1/me", token: "Bearer current-token" },
    { url: "https://current-api.openwork.test/v1/me", token: "Bearer current-token" },
  ]);
});

test("unsafe runtime publications and redirected discovery cannot receive a token", async () => {
  for (const published of ["http://insecure.openwork.test", "https://user:pass@untrusted.openwork.test", "file:///tmp/config", "https://api.openwork.test?redirect=elsewhere", "https://api.openwork.test#ignored", 12, "redirect"]) {
    let tokenRequests = 0;
    const access = createInstallationSession({ readBootstrapConfig: () => ({ baseUrl: "https://web.openwork.test" }), fetcher: async (_url, options) => {
      if (new Headers(options.headers).has("authorization")) tokenRequests++;
      assert.equal(options.redirect, "error");
      if (published === "redirect") throw new Error("Redirect disallowed");
      return Response.json({ denApiUrl: published });
    } });
    assert.equal((await access.setToken("fixture-token", "https://web.openwork.test")).status, "unavailable");
    assert.equal(tokenRequests, 0);
  }
});
