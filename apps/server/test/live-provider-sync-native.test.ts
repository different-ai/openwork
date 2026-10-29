import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SseParser } from "../../../packages/opencode-plugin/src/inventory-events.ts";
import { providerCredentialBrokerSource } from "../src/opencode-v2-provider-channel.ts";
import { assertNativeSecretsAbsent, localProviderAccess } from "./fixtures/native-provider-security-assertions.ts";

// This is deliberately a binary integration test, not a mock of the provider fold.
// OPENWORK_TEST_OPENCODE2 may point at the same pinned binary on Linux/CI.
const binary = process.env.OPENWORK_TEST_OPENCODE2 ?? "/Applications/OpenWork.app/Contents/Resources/sidecars/opencode2";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const providerID = "ipr_nativesync";
const disabledID = "ipr_nativedisabled";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let latest: T | undefined;
  let error: unknown;
  while (Date.now() < deadline) {
    try {
      latest = await read();
      if (accept(latest)) return latest;
    } catch (cause) { error = cause; }
    await delay(50);
  }
  throw new Error(`Timed out: ${label}; last=${JSON.stringify(latest)}; error=${String(error)}`);
}

function gatewayKey(token: string, orgId: string): string {
  // Gateway keys are distinct credentials, never a concatenation containing the
  // Den bearer (the scoped bridge correctly redacts Den-bearer response echoes).
  return `ow_gw_${createHash("sha256").update(JSON.stringify([orgId, token])).digest("hex")}`;
}

function gateway(id: string, models: { id: string; name: string }[], name = "Native provider") {
  return {
    id, providerId: "openai-compatible", name, credentialStatus: "ready",
    providerConfig: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1/no-inference" } },
    models: models.map(model => ({
      ...model, config: { id: model.id, limit: { context: 8192, output: 1024 }, tool_call: true },
      upstreamModelId: null, modelGroupName: null, credentialSetName: null,
    })),
  };
}

