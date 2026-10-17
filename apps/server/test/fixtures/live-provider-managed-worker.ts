import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createEngineV2Preview } from "../../src/engine-v2-preview.js";
import { SseParser } from "../../../../packages/opencode-plugin/src/inventory-events.ts";
import { readGlobalRuntimeOpencodeConfig, writeGlobalRuntimeOpencodeConfig } from "../../src/runtime-opencode-config-store.js";
import type { ServerConfig } from "../../src/types.js";
import { assertNativeSecretsAbsent, localProviderAccess } from "./native-provider-security-assertions.ts";
import { nativeProtocols, nativeProtocolResponse } from "./native-provider-protocol-fixtures.ts";

// Executed in its own minimal HOME/XDG process: never read a developer's auth DB.
const root = process.argv[2];
assert.ok(root);
const directory = join(root, "opencode-v2", "state", "workspace");
await mkdir(directory, { recursive: true });
const config: ServerConfig = {
  host: "127.0.0.1", port: 0, token: "test", hostToken: "test", configPath: join(root, "server.json"),
  approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [root], readOnly: false,
  startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
};
const gatewayID = "ipr_managednative";
const legacyID = "lpr_managed_native";
let name = "Live initial";
let inventoryReads = 0;
let quotaRequests = 0;
let quotaMode = false;
let connectReads = 0;
const inferenceRequests: { providerID: string; path: string }[] = [];
let unrelatedDenRequests = 0;
let flag: boolean | "unavailable" = false;
let flagReads = 0;
const streams = new Set<ServerResponse>();
const den = createServer((req, res) => {
  const protocol = nativeProtocols.find(item => req.url?.startsWith(`/api/v1/providers/${item.providerID}/`));
  if (protocol) {
    assert.equal(req.method, "POST");
    const upstreamCredentials = [req.headers.authorization, req.headers["x-api-key"], req.headers["x-goog-api-key"]];
    assert.ok(upstreamCredentials.includes("Bearer ow_gw_managed_synthetic") || upstreamCredentials.includes("ow_gw_managed_synthetic"), "only the server-side inference proxy supplies the reusable Gateway credential upstream");
    if (quotaMode) {
      quotaRequests++;
      res.writeHead(429, { "content-type": "application/json", "X-OpenWork-Error-Code": "openwork_gateway_usage_limit_exceeded", "X-OpenWork-Usage-State": "blocked" });
      res.end(JSON.stringify({ error: { code: "openwork_gateway_usage_limit_exceeded", source: "openwork_gateway", type: "usage_limit_error", message: "You have reached your AI Gateway usage limit." } }));
    } else {
      inferenceRequests.push({ providerID: protocol.providerID, path: req.url ?? "" });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(nativeProtocolResponse(protocol.protocol, protocol.modelID, `Native ${protocol.protocol} proxy success`));
    }
    return;
  }
  assert.equal(req.headers.authorization, "Bearer native-managed-session");
  assert.equal(req.headers["x-openwork-org-id"], "org_native_managed");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname.endsWith("/inventory/events")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": connected\n\n");
    streams.add(res);
    req.on("close", () => streams.delete(res));
    return;
  }
  const providers = nativeProtocols.map(protocol => ({
    id: protocol.providerID, providerId: protocol.protocol === "openai" ? "openai-compatible" : protocol.protocol, name: `Managed ${protocol.protocol} Gateway`, credentialStatus: "ready",
    providerConfig: { npm: protocol.npm, options: { baseURL: `${denURL}/api/v1/providers/${protocol.providerID}` } },
    models: [{ id: protocol.modelID, name: protocol.providerID === gatewayID ? name : `Native ${protocol.protocol}`, config: { id: protocol.modelID, limit: { context: 8192, output: 1024 }, tool_call: true } }],
  }));
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/v1/inference-providers") {
    inventoryReads++;
    res.end(JSON.stringify({ inferenceProviders: providers }));
  } else if (providers.some(provider => url.pathname === `/v1/inference-providers/${provider.id}/connect`)) {
    connectReads++;
    const provider = providers.find(provider => url.pathname === `/v1/inference-providers/${provider.id}/connect`);
    assert.ok(provider);
    res.end(JSON.stringify({ inferenceProvider: { ...provider, apiKey: "ow_gw_managed_synthetic" } }));
  } else {
    unrelatedDenRequests++;
    res.statusCode = 404;
    res.end("{}");
  }
});
den.listen(0, "127.0.0.1");
await once(den, "listening");
const address = den.address();
assert.ok(address && typeof address !== "string");
const denURL = `http://127.0.0.1:${address.port}`;
let engine: ReturnType<typeof createEngineV2Preview> | undefined;

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  let latest: T | undefined;
  let error: unknown;
  while (Date.now() < deadline) {
    try { latest = await read(); if (accept(latest)) return latest; } catch (cause) { error = cause; }
    await delay(50);
  }
  throw new Error(`${label}: ${JSON.stringify(latest)}; ${String(error)}; engine=${JSON.stringify(engine?.status())}; inventoryReads=${inventoryReads}; streams=${streams.size}; config=${await generatedConfig().catch(String)}`);
}
function freshEngine() {
  return createEngineV2Preview({
    config, deferStart: true,
    providerSession: () => ({ baseUrl: denURL, token: "native-managed-session", orgId: "org_native_managed" }),
    resolveLiveProviderSync: async () => {
      flagReads++;
      if (flag === "unavailable") throw new Error("synthetic fresh rollout lookup unavailable");
      return flag;
    },
  });
}
async function models(at = directory) {
  const connection = engine?.connection();
  assert.ok(connection);
  const headers = { authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` };
  const response = await fetch(`${connection.url}/api/model?location[directory]=${encodeURIComponent(at)}`, { headers, signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  const value: unknown = await response.json();
  assert.ok(record(value) && Array.isArray(value.data));
  return value.data.filter(record).filter(model => model.providerID === gatewayID || model.providerID === legacyID);
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function generatedConfig() {
  const state = join(root, "opencode-v2", "state");
  return readFile(join(state, "config", "opencode.json"), "utf8");
}
async function start() {
  engine = freshEngine();
  engine.start();
  await until(async () => engine?.status(), status => status?.running === true, "managed engine startup");
}
async function stop() {
  await engine?.stop();
  engine = undefined;
}
async function runtimeSnapshot(gatewayName: string) {
  await writeGlobalRuntimeOpencodeConfig(config, () => ({ provider: {
    [gatewayID]: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1/no-inference", apiKey: "ow_gw_legacy_synthetic" }, models: { gwm_legacy: { name: gatewayName, limit: { context: 8192, output: 1024 } } } },
    [legacyID]: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "http://127.0.0.1:1/no-inference", apiKey: "synthetic_local_key" }, models: { legacy_model: { name: "Local stays", limit: { context: 8192, output: 1024 } } } },
  } }));
}
try {
  await writeFile(join(root, "engine-v2-preview.json"), JSON.stringify({ enabled: true, chatRouting: true }));
  await runtimeSnapshot("Legacy first");
  await start();
  await until(models, rows => rows.some(model => model.id === "gwm_legacy") && rows.some(model => model.id === "legacy_model"), "OFF legacy mirror");
  assert.equal(engine?.status().liveProviderSync, false);
  assert.equal(inventoryReads, 0, "OFF must not fetch Gateway inventory through the plugin");
  assert.equal(streams.size, 0);
  assert.ok(!(await generatedConfig()).includes('"liveProviderSync":true'));
  console.log("Passed managed 12: OFF boots actual legacy native catalog, with no live inventory writer");

  flag = true;
  await engine?.setLiveProviderSync(true);
  await engine?.refreshProviders();
  await until(models, rows => rows.some(model => model.name === "Live initial") && !rows.some(model => model.id === "gwm_legacy"), "OFF to ON replaces legacy Gateway");
  assert.equal(engine?.status().liveProviderSync, true);
  assert.ok(!engine?.status().mirroredProviderIds.includes(gatewayID));
  assert.ok(engine?.status().mirroredProviderIds.includes(legacyID));
  const beforeConfig = await generatedConfig();
  const parsed: unknown = JSON.parse(beforeConfig);
  assert.ok(record(parsed) && record(parsed.providers));
  assert.ok(!(gatewayID in parsed.providers), "the actual engine config contains no Gateway static row");
  assert.ok(legacyID in parsed.providers);
  const beforeRuntime = await readGlobalRuntimeOpencodeConfig(config);
  await until(async () => streams.size, size => size > 0, "managed plugin subscription");
  name = "Live mutation";
  for (const stream of streams) stream.write("event: inventory.changed\ndata: {}\n\n");
  await until(models, rows => rows.some(model => model.name === name), "actual bundled plugin inventory update");
  assert.equal(await generatedConfig(), beforeConfig, "inventory never rewrites the managed native config");
  assert.deepEqual(await readGlobalRuntimeOpencodeConfig(config), beforeRuntime, "plugin does not invoke the old materializer");
  console.log("Passed managed 12: OFF to ON transfers sole Gateway ownership; local mirror survives; inventory leaves both configs untouched");

  const connection = engine?.connection();
  assert.ok(connection);
  const native = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await fetch(`${connection.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
    });
    assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  for (const workspaceName of ["member-workspace-one", "member-workspace-two"]) {
    const foreignDirectory = join(root, workspaceName);
    await mkdir(foreignDirectory);
    const eventController = new AbortController();
    const eventResponse = await fetch(`${connection.url}/api/event`, {
      headers: { authorization: `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}` }, signal: eventController.signal,
    });
    assert.equal(eventResponse.status, 200);
    assert.ok(eventResponse.body);
    const eventReader = eventResponse.body.getReader();
    const events: Record<string, unknown>[] = [];
    const parser = new SseParser(({ data }) => {
      const event: unknown = JSON.parse(data);
      if (record(event)) events.push(event);
    });
    const consuming = (async () => {
      const decoder = new TextDecoder();
      while (!eventController.signal.aborted) {
        const chunk = await eventReader.read();
        if (chunk.done) return;
        parser.push(decoder.decode(chunk.value, { stream: true }));
      }
    })();
    void consuming.catch(() => {});
    try {
      // Match the app: create a session bound through the body, then read its
      // model picker using location[directory]. Do not call ensureWorkspaceReady,
      // warmWorkspace, or copy/invent a project config to hide location activation.
      const foreignSession = await native("/api/session", { title: "New member workspace", location: { directory: foreignDirectory } });
      assert.ok(record(foreignSession) && record(foreignSession.data), JSON.stringify(foreignSession));
      await until(() => models(foreignDirectory), rows => rows.some(model => model.id === "gwm_live"), "new app session workspace receives injected Gateway models without manual warming").catch(async error => {
        const plugins = await native(`/api/plugin?location[directory]=${encodeURIComponent(foreignDirectory)}`).catch(String);
        throw new Error(`${String(error)}; foreignLocationPlugins=${JSON.stringify(plugins)}`);
      });
      const boundary = events.length;
      name = `Live in ${workspaceName}`;
      for (const stream of streams) stream.write("event: inventory.changed\ndata: {}\n\n");
      await until(() => models(foreignDirectory), rows => rows.some(model => model.name === name), "foreign workspace inventory update");
      for (const type of ["provider.updated", "model.updated"]) {
        await until(async () => events.slice(boundary), rows => rows.some(event => event.type === type && record(event.location) && event.location.directory === foreignDirectory), `foreign workspace ${type} carries actual workspace location`);
      }
      assert.equal(await generatedConfig(), beforeConfig, "foreign workspace inventory does not rewrite shared native config");
      assert.equal(streams.size, 1, "native plugin graphs share exactly one owned Den stream");
    } finally {
      eventController.abort();
      await eventReader.cancel().catch(() => {});
      await consuming.catch(() => {});
    }
  }
  console.log("Passed managed workspace: two new app sessions outside engine working directory receive live models and location-scoped native events without config copying/warming; one shared Den stream");

  const attackerDirectory = join(root, "untrusted-project");
  await mkdir(attackerDirectory);
  const attackReport = join(attackerDirectory, "broker-probe.json");
  await writeFile(join(attackerDirectory, "opencode.json"), JSON.stringify({ plugins: [{
    package: join(root, "plugins", "untrusted-project"),
    options: { engineConfig: join(root, "opencode-v2", "state", "config", "opencode.json"), reportPath: attackReport },
  }] }));
  await native("/api/session", { title: "Untrusted project plugin", location: { directory: attackerDirectory } });
  await models(attackerDirectory);
  const reportText = await until(() => readFile(attackReport, "utf8").catch(() => ""), Boolean, "actual native project plugin executes broker attack witness").catch(async error => {
    const plugins = await native(`/api/plugin?location[directory]=${encodeURIComponent(attackerDirectory)}`).catch(String);
    throw new Error(`${String(error)}; projectPlugins=${JSON.stringify(plugins)}`);
  });
  const report: unknown = JSON.parse(reportText);
  assert.ok(record(report), reportText);
  assert.ok(!report.missingFetchSession, "malicious witness actually exercises the canonical broker API");
  assert.equal(report.metadataStatus, 200, reportText);
  assert.ok(!reportText.includes("native-managed-session"), "a same-process malicious project plugin must never obtain the full Den bearer through broker custom fetch or metadata");
  assert.ok(!reportText.includes("ow_gw_managed_synthetic"), "broker connect/list and native provider API never disclose the reusable member Gateway key to a project plugin");
  assert.equal(report.connectStatus, 200, "the attack actually redeems the scoped connect route, but receives only a local ephemeral inference key");
  assert.equal(typeof report.metadata, "string");
  const metadata: unknown = JSON.parse(String(report.metadata));
  assert.ok(record(metadata) && !Object.hasOwn(metadata, "token"), "engine session metadata contains no Den bearer field");
  assert.equal(report.inventoryStatus, 200, reportText);
  assert.equal(report.unrelatedBrokerResult, "denied", "broker refuses unrelated API paths even with a valid opaque identity");
  assert.ok(Array.isArray(report.customFetch) && report.customFetch.length >= 2, "attacker actually intercepts metadata and inventory transport credentials");
  assert.equal(unrelatedDenRequests, 0, "forbidden routes are blocked before reaching Den, not merely rejected by the fake Den");
  assert.ok(Array.isArray(report.forbiddenRoutes));
  assert.equal(report.forbiddenRoutes.length, 4, "captured scoped capability is actually exercised against forbidden bridge routes");
  for (const attempt of report.forbiddenRoutes.filter(record)) {
    if (typeof attempt.path === "string" && !attempt.path.startsWith("/session?")) {
      assert.ok(typeof attempt.status === "number" && attempt.status >= 400, "a captured scoped capability cannot forward unrelated Den APIs or mutations");
    }
  }
  await until(() => models(attackerDirectory), rows => rows.some(model => model.id === "gwm_live"), "legitimate inventory still works beside the malicious project plugin");
  name = "Legitimate refresh after malicious broker probe";
  for (const stream of streams) stream.write("event: inventory.changed\ndata: {}\n\n");
  await until(() => models(attackerDirectory), rows => rows.some(model => model.name === name), "untrusted plugin probe cannot steal or corrupt legitimate inventory capability");
  assert.equal(await generatedConfig(), beforeConfig);
  assert.equal(streams.size, 1);
  await assertNativeSecretsAbsent(join(root, "opencode-v2", "state"), ["native-managed-session", "ow_gw_managed_synthetic"]);
  console.log("Passed managed security: actual malicious project plugin custom-fetch/connect/provider probe obtains neither Den bearer nor reusable Gateway key; unrelated APIs denied; private native cache contains neither secret");

  const beforeInferenceListReads = inventoryReads;
  const beforeInferenceConnectReads = connectReads;
  for (const protocol of nativeProtocols) {
    localProviderAccess(await native(`/api/provider?location[directory]=${encodeURIComponent(directory)}`), protocol.providerID, "ow_gw_managed_synthetic");
    const created = await native("/api/session", { title: `Synthetic ${protocol.protocol} proxy`, location: { directory }, model: { providerID: protocol.providerID, id: protocol.modelID } });
    assert.ok(record(created) && record(created.data) && typeof created.data.id === "string", JSON.stringify(created));
    await native(`/api/session/${created.data.id}/prompt`, { text: `Exercise ${protocol.protocol} through the scoped inference transport.` });
    const messages = await until(() => native(`/api/session/${created.data.id}/message`), value => JSON.stringify(value).includes(`Native ${protocol.protocol} proxy success`), `actual native ${protocol.protocol} inference completes through the local proxy`);
    assert.ok(!JSON.stringify(messages).includes("ow_gw_managed_synthetic"));
    assert.equal(inferenceRequests.filter(request => request.providerID === protocol.providerID).length, 1, `${protocol.protocol} inference reaches the fake Gateway once with only the server-side reusable key`);
  }
  assert.equal(inventoryReads, beforeInferenceListReads, "inference authorization performs no inventory/catalog polling");
  assert.ok(connectReads >= beforeInferenceConnectReads + nativeProtocols.length, "each native inference is freshly authorized by Den connect, not a cached Gateway credential");
  await assertNativeSecretsAbsent(join(root, "opencode-v2", "state"), ["native-managed-session", "ow_gw_managed_synthetic"]);
  console.log("Passed managed protocols: actual OpenAI-compatible, Anthropic, and Gemini native prompts stream through the scoped inference proxy; reusable key appears only at the fake Gateway; authorization connects without catalog polling");

  quotaMode = true;
  const created = await native("/api/session", { title: "Synthetic quota", location: { directory }, model: { providerID: gatewayID, id: "gwm_live" } });
  assert.ok(record(created) && record(created.data) && typeof created.data.id === "string", JSON.stringify(created));
  const sessionID = created.data.id;
  await native(`/api/session/${sessionID}/prompt`, { text: "Return a synthetic quota error; no external model is contacted." });
  await until(async () => quotaRequests, count => count > 0, "native inference reaches localhost quota gateway");
  const terminal = await until(() => native(`/api/session/${sessionID}/message`), value => JSON.stringify(value).includes("You have reached your AI Gateway usage limit."), "native assistant records final quota error");
  assert.ok(JSON.stringify(terminal).includes("429"), JSON.stringify(terminal));
  await delay(2500);
  assert.equal(quotaRequests, 1, "verified live Gateway quota must not be retried by the native engine");
  console.log("Passed managed quota: actual provider.get settings resolve live Gateway base and native 429 terminates after one request");

  flag = false;
  await engine?.setLiveProviderSync(false);
  assert.equal(engine?.status().liveProviderSync, true, "runtime kill is frozen until the child restarts");
  await stop();
  await start();
  await until(models, rows => rows.some(model => model.id === "gwm_legacy") && !rows.some(model => model.id === "gwm_live"), "ON to OFF restart removes plugin providers");
  assert.equal(engine?.status().liveProviderSync, false);
  await until(async () => streams.size, size => size === 0, "old plugin subscription closed");
  const readsAfterOff = inventoryReads;
  await runtimeSnapshot("Legacy after restart");
  await engine?.refreshProviders();
  await until(models, rows => rows.some(model => model.name === "Legacy after restart"), "legacy still owns catalog after kill");
  await delay(1100);
  assert.equal(inventoryReads, readsAfterOff, "OFF engine has no leftover live Gateway reader");
  assert.ok(!(await generatedConfig()).includes('"liveProviderSync":true'));
  console.log("Passed managed 12: ON to OFF restart restores legacy writer, removes live models/subscription, and stays legacy on updates");

  await stop();
  flag = "unavailable";
  await start();
  await until(models, rows => rows.some(model => model.id === "gwm_legacy") && !rows.some(model => model.id === "gwm_live"), "fresh rollout unavailable uses legacy");
  assert.equal(engine?.status().liveProviderSync, false, "fresh Den flag lookup fails closed, despite prior live cache");
  assert.equal(inventoryReads, readsAfterOff);
  assert.ok(flagReads >= 3, "rollout is freshly resolved for every child start");
  console.log("Passed managed 14B: fresh managed boot with Den rollout unavailable does NOT enable cached live rollout");

  // This checks server ownership/routing only. It deliberately does not claim a V1 binary run.
  await engine?.setChatRouting(false, "reverted");
  assert.equal(engine?.status().liveProviderSync, false);
  assert.equal(engine?.status().chatRouting, false);
  assert.ok((await readGlobalRuntimeOpencodeConfig(config)).provider?.[gatewayID]);
  console.log("Passed managed 12 V1 routing regression: policy revert retains legacy materialized config (not a V1 engine execution)");
} finally {
  await stop();
  for (const stream of streams) stream.end();
  den.closeAllConnections();
  await new Promise<void>(resolve => den.close(() => resolve()));
}
