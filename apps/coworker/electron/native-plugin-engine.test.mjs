import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";
import { build } from "esbuild";
import { createHeadlessThreadClientV2, createNativeV2Client } from "@openwork/headless-threads/v2";
import { configureNativePluginBundles, NATIVE_PLUGIN_VERSION } from "./native-plugin.mjs";
import { installCollaborationPlugin } from "./collaboration-plugin.mjs";
import { installBrowserPlugin } from "./browser-plugin.mjs";
import { installComputerPlugin } from "./computer-plugin.mjs";
import { installGroupDocumentPlugin } from "./group-document-plugin.mjs";
import { installEventPlugin } from "./event-plugin.mjs";
import { installAbilitiesPlugin } from "./abilities-plugin.mjs";
import { defaultCoworkerAbilities } from "../src/lib/abilities.ts";
import { installProgressPlugin } from "./progress-plugin.mjs";
import { installMemoryPlugin, extractConversationMemory } from "./memory-model.mjs";
import { summarizeProgress } from "./progress-summaries.mjs";
import { nativeTurnAgent, NATIVE_TURN_ROLES, NATIVE_COORDINATOR_AGENT } from "./native-turns.mjs";
import { coordinatorConfig } from "./coordinator.mjs";
import { createCoworkerToolsServer, createToolHandlers } from "./coworker-tools.mjs";
import { createDocument, listDocuments } from "./documents.mjs";
import { nativeConfig } from "./native-config.mjs";
import { prepareNativeTurnRoles } from "./turn-roles-plugin.mjs";

const binary = process.env.OPENWORK_TEST_NATIVE_V2_BIN;
const bundles = process.env.OPENWORK_COWORKER_PLUGIN_BUNDLE_DIR;
const dependencies = process.env.COWORKER_NATIVE_PLUGIN_TEST_ROOT;