test("pinned V2 replays desktop inventory and real model filters through native provider/model events", { timeout: 180_000 }, async t => {
  try { await access(binary); } catch {
    t.skip(`needs: pinned OpenCode 2.0.26 binary (${binary}); set OPENWORK_TEST_OPENCODE2`);
    return;
  }
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /\bv2\.0\.26\b/, "native API premise is pinned to the shipping engine");

  const temp = process.env.OPENCODE_TEST_TMPDIR ?? join(tmpdir(), "opencode");
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "openwork-native-provider-"));
  const cleanups: (() => Promise<void>)[] = [() => rm(root, { recursive: true, force: true })];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });
  const project = join(root, "project");
  const home = join(root, "home");
  await Promise.all([mkdir(project), mkdir(home)]);
  const directory = await realpath(project);
  let session: { apiBaseUrl: string; token: string; orgId: string } | null = null;
  let providers = [gateway(providerID, [
    { id: "gwm_keep", name: "Original" }, { id: "gwm_remove", name: "Removed later" },
    { id: "gwm_blacklisted", name: "Blacklisted" }, { id: "gwm_unlisted", name: "Not whitelisted" },
  ])];
  let inventoryStatus = 200;
  let inventoryReads = 0;
  let inferenceRequests = 0;
  let streamStatus = 200;
  let streamError = "feature_disabled";
  let streamAttempts = 0;
  let holdNextInventory = false;
  let heldInventory: { response: ServerResponse; body: string } | undefined;
  const credentials: { token: string | undefined; org: string | string[] | undefined }[] = [];
  const subscriptions = new Set<ServerResponse>();
  const mock = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    credentials.push({ token: req.headers.authorization, org: req.headers["x-openwork-org-id"] });
    assert.equal(req.headers.authorization, `Bearer ${session?.token}`);
    assert.equal(req.headers["x-openwork-org-id"], session?.orgId);
    if (url.pathname.endsWith("/inventory/events")) {
      streamAttempts++;
      if (streamStatus !== 200) {
        res.writeHead(streamStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: streamError }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      subscriptions.add(res);
      req.on("close", () => subscriptions.delete(res));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.statusCode = inventoryStatus;
    if (inventoryStatus !== 200) { res.end("{}"); return; }
    if (url.pathname === "/v1/inference-providers") {
      inventoryReads++;
      const body = JSON.stringify({ inferenceProviders: providers });
      if (holdNextInventory) {
        holdNextInventory = false;
        heldInventory = { response: res, body };
        return;
      }
      res.end(body);
      return;
    }
    const provider = providers.find(item => url.pathname === `/v1/inference-providers/${item.id}/connect`);
    if (provider) {
      res.end(JSON.stringify({ inferenceProvider: { ...provider, apiKey: gatewayKey(session?.token ?? "", session?.orgId ?? "") } }));
      return;
    }
    inferenceRequests++;
    res.statusCode = 404;
    res.end("{}");
  });
  const mockUrl = await listen(mock);
  cleanups.push(async () => {
    for (const response of subscriptions) response.end();
    mock.closeAllConnections();
    await new Promise<void>(resolveClose => mock.close(() => resolveClose()));
  });
  const changed = () => {
    assert.ok(subscriptions.size, "the real desktop plugin owns a Den SSE subscription");
    for (const response of subscriptions) response.write("event: inventory.changed\ndata: {}\n\n");
  };

  // Exercise the production inventory-only bridge, not a fake /session that
  // would put the full Den session back inside the engine under test.
  const bridgeModulePath = join(root, "provider-session-bridge.mjs");
  const bridgeBuild = spawnSync("bun", ["build", join(repo, "apps/server/src/opencode-v2-provider-session.ts"), "--target=node", "--format=esm", `--outfile=${bridgeModulePath}`], {
    encoding: "utf8", cwd: repo, timeout: 30_000,
  });
  assert.equal(bridgeBuild.status, 0, bridgeBuild.stderr);
  const bridgeModule: typeof import("../src/opencode-v2-provider-session.ts") = await import(pathToFileURL(bridgeModulePath).href);
  const createBridge = () => bridgeModule.createV2ProviderSessionBridge(() => session ? {
    baseUrl: session.apiBaseUrl, token: session.token, orgId: session.orgId,
  } : null);
  let bridge = await createBridge();
  cleanups.push(() => bridge.close());

  // Source models are NOT in config: bundled ConfigProvider's later model transform
  // can resurrect explicit config models after an external filter removed them.
  // The only synthetic part is one permanently disabled source provider.
  const entry = join(root, "fixture.ts");
  const pluginDirectory = join(root, "plugin");
  await mkdir(pluginDirectory);
  const bundle = join(pluginDirectory, "server.mjs");
  const broker = join(pluginDirectory, "credential-broker.cjs");
  await writeFile(broker, providerCredentialBrokerSource, { mode: 0o600 });
  await writeFile(entry, `
import desktop from ${JSON.stringify(join(repo, "packages/opencode-plugin/server.ts"))};
import filters from ${JSON.stringify(join(repo, "apps/server/src/opencode-plugins/openwork-provider-filters-v2.ts"))};
import { toProviderRecord } from ${JSON.stringify(join(repo, "packages/opencode-plugin/src/providers.ts"))};
export default {
  id: "openwork.native-provider-test",
  async setup(ctx) {
    const disabled = toProviderRecord(${JSON.stringify(gateway(disabledID, [{ id: "gwm_disabled", name: "Disabled" }]))}, "ow_gw_disabled_test");
    const registration = await ctx.provider.transform(editor => editor.add({
      ...disabled, info: { ...disabled.info, activation: "disabled" }
    }));
    const disposeFilters = await filters.setup({ ...ctx, options: { providers: {
      ${JSON.stringify(providerID)}: {
        whitelist: ["gwm_keep", "gwm_remove", "gwm_added", "gwm_blacklisted"],
        blacklist: ["gwm_blacklisted"]
      }
    } } });
    const disposeDesktop = await desktop.setup({ ...ctx, options: {
      liveProviderSync: true, desktopSession: process.env.OPENWORK_TEST_SESSION_ENDPOINT
    } });
    return async () => {
      await disposeDesktop?.();
      await disposeFilters?.();
      await registration.dispose();
    };
  }
};
`);
  const build = spawnSync("bun", ["build", entry, "--target=node", "--format=esm", `--outfile=${bundle}`], {
    encoding: "utf8", cwd: repo, timeout: 30_000,
  });
  assert.equal(build.status, 0, build.stderr);
  const configPath = join(project, "opencode.json");
  const config = JSON.stringify({ update: "disable", share: "disabled", plugins: [{ package: pluginDirectory }], warming: false });
  await writeFile(configPath, config);

  // Reserve an ephemeral port, then release it immediately before engine startup.
  const reservation = createServer();
  const engineUrl = await listen(reservation);
  await new Promise<void>(resolveClose => reservation.close(() => resolveClose()));
  const port = new URL(engineUrl).port;
  const startChild = () => {
    const engine = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", port], {
      cwd: directory,
      // Do not inherit cloud credentials, user's OpenCode paths, proxy, or config.
      env: {
        PATH: process.env.PATH,
        HOME: home, OPENCODE_TEST_HOME: home,
        XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
        OPENCODE_CONFIG_DIR: join(home, "config", "opencode"),
        OPENCODE_DB: join(home, "native.db"),
        OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_FILEWATCHER: "true",
        OPENCODE_PASSWORD: "native-engine-test-password",
        OPENWORK_PROVIDER_SESSION_FD: "3",
        OPENWORK_PROVIDER_SESSION_BROKER: broker,
        OPENWORK_TEST_SESSION_ENDPOINT: bridge.url,
      },
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    // Keep the fixture's transport in one place, matching the managed child path.
    const channel = engine.stdio[3];
    assert.ok(channel && "end" in channel);
    channel.end(JSON.stringify({ endpoint: bridge.url, token: bridge.token }));
    return engine;
  };
  let child = startChild();
  let logs = "";
  const captureLogs = () => {
    child.stdout.on("data", chunk => { logs += String(chunk); });
    child.stderr.on("data", chunk => { logs += String(chunk); });
  };
  captureLogs();
  const stopChild = async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await Promise.race([once(child, "exit"), delay(3000, undefined, { ref: false })]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
    }
  };
  cleanups.push(stopChild);
  const restart = async () => {
    await stopChild();
    await bridge.close();
    bridge = await createBridge();
    logs = "";
    child = startChild();
    captureLogs();
    await until(() => request("/api/provider"), () => true, "native engine restart");
  };
  const headers = { authorization: `Basic ${Buffer.from("opencode:native-engine-test-password").toString("base64")}` };
  const request = async (path: string): Promise<unknown> => {
    if (child.exitCode !== null) throw new Error(`Engine exited ${child.exitCode}: ${logs}`);
    const response = await fetch(`${engineUrl}${path}`, { headers, signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}; ${logs}`);
    return response.json();
  };
  await until(() => request("/api/provider"), () => true, "native engine boot");
  const initialConfig = await request("/api/config");

  const events: Record<string, unknown>[] = [];
  const controller = new AbortController();
  const eventResponse = await fetch(`${engineUrl}/api/event`, { headers, signal: controller.signal });
  assert.equal(eventResponse.status, 200);
  assert.ok(eventResponse.body);
  const reader = eventResponse.body.getReader();
  const parser = new SseParser(({ data }) => {
    const event: unknown = JSON.parse(data);
    if (record(event)) events.push(event);
  });
  const consuming = (async () => {
    const decoder = new TextDecoder();
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value, { stream: true }));
    }
  })();
  // Attach a rejection handler immediately (undici rejects on abort).
  void consuming.catch(() => {});
  cleanups.push(async () => { controller.abort(); await reader.cancel().catch(() => {}); await consuming.catch(() => {}); });
  const models = async () => {
    const value = await request(`/api/model?location[directory]=${encodeURIComponent(directory)}`);
    assert.ok(record(value) && Array.isArray(value.data), JSON.stringify(value));
    return value.data.filter(record).filter(model => model.providerID === providerID || model.providerID === disabledID);
  };
  await until(models, value => value.length === 0, "initial signed-out inventory");
  await until(async () => events, value => value.some(event => event.type === "server.connected"), "native SSE connected");
  session = { apiBaseUrl: mockUrl, token: "native-session-one", orgId: "org_native_one" };
  const initial = await until(models, value => value.some(model => model.id === "gwm_keep"), "desktop sign-in publishes inventory");
  assert.deepEqual(initial.map(model => model.id).sort(), ["gwm_keep", "gwm_remove"]);
  assert.equal(initial.find(model => model.id === "gwm_keep")?.name, "Original");
  await until(async () => subscriptions.size, size => size > 0, "Den subscription");

  const boundary = events.length;
  const beforeReads = inventoryReads;
  providers = [gateway(providerID, [
    { id: "gwm_keep", name: "Updated without config" }, { id: "gwm_added", name: "Added live" },
    { id: "gwm_blacklisted", name: "Still blacklisted" }, { id: "gwm_unlisted", name: "Still not whitelisted" },
  ], "Updated provider")];
  const start = Date.now();
  changed();
  const updated = await until(models, value => value.some(model => model.name === "Updated without config"), "live add/remove/update");
  assert.deepEqual(updated.map(model => model.id).sort(), ["gwm_added", "gwm_keep"]);
  assert.ok(inventoryReads > beforeReads, "an event bypasses inventory freshness shortcuts");
  for (const type of ["provider.updated", "model.updated"]) {
    const event = await until(async () => events.slice(boundary).find(item => item.type === type), Boolean, type);
    assert.ok(event && record(event.location));
    assert.equal(event.location.directory, directory, `${type} carries its native location`);
  }
  assert.equal(events.some(event => event.type === "catalog.updated"), false, "catalog.updated is not a native V2 event");
  t.diagnostic(`native inventory add/remove/update and filter replay: ${Date.now() - start}ms`);
  assert.equal(events.slice(boundary).some(event => event.type === "location.shutdown" || event.type === "config.updated"), false,
    "inventory reload does not rebuild the location or update configuration");

  const scenario = async (name: string, run: () => Promise<void>) => {
    await run();
    t.diagnostic(`Passed native scenario ${name}`);
  };
  await scenario("10: disconnect, mutate offline, reconnect fully replaces the native snapshot", async () => {
    streamStatus = 503;
    for (const response of subscriptions) response.end();
    await until(async () => subscriptions.size, size => size === 0, "stream disconnected");
    providers = [gateway(providerID, [{ id: "gwm_keep", name: "Reconnected" }, { id: "gwm_unlisted", name: "Still filtered" }])];
    // No changed event is delivered while the stream is down.
    streamStatus = 200;
    await until(models, value => value.length === 1 && value[0]?.name === "Reconnected", "Den reconnect reconciles complete inventory");
    await until(async () => subscriptions.size, size => size > 0, "stream recovered");
  });

  await scenario("10: duplicate notifications are idempotent; held old fetch cannot win a burst", async () => {
    // Drain the reconnect's initial reconciliation before establishing the event boundary.
    await delay(250);
    const duplicateBoundary = events.length;
    const reads = inventoryReads;
    for (let i = 0; i < 20; i++) changed();
    await until(async () => inventoryReads, value => value > reads, "duplicate events reached actual inventory reader");
    await delay(400);
    assert.deepEqual((await models()).map(model => model.name), ["Reconnected"]);
    assert.equal(events.slice(duplicateBoundary).some(event => event.type === "provider.updated" || event.type === "model.updated"), false,
      "equal snapshots do not reload the native provider/model fold");

    holdNextInventory = true;
    changed();
    await until(async () => heldInventory, Boolean, "old inventory response held on localhost");
    providers = [gateway(providerID, [{ id: "gwm_keep", name: "Newest burst wins" }])];
    for (let i = 0; i < 30; i++) changed();
    assert.ok(heldInventory);
    heldInventory.response.end(heldInventory.body);
    heldInventory = undefined;
    await until(models, value => value.length === 1 && value[0]?.name === "Newest burst wins", "queued reconciliation re-reads latest inventory");
    await delay(300);
    assert.deepEqual((await models()).map(model => model.name), ["Newest burst wins"]);
    assert.equal(await readFile(configPath, "utf8"), config);
    assert.deepEqual(await request("/api/config"), initialConfig);
  });

  await scenario("14: transient Den failure preserves usable inventory and retries without another event", async () => {
    inventoryStatus = 503;
    changed();
    await delay(300);
    assert.deepEqual((await models()).map(model => model.name), ["Newest burst wins"]);
    providers = [gateway(providerID, [{ id: "gwm_keep", name: "Recovered by retry" }])];
    inventoryStatus = 200;
    await until(models, value => value[0]?.name === "Recovered by retry", "transient retry recovery");
  });

  await scenario("11: warm engine restart reads persistent cache while Den is unavailable, then reconciles", async () => {
    const oldAccess = localProviderAccess(await request(`/api/provider?location[directory]=${encodeURIComponent(directory)}`), providerID, gatewayKey("native-session-one", "org_native_one"));
    inventoryStatus = 503;
    await restart();
    await until(models, value => value.length === 1 && value[0]?.name === "Recovered by retry", "real V2 storage restores matching cache");
    const access = localProviderAccess(await request(`/api/provider?location[directory]=${encodeURIComponent(directory)}`), providerID, gatewayKey("native-session-one", "org_native_one"));
    assert.notEqual(access.apiKey, oldAccess.apiKey, "warm native cache rebinds to this engine's new ephemeral inference key");
    assert.notEqual(access.baseURL, oldAccess.baseURL, "warm native cache rebinds to the new scoped loopback bridge");
    const inference = (apiKey: string) => fetch(`${access.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gwm_keep", messages: [{ role: "user", content: "Offline catalog is not inference authorization" }] }), signal: AbortSignal.timeout(2000),
    });
    const stale = await inference(oldAccess.apiKey);
    assert.ok([401, 403, 409, 410].includes(stale.status), "old engine inference key cannot authorize the restarted bridge");
    await stale.body?.cancel();
    const offline = await inference(access.apiKey);
    assert.ok([502, 503].includes(offline.status), `cached catalog remains usable, but Den connect must authorize inference while offline: ${offline.status}`);
    await offline.body?.cancel();
    assert.equal(inferenceRequests, 0, "offline inference never reaches an upstream Gateway using cached reusable credentials");
    await assertNativeSecretsAbsent(home, [gatewayKey("native-session-one", "org_native_one")]);
    providers = [gateway(providerID, [{ id: "gwm_added", name: "Fresh after restart" }])];
    inventoryStatus = 200;
    await until(models, value => value.length === 1 && value[0]?.name === "Fresh after restart", "restart retry replaces cached model");
  });

  await scenario("11/14: connected 401 revokes cache and cannot reopen the rejected identity", async () => {
    await until(async () => subscriptions.size, size => size > 0, "stream after restart");
    inventoryStatus = 401;
    changed();
    await until(models, value => value.length === 0, "authorization revocation removes live providers");
    inventoryStatus = 200;
    const reads = inventoryReads;
    await delay(1300);
    assert.equal(inventoryReads, reads, "same rejected identity is not silently reauthorized");
    assert.deepEqual(await models(), []);
  });

  await scenario("13: token rotation, org/account replacement, sign-out never retain old native models", async () => {
    session = { apiBaseUrl: mockUrl, token: "native-session-two", orgId: "org_native_one" };
    providers = [gateway(providerID, [{ id: "gwm_keep", name: "Rotated token" }])];
    await until(models, value => value.length === 1 && value[0]?.name === "Rotated token", "fresh token authorizes new snapshot");
    const rotatedProviders = await request(`/api/provider?location[directory]=${encodeURIComponent(directory)}`);
    const oldAccountAccess = localProviderAccess(rotatedProviders, providerID, gatewayKey("native-session-two", "org_native_one"));
    assert.ok(!JSON.stringify(rotatedProviders).includes(gatewayKey("native-session-one", "org_native_one")));
    await assertNativeSecretsAbsent(home, [gatewayKey("native-session-one", "org_native_one"), gatewayKey("native-session-two", "org_native_one")]);
    await until(async () => subscriptions.size, size => size > 0, "rotated-token subscription");
    holdNextInventory = true;
    changed();
    await until(async () => heldInventory, Boolean, "old account fetch held during org switch");
    const credentialBoundary = credentials.length;
    session = { apiBaseUrl: mockUrl, token: "native-session-three", orgId: "org_native_two" };
    providers = [gateway(providerID, [{ id: "gwm_added", name: "Second account" }])];
    await until(models, value => value.length === 1 && value[0]?.name === "Second account", "account switch replaces inventory");
    assert.ok(heldInventory);
    heldInventory.response.end(heldInventory.body);
    heldInventory = undefined;
    await delay(250);
    assert.deepEqual((await models()).map(model => model.name), ["Second account"], "late old-account fetch cannot overwrite the new fold");
    const switchedProviders = await request(`/api/provider?location[directory]=${encodeURIComponent(directory)}`);
    const currentAccess = localProviderAccess(switchedProviders, providerID, gatewayKey("native-session-three", "org_native_two"));
    assert.notEqual(currentAccess.apiKey, oldAccountAccess.apiKey, "account/org switch rotates the bound local inference authority");
    assert.ok(!JSON.stringify(switchedProviders).includes(gatewayKey("native-session-two", "org_native_one")), "native provider retains no old account reusable Gateway key");
    const staleAccount = await fetch(`${currentAccess.baseURL.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { authorization: `Bearer ${oldAccountAccess.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "gwm_added", messages: [{ role: "user", content: "An old identity must not authorize the new organization" }] }), signal: AbortSignal.timeout(2000),
    });
    assert.ok([401, 403, 409, 410].includes(staleAccount.status), "old identity's captured ephemeral key cannot invoke the new org's Gateway");
    await staleAccount.body?.cancel();
    await assertNativeSecretsAbsent(home, [gatewayKey("native-session-two", "org_native_one"), gatewayKey("native-session-three", "org_native_two")]);
    assert.ok(credentials.slice(credentialBoundary).some(item => item.token === "Bearer native-session-three" && item.org === "org_native_two"));
    // Every request is also checked against the currently selected identity by the fake Den.
    session = null;
    await until(models, value => value.length === 0, "sign-out clears inventory");
    await until(async () => [...subscriptions].map(response => ({
      destroyed: response.destroyed, closed: response.closed,
      writableEnded: response.writableEnded, writableFinished: response.writableFinished,
    })), responses => responses.length === 0, "sign-out closes old subscription");
    const signedOutProviders = JSON.stringify(await request(`/api/provider?location[directory]=${encodeURIComponent(directory)}`));
    assert.ok(!signedOutProviders.includes(gatewayKey("native-session-three", "org_native_two")), "sign-out exposes no reusable Gateway credential");
    assert.ok(!signedOutProviders.includes(currentAccess.apiKey), "sign-out removes the actual native ephemeral inference credential");
    const signedOutReads = inventoryReads;
    await delay(1100);
    assert.equal(inventoryReads, signedOutReads, "signed out engine never fetches old account inventory");
  });

  await scenario("11/14: cold restart after sign-out cannot recover another account's cache", async () => {
    inventoryStatus = 503;
    session = { apiBaseUrl: mockUrl, token: "native-session-four", orgId: "org_native_three" };
    await restart();
    await delay(350);
    assert.deepEqual(await models(), [], "cache from prior account was removed on sign-out");
    providers = [gateway(providerID, [{ id: "gwm_keep", name: "Third account" }])];
    inventoryStatus = 200;
    await until(models, value => value.length === 1 && value[0]?.name === "Third account", "cold account recovers when Den returns");
    // Whole-list 403 is authoritative, unlike temporary 5xx.
    inventoryStatus = 403;
    await until(async () => subscriptions.size, size => size > 0, "third account subscription");
    changed();
    await until(models, value => value.length === 0, "whole-list 403 removes providers");
  });
  await scenario("13/14: membership 404 and 403 clear inventory, same identity regrant resnapshots", async () => {
    inventoryStatus = 200;
    session = { apiBaseUrl: mockUrl, token: "native-membership-session", orgId: "org_native_membership" };
    providers = [gateway(providerID, [{ id: "gwm_keep", name: "Before membership removal" }])];
    await until(models, rows => rows[0]?.name === "Before membership removal", "membership baseline");
    for (const status of [404, 403]) {
      await until(async () => subscriptions.size, size => size > 0, "membership stream live");
      streamStatus = status;
      streamError = "organization_not_found";
      const attempts = streamAttempts;
      for (const response of subscriptions) response.end();
      await until(models, rows => rows.length === 0, `${status} membership revocation clears actual native fold`);
      await until(async () => streamAttempts, count => count > attempts, "membership response actually received");
      await delay(1100);
      assert.deepEqual(await models(), [], "revoked membership cannot replay the cache during reconnect backoff");
      providers = [gateway(providerID, [{ id: "gwm_added", name: `Regranted after ${status}` }])];
      streamStatus = 200;
      await until(models, rows => rows.length === 1 && rows[0]?.name === `Regranted after ${status}`, "same token/org stream reconnect performs full fresh snapshot");
      assert.equal(session.token, "native-membership-session", "regrant does not depend on local identity rotation");
    }
  });

  await scenario("12/14: explicit rollout kill 404 keeps snapshot but never reopens killed stream", async () => {
    await until(async () => subscriptions.size, size => size > 0, "kill baseline subscription");
    streamStatus = 404;
    streamError = "feature_disabled";
    const attempts = streamAttempts;
    for (const response of subscriptions) response.end();
    await until(async () => streamAttempts, count => count > attempts, "kill response read");
    const snapshot = await models();
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0]?.name, "Regranted after 403");
    const killedAttempts = streamAttempts;
    providers = [gateway(providerID, [{ id: "gwm_keep", name: "Must not appear while killed" }])];
    streamStatus = 200;
    await delay(1300);
    assert.deepEqual(await models(), snapshot, "kill does not erase offline usable known inventory");
    assert.equal(streamAttempts, killedAttempts, "feature kill is terminal for this plugin lifetime");
    // The managed-engine fixture separately proves the next OFF boot selects legacy.
  });
  assert.equal(await readFile(configPath, "utf8"), config, "live inventory never materializes providers/models into config");
  assert.deepEqual(await request("/api/config"), initialConfig, "all native config sources remain unchanged");
  assert.equal(inferenceRequests, 0, "offline and stale-key loopback probes never reach upstream inference");
  assert.equal(events.some(event => event.type === "catalog.updated"), false);
});