test(`bundled native plugins enforce roles, Code Mode isolation, scoped cancellation and bounded inference in ${NATIVE_PLUGIN_VERSION}`, {
  skip: !binary || !bundles || !dependencies, timeout: 90_000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "opencode", "coworker-plugins-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const config = path.join(root, "config");
  await mkdir(workspace); await mkdir(config);
  const skillDirectory = path.join(config, "skills", "cold-worker-guidance");
  await mkdir(skillDirectory, { recursive: true });
  const skillBody = "Selected cold Worker instruction: preserve the blue cedar marker.";
  await writeFile(path.join(skillDirectory, "SKILL.md"), `---\nname: cold-worker-guidance\ndescription: Isolated cold Worker skill fixture\n---\n${skillBody}\n`);
  const requests = [];
  const brokerCalls = [];
  const witnesses = [];
  const mcpCalls = [];
  const documentChanges = [];
  await createDocument(root, "workspace", { title: "Launch review", summary: "Two launch checks remain.", highlights: ["review"], body: "## Checks\nReview the launch checks." });
  await createDocument(root, "workspace", { title: "Reference", summary: "Background only.", highlights: ["reference"], body: "## Notes\nBackground material." });
  const seededDocuments = await listDocuments(root, "workspace");
  const mcp = await createCoworkerToolsServer({
    resolveSlug: (token) => token === "fixture-only" ? "workspace" : null,
    handlers: Object.fromEntries(Object.entries(createToolHandlers({ coworkersDir: root, onChange: (...change) => documentChanges.push(change) }))
      .map(([name, handler]) => [name, async (slug, args) => { mcpCalls.push({ name, slug, args }); return handler(slug, args); }])),
  });
  t.after(() => mcp.stop());
  const readCode = 'const listed = await tools.coworker.documents_list({}); const selected = listed.documents.filter(d => d.status === "active" && d.highlights.includes("review")); const detail = await tools.coworker.document_read({id: selected[0].id}); return {total: listed.documents.length, reviewed: selected.map(d => ({title: d.title, summary: detail.document.summary, revision: detail.document.revision}))};';
  const protectedCode = [
    ['tools.coworker.document_create({title:"Forbidden",summary:"Forbidden",body:"## Never\\nNo mutation."})'],
    ['tools.coworker.document_update({id:"launch-review",summary:"Forbidden"})'],
    ['tools.coworker.document_archive({id:"launch-review"})'],
    ['tools.coworker.context_set({aside:["launch-review"]})'],
    ['tools.coworker_browser_tabs({})'], ['tools.coworker_computer_observe({})'],
    ['tools.coworker_team_consult({to:"fixture",question:"Forbidden",continuation:{objective:"Forbidden",resumeInstructions:"Forbidden"}})'],
    ['tools.coworker_worker_spawn({name:"Forbidden",goal:"Forbidden",continuation:{objective:"Forbidden",resumeInstructions:"Forbidden"}})'],
    ['tools.coworker_group_document_read({groupId:"grp_12345678",id:"plan"})'],
    ['tools.coworker_group_document_save({groupId:"grp_12345678",title:"Forbidden",body:"Forbidden"})'],
    ['tools.coworker_assignment_create({})'], ['tools.fixture_management_alias({})'],
    ['tools.fixture_direct_only({})'], ['tools.coworker_future_read({})'], ['tools.fixture_late_spawn({})'],
  ].map(([call]) => `try { await ${call}; return "BYPASS"; } catch { return "blocked"; }`);
  const toolStarted = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  let scenario = "catalog";
  let attempt = 0;
  const pngChunk = (name, data) => {
    const content = Buffer.concat([Buffer.from(name), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(content));
    return Buffer.concat([length, content, checksum]);
  };
  const imageHeader = Buffer.alloc(13); imageHeader.writeUInt32BE(1, 0); imageHeader.writeUInt32BE(1, 4); imageHeader[8] = 8; imageHeader[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", imageHeader), pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))), pngChunk("IEND", Buffer.alloc(0))]).toString("base64");
  const server = createServer(async (request, response) => {
    if (request.method === "GET") { response.setHeader("content-type", "application/json"); return response.end("{}"); }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    if (request.url === "/context") {
      assert.equal(request.headers.authorization, "Bearer fixture-only");
      brokerCalls.push(body);
      response.setHeader("content-type", "application/json");
      if (body.cancel) { cancelled.resolve(); return response.end("{}"); }
      if (scenario === "cancel") { toolStarted.resolve(); return; }
      if (body.name === "coworker_computer_observe") return response.end(JSON.stringify({ isError: false, content: [{ type: "text", text: "Fixture observation" }, { type: "image", mimeType: "image/png", data: png }] }));
      return response.end(JSON.stringify({ text: "Fixture broker result", structured: { fixture: true } }));
    }
    if (request.url === "/safe" || request.url === "/forbidden") { witnesses.push(request.url); return response.end("{}"); }
    assert.equal(body.model, "fixture", "Only the loopback fixture model may run");
    requests.push({ scenario, body, sessionID: request.headers["x-opencode-session"] });
    if (scenario === "retry") { response.writeHead(429, { "content-type": "application/json" }); return response.end(JSON.stringify({ error: { message: "Fixture rate limit", type: "rate_limit_error" } })); }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({ id: "fixture-response", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } : {}) })}\n\n`);
    let calls;
    if (attempt++ === 0) {
      if (scenario.startsWith("mcp-reads") || scenario.startsWith("execute-denied")) calls = [["execute", { code: readCode }]];
      if (scenario === "codemode") calls = [
        ["execute", { code: 'const value = await tools.fixture_ping({}); try { await tools.coworker_assignment_create({}); return "BYPASS"; } catch { return value; }' }],
        ["coworker_assignment_create", {}],
        ["coworker_worker_spawn", { name: "Forbidden", goal: "Forbidden", continuation: { objective: "Forbidden", resumeInstructions: "Forbidden" } }],
        ["fixture_management_alias", {}],
        ["fixture_late_spawn", { name: "Forbidden", goal: "Forbidden", continuation: { objective: "Forbidden", resumeInstructions: "Forbidden" } }],
      ];
      if (scenario.startsWith("protected")) calls = protectedCode.map((code) => ["execute", { code }]);
      if (scenario === "configured-alias") calls = [["fixture_late_click", { browser_url: "owned", target_id: "page", uid: "1", snapshot_id: "snapshot" }], ["execute", { code: 'try { await tools.fixture_late_click({}); return "BYPASS"; } catch { return "blocked"; }' }]];
      if (scenario === "cancel") calls = [["coworker_browser_tabs", {}]];
      if (scenario === "image") calls = [["coworker_computer_observe", { include_image: true }]];
    }
    if (calls) {
      chunk({ role: "assistant", tool_calls: calls.map(([name, args], index) => ({ index, id: `call_${scenario}_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
      chunk({}, "tool_calls");
    } else {
      const answer = scenario === "progress" ? '{"facts":["status"]}' : scenario === "memory" ? '{"shortTerm":[{"text":"The user set a budget of 42 EUR.","evidence":"Budget is 42 EUR."}],"longTerm":[]}' : "Native fixture complete";
      chunk({ role: "assistant", content: answer }); chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}`;
  const fixturePlugin = path.join(root, "fixture");
  await mkdir(fixturePlugin);
  await writeFile(path.join(fixturePlugin, "package.json"), '{"type":"module"}');
  await build({ stdin: { resolveDir: dependencies, contents: `import { Plugin } from "@opencode-ai/plugin/effect"; import { Effect, Scope } from "effect";
    export default Plugin.define({ id: "fixture.tools", effect: (ctx) => Effect.gen(function* () {
      yield* ctx.tool.transform((editor) => {
        for (const [name, route, options] of [["fixture_ping", "/safe", {}], ["coworker_assignment_create", "/forbidden", {}], ["fixture_management_alias", "/forbidden", {permission:"coworker_assignment_create"}], ["fixture_direct_only", "/forbidden", {codemode:false}], ["coworker_future_read", "/forbidden", {}]]) editor.add({ name, description: "Synthetic fixture witness", input: { type: "object", properties: {}, additionalProperties: false }, options: { codemode: true, permission: "fixture-witness", ...options }, execute: () => Effect.promise(async () => { await fetch(${JSON.stringify(fixtureUrl)} + route, { method: "POST", body: "{}" }); return { content: "Fixture witnessed" }; }) });
      });
      const scope = yield* Scope.Scope;
      const aliases = yield* Effect.cached(ctx.tool.transform((editor) => {
        for (const [id, name] of [["coworker_worker_spawn", "fixture_late_spawn"], ["coworker_browser_click", "fixture_late_click"]]) {
          const tool = editor.get(id); if (!tool) throw new Error("Missing alias source: " + id); editor.add({...tool, name});
        }
      }).pipe(Effect.provideService(Scope.Scope, scope)));
      yield* ctx.session.hook("prompt", () => aliases);
    }) });` }, bundle: true, platform: "node", format: "esm", target: "node22", outfile: path.join(fixturePlugin, "server.js"), logLevel: "silent" });
  await writeFile(path.join(workspace, "opencode.json"), JSON.stringify({
    plugins: [pathToFileURL(fixturePlugin).href], instructions: ["soul.md"],
    ...nativeConfig({ mcp: { coworker: mcp.mcpConfig("fixture-only") } }),
    agents: { ...coordinatorConfig().agents, build: { system: "CONFIGURED_BUILD_SENTINEL", permissions: [
      { action: "shell", resource: "*", effect: "deny" }, { action: "coworker_browser_click", resource: "*", effect: "deny" },
      { action: "skill", resource: "*", effect: "deny" }, { action: "skill", resource: "*cold-worker-guidance*", effect: "allow" },
    ] } },
  }));
  await writeFile(path.join(workspace, "soul.md"), "AMBIENT_PRIVATE_CANARY");
  await writeFile(path.join(config, "opencode.json"), JSON.stringify({ model: "fixture/fixture", warming: false, skills: [path.join(config, "skills")], providers: {
    fixture: { name: "Fixture", package: "@opencode-ai/ai/providers/openai-compatible", settings: { baseURL: `${fixtureUrl}/v1`, apiKey: "fixture-not-a-secret", name: "fixture" },
      models: { fixture: { name: "Fixture", cost: { input: 0.1, output: 0.2 }, capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], limit: { context: 128000, output: 4096 } } } },
  } }));
  configureNativePluginBundles(bundles);
  const home = { path: workspace, createdAt: "fixture-created", workspaceId: "ws_fixture" };
  await installCollaborationPlugin(home, { url: `${fixtureUrl}/context`, token: "fixture-only" });
  for (const install of [installBrowserPlugin, installComputerPlugin, installGroupDocumentPlugin, installEventPlugin, installProgressPlugin, installMemoryPlugin]) await install(home);
  await installAbilitiesPlugin(home, { url: `${fixtureUrl}/context`, token: "fixture-only" });
  assert.equal((await readdir(path.join(workspace, ".opencode"))).includes("node_modules"), false);
  assert.equal((await readdir(path.join(workspace, ".opencode"))).includes("package.json"), false);
  const env = {
    PATH: process.env.PATH, HOME: root, TMPDIR: tmpdir(), XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"), OPENCODE_CONFIG_DIR: config,
    OPENCODE_DB: path.join(root, "opencode.db"), OPENCODE_PASSWORD: "fixture-password", OPENCODE_MODELS_URL: fixtureUrl,
  };
  assert.equal(path.isAbsolute(binary), true, "Use the absolute repository-verified native binary, never PATH lookup");
  const version = spawnSync(binary, ["--version"], { cwd: workspace, env, encoding: "utf8", timeout: 15_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), `opencode2 v${NATIVE_PLUGIN_VERSION}`, "Native engine and plugin SDK must use the same exact release");
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise((resolve) => child.once("close", resolve)); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000); await closed; clearTimeout(timer);
  });
  child.stderr.resume();
  const url = await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Native listener did not start")), 30_000);
    child.once("error", reject);
    child.once("exit", () => { clearTimeout(timer); reject(new Error("Native engine exited before startup")); });
    child.stdout.on("data", (chunk) => { output = (output + String(chunk)).slice(-4000); const found = output.match(/server listening on (http:\/\/[^\s]+)/)?.[1]; if (found) { clearTimeout(timer); resolve(found); } });
  });
  const headers = { "content-type": "application/json", authorization: `Basic ${Buffer.from("opencode:fixture-password").toString("base64")}` };
  let location = workspace;
  const writes = [];
  const api = async (route, method = "GET", body) => {
    const target = new URL(url + route); target.searchParams.set("location[directory]", location);
    const response = await fetch(target, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    assert.equal(response.ok, true, route); return response.status === 204 ? undefined : response.json();
  };
  const transport = async (input, init) => {
    const route = new URL(input).pathname.replace("/workspace/ws_fixture/opencode2", "");
    const target = new URL(url + route + new URL(input).search); target.searchParams.set("location[directory]", location);
    let body = init?.body;
    if (route === "/api/session" && init?.method === "POST") body = JSON.stringify({ ...JSON.parse(body), location: { directory: location } });
    if (init?.method === "POST") writes.push({ location, route, body: body ? JSON.parse(body) : undefined });
    return fetch(target, { ...init, body, headers });
  };
  const options = { baseUrl: url, workspaceId: "ws_fixture", token: "fixture", fetch: transport, defaultModel: { providerId: "fixture", modelId: "fixture" }, requestTimeoutMs: 20_000 };
  const native = createNativeV2Client(options);
  const client = createHeadlessThreadClientV2(options);
  await api("/api/plugin/await-activation", "POST");
  const pluginState = await api("/api/plugin");
  for (const id of ["collaboration", "browser", "computer", "group-documents", "progress-summary", "auto-memory", "turn-roles", "events", "abilities"]) {
    const plugin = pluginState.data.find((item) => item.id === `coworker.${id}`);
    assert.equal(plugin?.state.status, "active", JSON.stringify(plugin ?? { location: pluginState.location, external: pluginState.data.filter((item) => item.source.type !== "builtin") }));
  }
  assert.deepEqual((await native.getAgent("coworker-worker")).permissions[0], { action: "*", resource: "*", effect: "deny" });
  // Use the same awaited post-activation barrier as main, before creating ANY
  // Worker session. Concurrent/repeated readiness must not append duplicate rules.
  const prepareRoles = () => prepareNativeTurnRoles((method, route, body) => api(route, method, body));
  await Promise.all([prepareRoles(), prepareRoles()]);
  async function turn(kind, agent) {
    scenario = kind; attempt = 0;
    const thread = await client.createThread({ title: `Fixture ${kind}`, agent });
    const receipt = await client.sendTurn(thread.id, { prompt: `Fixture ${kind}`, agent });
    if (kind !== "cancel") {
      const settled = await client.waitForThread(thread.id, { since: receipt, timeoutMs: 15_000, pollIntervalMs: 50 });
      assert.equal(settled.outcome, "settled", JSON.stringify(settled));
    }
    return thread.id;
  }
  const selectedSkill = (await native.listSkills()).find((skill) => skill.name === "cold-worker-guidance");
  assert.ok(selectedSkill?.content.includes(skillBody), "the known local skill is loaded by the native catalog");
  const skills = [{ id: selectedSkill.id }];
  // These are the first Worker sessions in two independent cold native locations.
  // Only the production workspace warmup barrier has run; no preparatory prompt.
  // The updated headless client's real permission preflight owns admission.
  await t.test("cold selected-skill Worker preserves a configured build deny before admission", async () => {
    const deniedWorkspace = path.join(root, "cold-skill-denied");
    await mkdir(deniedWorkspace);
    const deniedConfig = JSON.parse(await readFile(path.join(workspace, "opencode.json"), "utf8"));
    deniedConfig.agents.build.permissions.push({ action: "skill", resource: "*", effect: "deny" });
    await writeFile(path.join(deniedWorkspace, "opencode.json"), JSON.stringify(deniedConfig));
    await mkdir(path.join(deniedWorkspace, ".opencode"));
    await writeFile(path.join(deniedWorkspace, ".opencode", "coworker-abilities.json"), JSON.stringify({ directory: deniedWorkspace,
      createdAt: "fixture-denied-created", workspaceId: "ws_fixture", abilities: defaultCoworkerAbilities(), url: `${fixtureUrl}/context`, token: "fixture-only" }));
    location = deniedWorkspace;
    try {
      await api("/api/plugin/await-activation", "POST");
      await prepareRoles();
      assert.deepEqual((await native.getAgent("coworker-worker")).permissions, [...(await native.getAgent("build")).permissions, ...NATIVE_TURN_ROLES.find((role) => role.id === "coworker-worker").permissions], "the negative case evaluates final inheritance, not a placeholder deny");
      assert.equal(requests.length, 0);
      const thread = await client.createThread({ title: "Cold denied skill", agent: "coworker-worker" });
      const before = writes.length;
      await assert.rejects(client.sendTurn(thread.id, { prompt: "Cold denied skill", skills, agent: "coworker-worker" }), { code: "skill_denied" });
      assert.ok(writes.slice(before).some((write) => write.route === `/api/session/${thread.id}/permission`));
      assert.ok(!writes.slice(before).some((write) => /\/(prompt|synthetic|reply)$/.test(write.route)));
      assert.deepEqual(await native.readHistory(thread.id), []);
      assert.equal(requests.length, 0, "denied selected skills never reach inference");
    } finally { location = workspace; }
  });
  await t.test("cold selected-skill Worker inherits configured build permission before its first prompt", async () => {
    assert.equal(requests.length, 0);
    const thread = await client.createThread({ title: "Cold allowed skill", agent: "coworker-worker" });
    scenario = "cold-selected-skill"; attempt = 0;
    const before = writes.length;
    const receipt = await client.sendTurn(thread.id, { prompt: "Cold allowed skill", skills, agent: "coworker-worker" });
    const settled = await client.waitForThread(thread.id, { since: receipt, timeoutMs: 15_000, pollIntervalMs: 50 });
    assert.equal(settled.outcome, "settled", JSON.stringify(settled));
    const admitted = writes.slice(before);
    const prompt = admitted.findIndex((write) => write.route.endsWith("/prompt"));
    assert.ok(prompt > 0 && admitted.slice(0, prompt).some((write) => write.route === `/api/session/${thread.id}/permission`));
    assert.deepEqual(admitted[prompt].body.skills, skills);
    assert.equal(JSON.stringify(admitted[prompt].body).includes(skillBody), false, "the client submits native IDs, not skill bodies");
    assert.equal(requests[0].scenario, "cold-selected-skill");
    assert.ok(JSON.stringify(requests[0].body).includes(skillBody), "the selected skill is present in the first model request");
    assert.deepEqual((await native.getAgent("coworker-worker")).permissions, [...(await native.getAgent("build")).permissions, ...NATIVE_TURN_ROLES.find((role) => role.id === "coworker-worker").permissions]);
  });
  for (const role of NATIVE_TURN_ROLES.filter((role) => role.id.startsWith("coworker-worker"))) {
    await turn(role.id, nativeTurnAgent({ tools: role.tools }));
    const names = requests.find((item) => item.scenario === role.id).body.tools.map((tool) => tool.function.name);
    assert.equal(names.includes("subagent"), false); assert.equal(names.includes("question"), false);
    assert.equal(names.includes("coworker_worker_spawn"), false); assert.equal(names.includes("coworker_assignment_create"), false);
    assert.equal(names.includes("coworker_browser_tabs"), role.tools.coworker_browser_tabs === true);
    assert.equal(names.includes("coworker_computer_observe"), role.tools.coworker_computer_observe === true);
    for (const name of ["coworker_event_create", "coworker_event_update", "coworker_event_manage"]) if (role.tools[name] === false) assert.equal(names.includes(name), false);
    assert.equal(names.includes("coworker_browser_click"), false, "selected control cannot override configured denial");
    assert.ok(names.includes("coworker_group_document_read") && names.includes("coworker_group_document_save"), "Workers retain document access");
  }
  await turn("coordinator", NATIVE_COORDINATOR_AGENT);
  assert.equal((requests.find((entry) => entry.scenario === "coordinator").body.tools ?? []).length, 0);
  const base = (await api("/api/agent/build")).data;
  for (const role of NATIVE_TURN_ROLES) {
    const actual = (await api(`/api/agent/${role.id}`)).data;
    assert.deepEqual(actual.permissions, [...base.permissions, ...role.permissions]);
    assert.equal(actual.system, base.system);
  }
  const toolParts = async (thread) => (await native.readHistory(thread)).flatMap((message) => message.content ?? []).filter((part) => part.type === "tool");
  for (const agent of ["build", "coworker-worker"]) {
    const before = mcpCalls.length;
    const thread = await turn(`mcp-reads-${agent}`, agent);
    const parts = await toolParts(thread);
    const executed = parts.find((part) => part.name === "execute");
    assert.equal(executed?.state.status, "completed", JSON.stringify(parts));
    assert.deepEqual(JSON.parse(executed.state.content.find((part) => part.type === "text").text), { total: 2, reviewed: [{ title: "Launch review", summary: "Two launch checks remain.", revision: 1 }] });
    assert.deepEqual(mcpCalls.slice(before), [{ name: "documents_list", slug: "workspace", args: {} }, { name: "document_read", slug: "workspace", args: { id: "launch-review" } }]);
    assert.equal(executed.state.metadata.toolCalls.length, 2);
    assert.ok(executed.state.metadata.toolCalls.every((call) => call.status === "completed"));
    const names = requests.find((item) => item.scenario === `mcp-reads-${agent}`).body.tools.map((tool) => tool.function.name);
    assert.equal(names.includes("fixture_late_spawn"), agent === "build", "the late alias exists and follows the canonical role permission");
    for (const name of ["coworker_document_create", "coworker_document_update", "coworker_document_archive", "coworker_context_set"]) assert.ok(names.includes(name), `${agent} retains direct rich receipts: ${name}`);
    assert.equal(names.includes("coworker_documents_list"), false);
    assert.equal(names.includes("coworker_document_read"), false);
    const protectedThread = await turn(`protected-${agent}`, agent);
    const protectedParts = await toolParts(protectedThread);
    assert.equal(protectedParts.length, protectedCode.length);
    assert.ok(protectedParts.every((part) => part.name === "execute" && part.state.status === "completed" && part.state.content.some((item) => item.type === "text" && item.text === "blocked")), JSON.stringify(protectedParts));
    assert.equal(mcpCalls.length, before + 2, "protected execute attempts never reach MCP handlers");
    assert.equal(brokerCalls.length, 0, "protected execute attempts never reach /context");
    assert.deepEqual(witnesses, [], "explicit direct, new tools and aliases cannot escape through Code Mode");
  }
  assert.deepEqual(documentChanges, []);
  assert.deepEqual(await listDocuments(root, "workspace"), seededDocuments, "protected mutations leave document bytes and revisions unchanged");
  const configuredAlias = await toolParts(await turn("configured-alias", "build"));
  assert.equal(configuredAlias.find((part) => part.name === "fixture_late_click").state.status, "error");
  assert.ok(configuredAlias.find((part) => part.name === "execute").state.content.some((part) => part.type === "text" && part.text === "blocked"));
  assert.equal(brokerCalls.length, 0, "late alias retains configured canonical browser deny");
  const codeThread = await turn("codemode", "coworker-worker");
  assert.deepEqual(witnesses, ["/safe"], "Code Mode stays useful but cannot reach privileged management");
  assert.equal(brokerCalls.length, 0);
  const codeHistory = await native.readHistory(codeThread);
  const denied = codeHistory.flatMap((message) => message.content ?? []).filter((part) => part.type === "tool" && part.name !== "execute");
  assert.equal(denied.length, 4);
  assert.ok(denied.every((part) => part.state.status === "error"));
  const denyHome = { path: path.join(root, "execute-denied") };
  await mkdir(denyHome.path);
  const denyConfig = JSON.parse(await readFile(path.join(workspace, "opencode.json"), "utf8"));
  denyConfig.agents.build.permissions.push({ action: "execute", resource: "*", effect: "deny" });
  await writeFile(path.join(denyHome.path, "opencode.json"), JSON.stringify(denyConfig));
  // Configured absolute plugin paths reuse the isolated bundles, not a profile.
  location = denyHome.path;
  await api("/api/plugin/await-activation", "POST");
  const readsBeforeDeny = mcpCalls.length;
  for (const agent of ["build", "coworker-worker"]) {
    const thread = await turn(`execute-denied-${agent}`, agent);
    const parts = await toolParts(thread);
    assert.equal(parts.find((part) => part.name === "execute").state.status, "error");
    const body = requests.find((item) => item.scenario === `execute-denied-${agent}`).body;
    assert.equal(body.tools.some((tool) => tool.function.name === "execute"), false);
    assert.doesNotMatch(JSON.stringify(body.messages), /Use native execute for eligible/);
  }
  assert.equal(mcpCalls.length, readsBeforeDeny, "configured execute deny prevents all nested reads");
  location = workspace;
  const imageThread = await turn("image", "coworker-worker-computer");
  const imageHistory = await native.readHistory(imageThread);
  const image = imageHistory.flatMap((message) => message.content ?? []).find((part) => part.type === "tool" && part.name === "coworker_computer_observe");
  assert.ok(image.state.content.some((part) => part.type === "file" && part.mime.startsWith("image/") && part.uri.startsWith("data:")), JSON.stringify(image.state));
  const imageCall = brokerCalls.find((call) => call.name === "coworker_computer_observe");
  assert.equal(imageCall.context.callID, image.id); assert.equal(imageCall.context.sessionID, imageThread); assert.equal(imageCall.context.directory, workspace);
  const cancelThread = await turn("cancel", "coworker-worker-browser");
  await toolStarted.promise;
  await client.abortThread(cancelThread);
  await cancelled.promise;
  const cancellation = brokerCalls.filter((call) => call.context.sessionID === cancelThread);
  assert.equal(cancellation.length, 2); assert.deepEqual(cancellation[1], { ...cancellation[0], cancel: true });
  const model = { providerId: "fixture", modelId: "fixture" };
  scenario = "progress"; attempt = 0;
  const progress = await summarizeProgress(client, model, { prompt: '[{"id":"status","text":"Preparing a reply."}]' });
  assert.equal(progress, '{"facts":["status"]}');
  scenario = "memory"; attempt = 0;
  const memory = await extractConversationMemory(client, model, { prompt: '{"recent":[{"id":"one","speaker":"user","text":"Budget is 42 EUR."}],"shortTerm":[],"longTerm":[]}' });
  assert.equal(JSON.parse(memory).shortTerm[0].evidence, "Budget is 42 EUR.");
  for (const [kind, limit] of [["progress", 80], ["memory", 1000]]) {
    const calls = requests.filter((entry) => entry.scenario === kind); assert.equal(calls.length, 1);
    assert.equal(calls[0].body.max_completion_tokens ?? calls[0].body.max_tokens, limit);
    assert.equal(calls[0].body.tools, undefined); assert.doesNotMatch(JSON.stringify(calls[0].body), /AMBIENT_PRIVATE_CANARY|CONFIGURED_BUILD_SENTINEL/);
  }
  scenario = "retry"; attempt = 0;
  await assert.rejects(summarizeProgress(client, model, { prompt: '[{"id":"status","text":"Preparing a reply."}]' }));
  assert.equal(requests.filter((entry) => entry.scenario === "retry").length, 1);
  assert.equal((await readdir(path.join(workspace, ".opencode"))).includes("node_modules"), false);
});
