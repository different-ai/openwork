import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { withAbort } from "./collaboration.mjs";
import { coworkerIdentity } from "./event-execution.mjs";
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
import { TEAM_SCOPE, createCoworkerToolsServer, createToolHandlers } from "./coworker-tools.mjs";
import { createDocument, listDocuments } from "./documents.mjs";
import { nativeConfig } from "./native-config.mjs";
import { awaitNativePluginActivation, prepareNativeTurnRoles } from "./turn-roles-plugin.mjs";
import { createCoworker, listCoworkers, readHomeContext, updateCoworker, writeCoworkerFile, agentsTemplate, COWORKER_INSTRUCTIONS } from "./coworkers.mjs";
import { teamWorkspaceDirectory, teamWorkspaceId, updateTeamWorkspaceConfig } from "./team-workspace.mjs";
import { assertOwnedNativeTool, createTeamSessionRegistry } from "./team-sessions.mjs";
import { coworkerAgent } from "./native-turns.mjs";
import { readNativeSourceFixture, prepareNativeSourceBundles, installNativeSourceFixture } from "./native-source-fixture.mjs";
import { resolveNativeFilesystemScope } from "./team-sessions.mjs";

const sourceManifestPath = process.env.OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST;

const binary = process.env.OPENWORK_TEST_NATIVE_V2_BIN;
const bundles = process.env.OPENWORK_COWORKER_PLUGIN_BUNDLE_DIR;
const dependencies = process.env.COWORKER_NATIVE_PLUGIN_TEST_ROOT;

test(`bundled native plugins enforce roles, Code Mode isolation, scoped cancellation and bounded inference in ${NATIVE_PLUGIN_VERSION}`, {
  skip: sourceManifestPath ? "The source candidate uses its separate matching-SDK case" : !binary || !bundles || !dependencies, timeout: 90_000,
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
  let sharedRegistry;
  let sharedRoot;
  const sharedOwners = new Map();
  const sharedExecutions = new Map();
  const sharedErrors = [];
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
      if (scenario.startsWith("shared")) {
        try {
          const admitted = await sharedRegistry.context(body.context);
          if (body.name === "session_context") return response.end(JSON.stringify({ slug: admitted.binding.slug, createdAt: admitted.binding.createdAt,
            abilities: admitted.coworker.abilities, homeDirectory: admitted.coworker.path, homeContext: await readHomeContext(sharedRoot, admitted.binding.slug) }));
          const snapshot = await client.getThreadSnapshot(body.context.sessionID);
          assertOwnedNativeTool({ slug: admitted.binding.slug, context: body.context, name: `coworker_${body.name}`, args: body.args, entry: admitted.entry, snapshot, workspaceId: admitted.binding.workspaceId, active: true });
          const result = await createToolHandlers({ coworkersDir: sharedRoot })[body.name](admitted.binding.slug, body.args);
          return response.end(JSON.stringify(result));
        } catch (error) { sharedErrors.push(error.message); response.statusCode = 403; return response.end(JSON.stringify({ error: error.message })); }
      }
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
      if (scenario === "shared-tools") calls = [["coworker_document_read", { id: "private" }]];
      if (scenario === "shared-files") calls = [["read", { path: "beta/soul.md" }], ["read", { path: "alpha/soul.md" }], ["grep", { pattern: "HOME_beta_PRIVATE" }], ["grep", { pattern: "HOME_beta_PRIVATE", path: sharedRoot }], ["grep", { pattern: "HOME_alpha_PRIVATE" }]];
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
  await t.test("older native runtime retains owned history and refuses unsupported scoped tool dispatch", async (sharedTest) => {
    sharedRoot = path.join(root, "team");
    await mkdir(sharedRoot);
    const sharedDirectory = teamWorkspaceDirectory(sharedRoot);
    await mkdir(sharedDirectory);
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const owner = await createCoworker(sharedRoot, { name });
      const current = await updateCoworker(sharedRoot, owner.slug, { workspaceId: "ws_fixture" });
      sharedOwners.set(owner.slug, current);
      await writeCoworkerFile(sharedRoot, owner.slug, "soul.md", `HOME_${owner.slug}_PRIVATE`);
      await createDocument(sharedRoot, owner.slug, { title: "Private", summary: `DOC_${owner.slug}_PRIVATE`, body: `## Private\nDOC_${owner.slug}_PRIVATE` });
    }
    sharedRegistry = createTeamSessionRegistry({ file: path.join(root, "host-session-bindings.json"),
      coworkerFor: async (slug) => sharedOwners.get(slug), executionFor: async (binding) => sharedExecutions.get(binding.sessionId) });
    await writeFile(path.join(sharedDirectory, "opencode.json"), JSON.stringify({ instructions: [], plugins: [pathToFileURL(fixturePlugin).href],
      ...nativeConfig({ mcp: { coworker: mcp.mcpConfig("fixture-only") } }), agents: { build: { permissions: [{ action: "shell", resource: "*", effect: "deny" }] } } }));
    await updateTeamWorkspaceConfig(sharedRoot, [...sharedOwners.values()]);
    const team = { path: sharedDirectory, workspaceId: "ws_fixture" };
    await installCollaborationPlugin(team, { mode: "team", url: `${fixtureUrl}/context`, token: "fixture-only" });
    for (const install of [installBrowserPlugin, installComputerPlugin, installGroupDocumentPlugin, installEventPlugin, installProgressPlugin, installMemoryPlugin]) await install(team);
    await installAbilitiesPlugin(team, { url: `${fixtureUrl}/context`, token: "fixture-only", coworkers: [...sharedOwners.values()] });
    location = sharedDirectory;
    await api("/api/plugin/await-activation", "POST");
    const configured = await native.getAgent("build");
    assert.ok(configured.permissions.some((rule) => rule.action === "external_directory" && rule.resource === "*" && rule.effect === "ask"));
    assert.deepEqual(configured.permissions.at(-1), { action: "shell", resource: "*", effect: "deny" });
    await prepareRoles();
    const beforeConfig = await readFile(path.join(sharedDirectory, "opencode.json"), "utf8");
    const threads = new Map();
    async function ownedTurn(slug, kind, agent = coworkerAgent(slug), thread = threads.get(slug)) {
      scenario = kind; attempt = 0;
      const owner = sharedOwners.get(slug);
      const ownedClient = createHeadlessThreadClientV2({ ...options, defaultAgent: agent, onIntent: ({ threadId }) => sharedRegistry.bind({ slug, createdAt: owner.createdAt, sessionId: threadId, workspaceId: "ws_fixture", directory: sharedDirectory, kind: "private" }) });
      thread ??= await ownedClient.createThread({ title: `Owned ${slug}`, metadata: { coworker: "beta", coworkerCreatedAt: "forged" } });
      threads.set(slug, thread);
      const messageId = `msg_shared_${slug}_${sharedExecutions.size}_${kind.replaceAll("-", "_")}`;
      sharedExecutions.set(thread.id, { id: `execution-${messageId}`, owner: { slug, threadId: thread.id, kind: "private" },
        coworkerCreatedAt: owner.createdAt, workspaceId: "ws_fixture", messageId, agent, model, state: "running", sentAt: Date.now() });
      const receipt = await ownedClient.sendTurn(thread.id, { prompt: kind, messageId, agent });
      const result = await ownedClient.waitForThread(thread.id, { since: receipt, timeoutMs: 15_000, pollIntervalMs: 50 });
      assert.equal(result.outcome, "settled", JSON.stringify({ result, sharedErrors }));
      return thread;
    }
    for (const slug of sharedOwners.keys()) {
      const thread = await ownedTurn(slug, `shared-${slug}`);
      assert.equal((await native.getSession(thread.id)).location.directory, sharedDirectory);
      const body = JSON.stringify(requests.find((request) => request.scenario === `shared-${slug}`).body);
      assert.match(body, new RegExp(`HOME_${slug}_PRIVATE`));
      for (const other of sharedOwners.keys()) if (other !== slug) assert.doesNotMatch(body, new RegExp(`HOME_${other}_PRIVATE`));
      assert.ok((await native.getAgent(coworkerAgent(slug))).permissions.some((rule) => rule.action === "shell" && rule.effect === "deny"));
    }
    await ownedTurn("alpha", "shared-tools");
    const parts = await toolParts(threads.get("alpha").id);
    const document = parts.find((part) => part.name === "coworker_document_read");
    assert.equal(document?.state.status, "error", JSON.stringify(document));
    assert.match(JSON.stringify(document.state), /does not support admitted invocation filesystem scope/);
    assert.doesNotMatch(JSON.stringify(document.state), /DOC_alpha_PRIVATE|DOC_beta_PRIVATE/);
    await ownedTurn("alpha", "shared-files");
    const fileParts = (await toolParts(threads.get("alpha").id)).filter((part) => part.name === "read");
    assert.equal(fileParts.length, 2);
    assert.equal(fileParts[0].state.status, "error", JSON.stringify(fileParts));
    assert.equal(fileParts[1].state.status, "error", JSON.stringify(fileParts));
    const searches = (await toolParts(threads.get("alpha").id)).filter((part) => part.name === "grep");
    assert.equal(searches.length, 3);
    assert.ok(searches.every((part) => part.state.status === "error"), JSON.stringify(searches));
    assert.doesNotMatch(JSON.stringify(searches.map((part) => part.state.content)), /HOME_beta_PRIVATE|HOME_alpha_PRIVATE/);
    const role = nativeTurnAgent({ slug: "alpha", tools: NATIVE_TURN_ROLES.find((role) => role.id === "coworker-no-computer").tools });
    await ownedTurn("alpha", "shared-role", role);
    assert.equal((await sharedRegistry.resolve(threads.get("alpha").id)).slug, "alpha");
    await assert.rejects(sharedRegistry.resolve(threads.get("alpha").id, sharedOwners.get("beta")), /matching host owner/);
    const requestCount = requests.length;
    scenario = "shared-unknown";
    const unknown = await client.createThread({ title: "Unowned", agent: coworkerAgent("alpha"), metadata: { coworker: "alpha" } });
    const refused = await client.sendTurn(unknown.id, { prompt: "Unowned", agent: coworkerAgent("alpha") });
    await client.waitForThread(unknown.id, { since: refused, timeoutMs: 15_000, pollIntervalMs: 50 });
    assert.equal(requests.length, requestCount, "native metadata alone cannot obtain another owner's context");
    const legacyOwner = { slug: "workspace", createdAt: "1970-01-01T00:00:00.000Z", workspaceId: "ws_legacy", path: workspace };
    sharedOwners.set("workspace", legacyOwner);
    location = workspace;
    const old = await native.getSession(codeThread);
    await sharedRegistry.importLegacy({ owner: legacyOwner, workspace: { id: "ws_legacy", path: workspace }, sessions: [old], classify: () => "private" });
    const beforeLookup = writes.length;
    const recovered = await sharedRegistry.route(codeThread, legacyOwner, async (binding) => {
      assert.equal(binding.directory, workspace);
      return native;
    });
    assert.equal(recovered.session.id, codeThread);
    assert.ok((await recovered.client.readHistory(codeThread)).length > 0);
    assert.equal(writes.length, beforeLookup, "legacy recovery performs no input or move writes");
    location = sharedDirectory;
    sharedOwners.delete("workspace");
    sharedOwners.set("alpha", await updateCoworker(sharedRoot, "alpha", { model: "fixture/fixture", modelVariant: "new-preference" }));
    assert.equal(await updateTeamWorkspaceConfig(sharedRoot, await listCoworkers(sharedRoot)), false);
    assert.equal(await readFile(path.join(sharedDirectory, "opencode.json"), "utf8"), beforeConfig);
    sharedOwners.set("beta", { ...sharedOwners.get("beta"), createdAt: "replacement" });
    await assert.rejects(sharedRegistry.resolve(threads.get("beta").id), /replaced coworker/);
    await sharedTest.test("role readiness does not advertise an unobserved native scope capability", async () => {
      const blockedRoot = path.join(root, "policy-boundary");
      await mkdir(path.join(blockedRoot, ".opencode"), { recursive: true });
      const config = JSON.parse(beforeConfig);
      config.agents.build.permissions = [];
      await writeFile(path.join(blockedRoot, "opencode.json"), JSON.stringify(config));
      for (const file of ["coworker-context.json", "coworker-abilities.json"]) await writeFile(path.join(blockedRoot, ".opencode", file), await readFile(path.join(sharedDirectory, ".opencode", file)));
      location = blockedRoot;
      await api("/api/plugin/await-activation", "POST");
      const plugins = await api("/api/plugin");
      assert.equal(plugins.data.find((plugin) => plugin.id === "coworker.turn-roles").state.status, "active");
      const policy = (await native.getAgent("build")).permissions;
      assert.ok(policy.some((rule) => rule.action === "external_directory" && rule.effect === "ask"));
      const target = new URL(url + "/api/rpc/coworker.turn-roles/prepare");
      target.searchParams.set("location[directory]", blockedRoot);
      const response = await fetch(target, { method: "POST", headers, body: JSON.stringify({ input: {} }), signal: AbortSignal.timeout(15_000) });
      assert.equal(response.ok, true);
      const readiness = (await response.json()).output;
      assert.equal(readiness.filesystemScopeRequired, true);
      assert.equal(readiness.filesystemScopeVersion, undefined, "only a real invocation may advertise filesystem scope support");
    });
    location = workspace;
  });
});

test("source native embedded setup preserves broad shell approvals in one location", { skip: !sourceManifestPath, timeout: 120_000 }, async (t) => {
  if (!process.env.OPENWORK_EMBEDDED_V2_TEST_ROOT) {
    const isolated = await realpath(await mkdtemp(path.join(tmpdir(), "coworker-embedded-process-")));
    t.after(() => rm(isolated, { recursive: true, force: true }));
    const child = spawn(process.execPath, ["--test", "--test-name-pattern=source native embedded", fileURLToPath(import.meta.url)], {
      env: { PATH: process.env.PATH, HOME: isolated, TMPDIR: isolated, XDG_CONFIG_HOME: path.join(isolated, "config"), XDG_DATA_HOME: path.join(isolated, "data"),
        XDG_CACHE_HOME: path.join(isolated, "cache"), XDG_STATE_HOME: path.join(isolated, "state"), OPENWORK_DEV_MODE: "1", OPENWORK_EMBEDDED_V2_TEST_ROOT: isolated,
        OPENWORK_RUNTIME_DB: path.join(isolated, "runtime.sqlite"), OPENWORK_ENV_STORE: path.join(isolated, "env.json"),
        OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST: sourceManifestPath,
        ...(process.env.OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST_SHA256 ? { OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST_SHA256: process.env.OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST_SHA256 } : {}),
      }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (bytes) => { output += bytes; }); child.stderr.on("data", (bytes) => { output += bytes; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 110_000);
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timer);
    console.info(output);
    assert.equal(code, 0, output);
    return;
  }
  const manifest = await readNativeSourceFixture(sourceManifestPath);
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "coworker-source-scope-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const team = path.join(root, "team"), config = path.join(root, "config"), nativeTmp = path.join(root, "native-tmp");
  for (const directory of [team, config, nativeTmp]) await mkdir(directory);
  const runtime = teamWorkspaceDirectory(team);
  await mkdir(runtime);
  const workspaceId = teamWorkspaceId(team);
  const owners = new Map();
  for (const name of ["Alpha", "Beta", "Gamma"]) {
    const created = await createCoworker(team, { name });
    const legacyId = `ws_${createHash("sha256").update(created.path).digest("hex").slice(0, 12)}`;
    const owner = await updateCoworker(team, created.slug, { workspaceId: legacyId });
    owners.set(owner.slug, owner);
    await writeCoworkerFile(team, owner.slug, "soul.md", `ONLY_${owner.slug}_MEMORY`);
    await writeCoworkerFile(team, owner.slug, "denied.txt", "DENIED_PRIVATE_CONTENT");
    await createDocument(team, owner.slug, { title: "Private", summary: `ONLY_${owner.slug}_DOCUMENT`, body: `## Private\nONLY_${owner.slug}_DOCUMENT` });
    await writeCoworkerFile(team, owner.slug, "opencode.json", JSON.stringify({ permissions: [
      { action: "read", resource: "denied.txt", effect: "deny" }, { action: "shell", resource: "touch *", effect: "deny" },
    ] }));
  }
  const executions = new Map(), activations = new Set(), attempts = new Map();
  const requests = [], scopeCalls = [], brokerErrors = [];
  let api, client;
  let providerKey = "synthetic";
  const registry = createTeamSessionRegistry({ file: path.join(root, "owners.json"), coworkerFor: async (slug) => owners.get(slug), executionFor: async (binding) => executions.get(binding.sessionId) });
  const witness = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    response.setHeader("content-type", "application/json");
    if (request.url === "/activation") { activations.add(body.directory); return response.end("{}"); }
    if (request.url === "/context") {
      try {
        assert.equal(request.headers.authorization, "Bearer synthetic-scope");
        const admitted = await registry.context(body.context);
        if (body.name === "session_context") return response.end(JSON.stringify({ slug: admitted.binding.slug, createdAt: admitted.binding.createdAt,
          abilities: admitted.coworker.abilities, homeContext: await readHomeContext(team, admitted.binding.slug) }));
        if (body.name === "filesystem_scope") {
          assert.equal(body.context.filesystemScopeVersion, 1);
          assert.equal(body.context.filesystemScopeProjectResolution, 1);
          const snapshot = await client.getThreadSnapshot(body.context.sessionID);
          const assistant = snapshot.messages.find((message) => message.id === body.context.messageID && message.role === "assistant");
          assert.equal(assistant?.parentId, admitted.entry.messageId);
          const filesystemScope = await resolveNativeFilesystemScope(admitted.coworker, body.context);
          scopeCalls.push({ sessionId: body.context.sessionID, scope: filesystemScope });
          return response.end(JSON.stringify({ filesystemScope }));
        }
        if (body.name === "documents_list") {
          const snapshot = await client.getThreadSnapshot(body.context.sessionID);
          assertOwnedNativeTool({ slug: admitted.binding.slug, context: body.context, name: "coworker_documents_list", args: body.args, entry: admitted.entry, snapshot, workspaceId: admitted.binding.workspaceId, active: true });
          return response.end(JSON.stringify(await createToolHandlers({ coworkersDir: team }).documents_list(admitted.binding.slug, body.args)));
        }
        throw new Error("Unexpected scope broker operation");
      } catch (error) { brokerErrors.push(error.message); response.statusCode = 403; return response.end(JSON.stringify({ error: error.message })); }
    }
    if (request.method === "GET") return response.end("{}");
    assert.equal(body.model, "fixture");
    assert.equal(request.headers.authorization, `Bearer ${providerKey}`);
    const marker = JSON.stringify(body.messages.filter((message) => message.role === "user").at(-1));
    const key = /CASE:([a-z-]+)/.exec(marker)?.[1];
    requests.push({ key, body });
    const attempt = attempts.get(key) ?? 0; attempts.set(key, attempt + 1);
    const [slug, scenario] = key.split("-");
    if (scenario === "cleanup" || scenario === "stop") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": held for native cleanup\n\n");
      return;
    }
    let calls;
    if (attempt === 0) {
      if (scenario === "own" || scenario === "follow" || scenario === "refreshed") calls = [["read", { path: "soul.md" }], ["shell", { command: "pwd" }]];
      if (scenario === "deny") calls = [["read", { path: "denied.txt" }], ["shell", { command: "touch denied-marker" }]];
      if (scenario === "cwd") calls = [["shell", { command: "touch peer-marker", workdir: owners.get("beta").path }]];
      if (scenario === "cd") calls = [["shell", { command: "cd ../beta && touch peer-marker" }]];
      if (scenario === "code") calls = [["execute", { code: 'return await tools.fixture_scoped_read({path:"soul.md"});' }]];
      if (scenario === "documents") calls = [["coworker_documents_list", {}]];
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason) => response.write(`data: ${JSON.stringify({ id: "scope-fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish_reason ?? null }], ...(finish_reason ? { usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } } : {}) })}\n\n`);
    if (calls) {
      chunk({ role: "assistant", tool_calls: calls.map(([name, args], index) => ({ index, id: `call_${key}_${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) });
      chunk({}, "tool_calls");
    } else { chunk({ role: "assistant", content: "Scope fixture complete" }); chunk({}, "stop"); }
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => witness.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { witness.close(resolve); witness.closeAllConnections(); }));
  const witnessUrl = `http://127.0.0.1:${witness.address().port}`;
  const sourceBundles = await prepareNativeSourceBundles(manifest, path.join(root, "source-bundles"));
  configureNativePluginBundles(sourceBundles.directory, { sourceBuild: sourceBundles.sourceBuild });
  const plugins = await installNativeSourceFixture(manifest, runtime, { "scope-witness.js": `import { Plugin } from "@opencode/plugin/effect"; import { Effect } from "effect";
    export default Plugin.define({id:"scope.witness",effect:(ctx)=>Effect.gen(function*(){
      yield* Effect.promise(()=>fetch(${JSON.stringify(witnessUrl + "/activation")},{method:"POST",body:JSON.stringify({directory:ctx.location.directory})}));
      yield* ctx.tool.transform((editor)=>{const read=editor.get("read");if(read)editor.add({...read,name:"fixture_scoped_read",options:{...read.options,codemode:true}});});
    })});` }, { includeCoworkerPlugins: false });
  const prepareShared = async () => {
    await writeFile(path.join(runtime, "opencode.json"), JSON.stringify({ plugins, instructions: [], permissions: [] }));
    await updateTeamWorkspaceConfig(team, [...owners.values()]);
    const teamHome = { path: runtime, workspaceId };
    await installCollaborationPlugin(teamHome, { mode: "team", url: witnessUrl + "/context", token: "synthetic-scope" });
    for (const install of [installComputerPlugin, installBrowserPlugin, installGroupDocumentPlugin, installEventPlugin, installProgressPlugin, installMemoryPlugin]) await install(teamHome);
    await installAbilitiesPlugin(teamHome, { url: witnessUrl + "/context", token: "synthetic-scope", coworkers: [...owners.values()] });
  };
  const witnessPlugin = plugins.at(-1);
  const env = { PATH: process.env.PATH, HOME: path.join(root, "home"), TMPDIR: nativeTmp, XDG_CONFIG_HOME: config, XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"), OPENCODE_MODELS_URL: witnessUrl, RECORD: "false" };
  const originalFetch = globalThis.fetch;
  const httpFailures = [];
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    if (!["127.0.0.1", "localhost"].includes(target.hostname)) throw new Error("The embedded fixture refuses external egress.");
    const response = await originalFetch(input, init);
    if (!response.ok) httpFailures.push({ method: init?.method ?? "GET", path: target.pathname, status: response.status, text: await response.clone().text() });
    return response;
  });
  const { startEmbeddedServer } = await import("../../server/dist/embedded-native.js");
  const { engineV2ByConfig } = await import("../../server/dist/engine-v2-preview.js");
  const provider = { name: "Fixture", npm: "@ai-sdk/openai-compatible", options: { baseURL: witnessUrl + "/v1", apiKey: "synthetic" },
    models: { fixture: { id: "fixture", name: "Fixture", tool_call: true, cost: { input: 0.1, output: 0.2 }, limit: { context: 128000, output: 4096 } } } };
  const legacyThreads = new Map(), legacyHistories = new Map(), legacyConfigs = new Map();
  for (const owner of owners.values()) {
    const config = JSON.parse(await readFile(path.join(owner.path, "opencode.json"), "utf8"));
    await writeFile(path.join(owner.path, "opencode.json"), JSON.stringify({ ...config, instructions: COWORKER_INSTRUCTIONS }));
    await writeFile(path.join(owner.path, "AGENTS.md"), agentsTemplate({ name: owner.name }));
    await installCollaborationPlugin(owner, { url: witnessUrl + "/context", token: "synthetic-scope" });
    for (const install of [installComputerPlugin, installBrowserPlugin, installGroupDocumentPlugin, installEventPlugin]) await install(owner);
    await installAbilitiesPlugin(owner, { url: witnessUrl + "/context", token: "synthetic-scope" });
    legacyConfigs.set(owner.slug, await readFile(path.join(owner.path, "opencode.json"), "utf8"));
  }
  const legacyHost = await startEmbeddedServer({ engine: "v2", opencodeV2Bin: manifest.executable.path, port: 0, host: "127.0.0.1",
    workspaces: [...owners.values()].map((owner) => owner.path), token: "client-fixture", hostToken: "host-fixture",
    configPath: path.join(root, "server.json"), approvalMode: "auto", logRequests: false,
    opencodeV2: { apiContract: "native-2", sourceBuild: sourceBundles.sourceBuild, workspaceDirectory: owners.get("alpha").path,
      rootDir: path.join(root, "engine"), env, config: { model: "fixture/fixture", plugins: [witnessPlugin], warming: false, update: "disable" } },
  });
  try {
    const response = await fetch(legacyHost.url + "/runtime-config/providers", { method: "PATCH", headers: { "content-type": "application/json", "X-OpenWork-Host-Token": "host-fixture" }, body: JSON.stringify({ provider: { fixture: provider } }) });
    assert.equal(response.ok, true);
    for (const owner of owners.values()) {
      const registered = await fetch(legacyHost.url + "/workspaces/local", { method: "POST", headers: { "content-type": "application/json", "X-OpenWork-Host-Token": "host-fixture" }, body: JSON.stringify({ folderPath: owner.path, name: owner.name, preset: "minimal" }) });
      assert.equal(registered.ok, true);
      assert.equal((await registered.json()).activeId, owner.workspaceId);
      const old = createHeadlessThreadClientV2({ baseUrl: legacyHost.url, workspaceId: owner.workspaceId, token: "client-fixture", apiContract: "native-2", defaultModel: { providerId: "fixture", modelId: "fixture" } });
      const thread = await old.createThread({ title: `Retained ${owner.slug}`, metadata: { originalOwner: owner.slug } });
      const receipt = await old.sendTurn(thread.id, { prompt: `CASE:${owner.slug}-legacy`, messageId: `msg_${owner.slug}_legacy` });
      const result = await old.waitForThread(thread.id, { since: receipt, timeoutMs: 15000, pollIntervalMs: 30 });
      assert.equal(result.outcome, "settled");
      legacyThreads.set(owner.slug, thread);
      legacyHistories.set(owner.slug, result.snapshot.messages.map((message) => message.id));
      await registry.bind({ slug: owner.slug, createdAt: owner.createdAt, sessionId: thread.id, workspaceId: owner.workspaceId, directory: owner.path, kind: "private" });
    }
  } finally { await legacyHost.stop(); }
  activations.clear();
  await prepareShared();
  const embedded = await startEmbeddedServer({ engine: "v2", opencodeV2Bin: manifest.executable.path, port: 0, host: "127.0.0.1", workspaces: [],
    token: "client-fixture", hostToken: "host-fixture", configPath: path.join(root, "server.json"), approvalMode: "auto", logRequests: false,
    opencodeV2: { apiContract: "native-2", sourceBuild: { version: manifest.executable.versionOutput.replace(/^opencode v/, ""), sha256: manifest.executable.sha256 },
      workspaceDirectory: runtime, rootDir: path.join(root, "engine"), env,
      config: { model: "fixture/fixture", plugins: [witnessPlugin], warming: false, update: "disable" } },
  });
  t.after(() => embedded.stop());
  const terminate = () => { void embedded.stop().finally(() => process.exit(1)); };
  process.once("SIGTERM", terminate); t.after(() => process.removeListener("SIGTERM", terminate));
  const url = embedded.url;
  const hostHeaders = { "content-type": "application/json", "X-OpenWork-Host-Token": "host-fixture" };
  const ownerResponse = await fetch(url + "/tokens", { method: "POST", headers: hostHeaders, body: JSON.stringify({ scope: "owner", label: "Synthetic owner" }) });
  assert.equal(ownerResponse.ok, true);
  const ownerToken = (await ownerResponse.json()).token;
  assert.equal(typeof ownerToken, "string");
  const headers = { "content-type": "application/json", authorization: `Bearer ${ownerToken}` };
  const host = async (route, method = "GET", body) => {
    const response = await fetch(url + route, { method, headers: hostHeaders, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const text = await response.text(); assert.equal(response.ok, true, route + " " + text); return text ? JSON.parse(text) : undefined;
  };
  const registered = await host("/workspaces/local", "POST", { folderPath: runtime, name: "Synthetic team", preset: "minimal" });
  assert.equal(registered.activeId, workspaceId);
  assert.equal(embedded.config.workspaces.length, 4);
  for (const owner of owners.values()) assert.ok(embedded.config.workspaces.some((workspace) => workspace.id === owner.workspaceId && workspace.path === owner.path));
  await host("/runtime-config/providers", "PATCH", { provider: { fixture: provider } });
  const engine = engineV2ByConfig.get(embedded.config);
  await engine.refresh();
  api = async (route, method = "GET", body) => {
    const response = await fetch(`${url}/workspace/${workspaceId}/opencode2${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const text = await response.text(); assert.equal(response.ok, true, route + " " + text); return text ? JSON.parse(text) : undefined;
  };
  const mcp = await createCoworkerToolsServer({ resolveSlug: (token) => token === "synthetic-scope" ? TEAM_SCOPE : null, handlers: createToolHandlers({ coworkersDir: team }) });
  t.after(() => mcp.stop());
  const mcpResponse = await fetch(`${url}/workspace/${workspaceId}/mcp`, { method: "POST", headers, body: JSON.stringify({ name: "coworker", config: mcp.mcpConfig("synthetic-scope") }), signal: AbortSignal.timeout(30000) });
  assert.equal(mcpResponse.ok, true, await mcpResponse.text());
  const mcpState = await api("/api/mcp");
  assert.ok(mcpState.data.some((entry) => entry.name === "coworker" && entry.status.status === "connected"));
  assert.equal(legacyThreads.size, 3);
  assert.deepEqual((await listCoworkers(team)).map((owner) => owner.slug), ["alpha", "beta", "gamma"]);
  await assert.rejects(readFile(path.join(team, "opencode.json")), { code: "ENOENT" });
  const activation = await awaitNativePluginActivation((method, route) => api(route, method), { apiContract: "native-2" });
  assert.ok(["coworker.abilities", "coworker.turn-roles", "opencode.config.agent"].every((id) => activation.data.some((plugin) => plugin.id === id && plugin.state.status === "active")));
  await prepareNativeTurnRoles((method, route, body) => api(route, method, body), { requireFilesystemScope: true });
  const options = { baseUrl: url, workspaceId, token: ownerToken, apiContract: "native-2", defaultModel: { providerId: "fixture", modelId: "fixture" } };
  client = createHeadlessThreadClientV2(options);
  const native = createNativeV2Client(options);
  const threads = new Map();
  async function turn(slug, scenario, approve, previousScenario) {
    const owner = owners.get(slug), key = `${slug}-${scenario}`, agent = coworkerAgent(slug);
    let thread = threads.get(previousScenario ? `${slug}-${previousScenario}` : key);
    if (!thread) {
      const creator = createHeadlessThreadClientV2({ ...options, defaultAgent: agent, onIntent: ({ threadId }) => registry.bind({ slug, createdAt: owner.createdAt, sessionId: threadId, workspaceId: owner.workspaceId, nativeWorkspaceId: workspaceId, directory: runtime, kind: "private" }) });
      thread = await creator.createThread({ title: key, metadata: { coworker: "forged", filesystemScope: { directory: owners.get("beta").path } } }); threads.set(key, thread);
    }
    threads.set(key, thread);
    const messageId = `msg_${key.replaceAll("-", "_")}`;
    executions.set(thread.id, { id: `execution-${key}`, owner: { slug, threadId: thread.id, kind: "private" }, coworkerCreatedAt: owner.createdAt,
      workspaceId: owner.workspaceId, messageId, model: options.defaultModel, agent, state: "running", sentAt: Date.now() });
    const receipt = await client.sendTurn(thread.id, { prompt: `CASE:${key}`, messageId, agent }).catch((error) => { throw new Error(JSON.stringify({ message: error.message, code: error.code, httpFailures, brokerErrors })); });
    if (approve) {
      let pending;
      for (let index = 0; index < 150; index++) { pending = (await native.listPermissions(thread.id)).find((item) => item.action === "external_directory"); if (pending) break; await new Promise((resolve) => setTimeout(resolve, 30)); }
      assert.ok(pending, JSON.stringify({ brokerErrors, requests: requests.map(({ key }) => key) }));
      assert.ok(pending.resources.some((resource) => resource.includes("beta")));
      await assert.rejects(readFile(path.join(owners.get("beta").path, "peer-marker")), { code: "ENOENT" });
      await native.replyPermission(pending, "reject");
      let settled = false;
      for (let index = 0; index < 200; index++) {
        const [active, history] = await Promise.all([native.readActive(), native.readHistory(thread.id)]);
        const aborted = history.find((message) => message.type === "assistant" && message.error?.type === "aborted" && message.time.completed !== undefined);
        if (!Object.hasOwn(active, thread.id) && aborted) { settled = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.equal(settled, true, "plain rejection must naturally settle without Stop");
      assert.equal((await native.readInbox(thread.id)).length, 0);
      assert.equal(requests.filter((request) => request.key === key).length, 1, "plain rejection does not call the model again");
      return (await native.readHistory(thread.id)).flatMap((message) => message.content ?? []).filter((part) => part.type === "tool" && part.id.startsWith(`call_${key}_`));
    }
    if (scenario === "cleanup" || scenario === "stop") return receipt;
    const result = await client.waitForThread(thread.id, { since: receipt, timeoutMs: 15000, pollIntervalMs: 30 });
    assert.equal(result.outcome, "settled", JSON.stringify({ result, brokerErrors }));
    return (await native.readHistory(thread.id)).flatMap((message) => message.content ?? []).filter((part) => part.type === "tool" && part.id.startsWith(`call_${key}_`));
  }
  const results = await Promise.all([turn("alpha", "own"), turn("beta", "own"), turn("gamma", "own")]);
  for (const [index, slug] of ["alpha", "beta", "gamma"].entries()) {
    assert.ok(results[index].every((part) => part.state.status === "completed"), JSON.stringify({ parts: results[index], brokerErrors }));
    assert.match(JSON.stringify(results[index]), new RegExp(`ONLY_${slug}_MEMORY`));
    for (const other of owners.keys()) if (other !== slug) assert.doesNotMatch(JSON.stringify(results[index]), new RegExp(`ONLY_${other}_MEMORY`));
    assert.equal((await native.getSession(threads.get(`${slug}-own`).id)).location.directory, runtime);
  }
  const follow = await turn("alpha", "follow", false, "own");
  assert.equal(threads.get("alpha-follow").id, threads.get("alpha-own").id);
  assert.ok(follow.every((part) => part.state.status === "completed"), JSON.stringify(follow));
  const denied = await turn("alpha", "deny"); assert.ok(denied.every((part) => part.state.status === "error"), JSON.stringify(denied));
  await assert.rejects(readFile(path.join(owners.get("alpha").path, "denied-marker")), { code: "ENOENT" });
  for (const scenario of ["cwd", "cd"]) { const parts = await turn("alpha", scenario, true); assert.equal(parts[0].state.status, "error"); }
  await assert.rejects(readFile(path.join(owners.get("beta").path, "peer-marker")), { code: "ENOENT" });
  const documents = await turn("alpha", "documents");
  assert.equal(documents[0].state.status, "completed", JSON.stringify(documents));
  assert.match(JSON.stringify(documents[0].state.content), /ONLY_alpha_DOCUMENT/);
  assert.doesNotMatch(JSON.stringify(documents[0].state.content), /ONLY_beta_DOCUMENT/);
  const code = await turn("gamma", "code"); assert.equal(code[0].state.status, "completed", JSON.stringify({ code, brokerErrors })); assert.match(JSON.stringify(code[0].state.content), /ONLY_gamma_MEMORY/);
  const added = await createCoworker(team, { name: "Delta" });
  const delta = await updateCoworker(team, added.slug, { workspaceId });
  owners.set(delta.slug, delta);
  assert.ok(!(await api("/api/project")).some((project) => project.canonical === delta.path), "new teammate has no project before invocation");
  await writeCoworkerFile(team, delta.slug, "soul.md", "ONLY_delta_MEMORY");
  await updateTeamWorkspaceConfig(team, [...owners.values()]);
  await prepareNativeTurnRoles((method, route, body) => api(route, method, body), { requireFilesystemScope: true });
  const addedTurn = await turn("delta", "own");
  assert.ok(addedTurn.every((part) => part.state.status === "completed"), JSON.stringify({ addedTurn, brokerErrors }));
  assert.match(JSON.stringify(addedTurn), /ONLY_delta_MEMORY/);
  assert.ok(scopeCalls.length > 10);
  for (const call of scopeCalls) assert.equal(call.scope.directory, await realpath(owners.get((await registry.resolve(call.sessionId)).slug).path));
  assert.deepEqual([...activations], [runtime], "legacy project registration must not activate owner locations");
  const resolvedProjects = await api("/api/project");
  for (const owner of owners.values()) assert.ok(resolvedProjects.some((project) => project.canonical === owner.path && typeof project.id === "string"), "native registered a fresh owner project during invocation");
  const before = await readFile(path.join(runtime, "opencode.json"), "utf8");
  await updateCoworker(team, "alpha", { model: "fixture/fixture", modelVariant: "preference-only" });
  assert.equal(await updateTeamWorkspaceConfig(team, await listCoworkers(team)), false);
  assert.equal(await readFile(path.join(runtime, "opencode.json"), "utf8"), before);
  const requestCount = requests.length;
  const foreign = await client.createThread({ title: "Forged owner", agent: coworkerAgent("alpha"), metadata: { coworker: "alpha", filesystemScopeVersion: 1, filesystemScope: scopeCalls[0].scope } });
  const foreignReceipt = await client.sendTurn(foreign.id, { prompt: "CASE:alpha-forged", agent: coworkerAgent("alpha") });
  const foreignResult = await client.waitForThread(foreign.id, { since: foreignReceipt, timeoutMs: 15000, pollIntervalMs: 30 });
  assert.equal(foreignResult.outcome, "failed");
  assert.equal(requests.length, requestCount, "model/session metadata cannot mint host ownership");
  const runtimeConfig = path.join(root, "engine", "config", "opencode.json");
  const beforeRefresh = await readFile(runtimeConfig, "utf8");
  const beforeStat = await stat(runtimeConfig);
  const pid = embedded.managedOpencodeV2.pid;
  await engine.refresh();
  assert.equal(await readFile(runtimeConfig, "utf8"), beforeRefresh);
  assert.equal((await stat(runtimeConfig)).mtimeMs, beforeStat.mtimeMs, "unchanged provider refresh does not rewrite native configuration");
  providerKey = "rotated-synthetic";
  await host("/runtime-config/providers", "PATCH", { provider: { fixture: { ...provider, name: "Refreshed Fixture", options: { ...provider.options, apiKey: providerKey } } } });
  await engine.refresh();
  const refreshed = await native.readCatalog();
  assert.equal(refreshed.providers.find((item) => item.id === "fixture").name, "Refreshed Fixture");
  const afterRefresh = await turn("alpha", "refreshed", false, "own");
  assert.ok(afterRefresh.every((part) => part.state.status === "completed"), JSON.stringify({ afterRefresh, brokerErrors }));
  assert.equal(embedded.managedOpencodeV2.pid, pid, "refresh retains the owned process");
  assert.deepEqual([...activations], [runtime], "setup, scopes and refresh must use one active location");
  await t.test("retained native admission cleans up through both exact host allowlists", async () => {
    const owner = owners.get("alpha"), sessionId = threads.get("alpha-own").id;
    const retained = await native.readHistory(sessionId);
    await turn("alpha", "cleanup", false, "own");
    for (let attempt = 0; attempt < 200 && !requests.some((request) => request.key === "alpha-cleanup"); attempt++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.filter((request) => request.key === "alpha-cleanup").length, 1);
    assert.ok(Object.hasOwn(await native.readActive(), sessionId));
    const calls = [];
    let readFailure = false, transport;
    const handle = { ...embedded, nativeCleanupRequest: async (input) => {
      calls.push({ method: input.method, path: input.path });
      if (readFailure && input.method === "GET") throw new Error("Fixture observation unavailable");
      return embedded.nativeCleanupRequest(input);
    } };
    const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
    const declaration = source.match(/^async function collaborationCleanupClient\([\s\S]*?^\}/m)?.[0];
    assert.ok(declaration);
    const makeCleanup = runInNewContext(`${declaration}\ncollaborationCleanupClient`, {
      Error, URL, path, AbortSignal, withAbort, coworkerIdentity, coworkersDir: team, ownerToken,
      serverHandle: handle, nativeRuntime: { apiContract: "native-2" }, teamSessions: registry,
      maintenanceAdmission: { closed: true }, maintenanceServer: { handle, native: handle.managedOpencodeV2, pid },
      getCoworker: async (_directory, slug) => owners.get(slug),
      createHeadlessThreadClient: createHeadlessThreadClientV2,
      createNativeV2Client: (options) => { transport = options.fetch; return createNativeV2Client(options); },
    });
    const cleanup = await makeCleanup("alpha", { owner: { slug: "alpha", threadId: sessionId, workspaceId: owner.workspaceId, coworkerCreatedAt: owner.createdAt }, workspaceId: owner.workspaceId });
    const wait = `/api/experimental/session/${sessionId}/wait`;
    const mount = `${url}/workspace/${owner.workspaceId}/opencode2`;
    const beforeRefusals = calls.length;
    await assert.rejects(cleanup.getThreadSnapshot(threads.get("beta-own").id), /cleanup operations/);
    await assert.rejects(transport(mount + wait.replace(sessionId, threads.get("beta-own").id), { method: "POST" }), /cleanup operations/);
    for (const [method, route] of [["POST", `/api/session/${sessionId}/wait`], ["GET", wait], ["POST", `${wait}?continue=false`],
      ["POST", `${wait}/extra`], ["POST", `/api/experimental/session/${sessionId}/interrupt?continue=false`]]) {
      await assert.rejects(transport(mount + route, { method }), /cleanup operations/);
      await assert.rejects(embedded.nativeCleanupRequest({ workspaceId, directory: runtime, method, path: route }), /Only native session cleanup/);
    }
    await assert.rejects(embedded.nativeCleanupRequest({ workspaceId, directory: runtime, method: "POST", path: wait.replace(sessionId, "ses_missing_cleanup") }), /not accepted/);
    assert.equal(calls.length, beforeRefusals);
    readFailure = true;
    await assert.rejects(cleanup.getThreadSnapshot(sessionId), /observation failed/);
    assert.equal(calls.some((call) => call.method === "POST"), false, "failed observation does not manufacture Stop or idle");
    readFailure = false;
    assert.equal((await cleanup.getThreadSnapshot(sessionId)).status.type, "busy");
    assert.equal((await cleanup.abortThread(sessionId)).accepted, true);
    const settled = await cleanup.getThreadSnapshot(sessionId);
    assert.equal(settled.status.type, "idle");
    assert.deepEqual(settled.native.pendingInputIds, []);
    assert.equal(settled.native.turnOutcomes.msg_alpha_cleanup, "interrupted");
    const history = await native.readHistory(sessionId);
    assert.ok(retained.every((entry) => history.some((item) => item.id === entry.id)));
    assert.equal(history.at(-1).type, "idle");
    assert.equal(history.at(-1).outcome, "interrupted");
    assert.deepEqual(calls.filter((call) => call.method === "POST"), [
      { method: "POST", path: `/api/session/${sessionId}/interrupt?continue=false` }, { method: "POST", path: wait },
    ]);
    assert.equal(requests.filter((request) => request.key === "alpha-cleanup").length, 1);
    await turn("alpha", "recovered", false, "own");
    assert.equal(requests.filter((request) => request.key === "alpha-recovered").length, 1);
    assert.equal(requests.filter((request) => request.key === "alpha-cleanup").length, 1, "retained admission is never replayed");
    assert.equal(embedded.managedOpencodeV2.pid, pid);
    assert.deepEqual([...activations], [runtime]);
  });
  await t.test("ordinary public native Stop confirms idle while provider and MCP preparation fail", async (st) => {
    const sessionId = threads.get("alpha-own").id;
    await turn("alpha", "stop", false, "own");
    for (let attempt = 0; attempt < 200 && !requests.some((request) => request.key === "alpha-stop"); attempt++) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.filter((request) => request.key === "alpha-stop").length, 1);
    assert.equal((await client.getThreadSnapshot(sessionId)).status.type, "busy");
    const unavailable = () => { throw new Error("Fixture preparation unavailable"); };
    const preparation = st.mock.method(engine, "ensureWorkspaceReady", unavailable);
    const mcpPreparation = st.mock.method(engine, "syncWorkspaceMcp", unavailable);
    const mount = `${url}/workspace/${workspaceId}/opencode2`;
    const wait = `/api/experimental/session/${sessionId}/wait`;
    assert.equal((await fetch(mount + "/api/plugin", { headers })).status, 500);
    preparation.mock.resetCalls();
    assert.equal((await fetch(mount + wait, { method: "POST" })).status, 401);
    assert.equal((await fetch(mount + wait.replace(sessionId, "ses_missing_stop"), { method: "POST", headers })).status, 404);
    assert.equal((await fetch(mount + wait.replace(sessionId, legacyThreads.get("beta").id), { method: "POST", headers })).status, 404);
    assert.equal((await client.abortThread(sessionId)).accepted, true);
    const settled = await client.getThreadSnapshot(sessionId);
    assert.equal(settled.status.type, "idle");
    assert.deepEqual(settled.native.pendingInputIds, []);
    assert.equal(settled.native.turnOutcomes.msg_alpha_stop, "interrupted");
    assert.equal(preparation.mock.callCount(), 0);
    assert.equal(mcpPreparation.mock.callCount(), 0);
    assert.equal(requests.filter((request) => request.key === "alpha-stop").length, 1);
    for (const [method, route] of [["GET", wait], ["POST", `${wait}?extra=1`], ["POST", `${wait}/extra`]]) assert.equal((await fetch(mount + route, { method, headers })).status, 500);
  });
  await t.test("legacy siblings remain dormant for background reads and retain real history and continuation", async () => {
    const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
    const declarations = ["ownedNativeSessions", "ownedNativeActive"].map((name) => {
      const declaration = source.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^\\}`, "m"))?.[0];
      assert.ok(declaration); return declaration;
    });
    const background = runInNewContext(`${declarations.join("\n")}\n({ownedNativeSessions, ownedNativeActive})`, {
      Promise, Set, Map, Object, path, ownerToken, createNativeV2Client, teamSessions: registry,
      ensurePlatformServer: async () => embedded, teamWorkspace: () => ({ path: runtime, workspaceId }),
      collaboration: { read: async (read) => read({ executions: {} }) }, liveWorkerTurns: new Map(),
    });
    for (const owner of owners.values()) {
      const sessions = await background.ownedNativeSessions(owner);
      assert.ok(sessions.every((session) => session.id !== legacyThreads.get(owner.slug)?.id));
      await background.ownedNativeActive(owner);
    }
    assert.deepEqual([...activations], [runtime], "background activity must not load retained owner plugins");
    for (const [slug, thread] of legacyThreads) {
      const owner = owners.get(slug);
      const routed = await registry.route(thread.id, owner, async (binding) => createNativeV2Client({ ...options, workspaceId: binding.nativeWorkspaceId }));
      assert.equal(routed.session.location.directory, owner.path);
      assert.deepEqual(routed.session.metadata, { originalOwner: slug });
      const old = createHeadlessThreadClientV2({ ...options, workspaceId: routed.binding.nativeWorkspaceId });
      const before = await old.getThreadSnapshot(thread.id);
      assert.ok(legacyHistories.get(slug).every((id) => before.messages.some((message) => message.id === id)));
      const receipt = await old.sendTurn(thread.id, { prompt: `CASE:${slug}-continued`, messageId: `msg_${slug}_continued` });
      const result = await old.waitForThread(thread.id, { since: receipt, timeoutMs: 15000, pollIntervalMs: 30 });
      assert.equal(result.outcome, "settled");
      assert.equal(result.snapshot.directory, owner.path);
      assert.ok(legacyHistories.get(slug).every((id) => result.snapshot.messages.some((message) => message.id === id)));
      assert.equal(await readFile(path.join(owner.path, "opencode.json"), "utf8"), legacyConfigs.get(slug));
      const response = await fetch(`${url}/workspace/${owner.workspaceId}/opencode2/api/plugin`, { headers });
      assert.equal(response.ok, true);
      const inventory = (await response.json()).data;
      assert.ok(inventory.every((plugin) => plugin.state.status === "active"));
      assert.equal(new Set(inventory.map((plugin) => plugin.id)).size, inventory.length);
    }
    assert.deepEqual([...activations].sort(), [runtime, ...[...legacyThreads.keys()].map((slug) => owners.get(slug).path)].sort());
  });
  await t.test("rapid teammate additions keep the shared native role ready", async () => {
    for (const name of ["Epsilon", "Zeta"]) {
      const created = await createCoworker(team, { name });
      const owner = await updateCoworker(team, created.slug, { workspaceId });
      owners.set(owner.slug, owner);
      await updateTeamWorkspaceConfig(team, [...owners.values()]);
      await installAbilitiesPlugin({ path: runtime, workspaceId }, { url: witnessUrl + "/context", token: "synthetic-scope", coworkers: [...owners.values()] });
      const registration = await host("/workspaces/local", "POST", { folderPath: runtime, name: "Synthetic team", preset: "minimal" });
      assert.equal(registration.activeId, workspaceId);
      const pluginResponse = await fetch(`${url}/workspace/${workspaceId}/opencode2/api/plugin`, { headers });
      assert.equal(pluginResponse.ok, true, `plugin ${name}: ${await pluginResponse.clone().text()}`);
      const roleResponse = await fetch(`${url}/workspace/${workspaceId}/opencode2/api/rpc/coworker.turn-roles/prepare`, {
        method: "POST", headers, body: JSON.stringify({ input: {} }), signal: AbortSignal.timeout(15000),
      });
      assert.equal(roleResponse.ok, true, `role ${name}: ${await roleResponse.clone().text()}`);
      assert.equal((await roleResponse.json()).output.ready, true);
      const agents = await api("/api/agent");
      const configured = JSON.parse(await readFile(path.join(runtime, "opencode.json"), "utf8")).agents[`coworker-owner-${owner.slug}`];
      const active = agents.data.find((agent) => agent.id === `coworker-owner-${owner.slug}`);
      assert.ok(active?.system?.endsWith(configured.system), `${name} must carry its own native system policy`);
      assert.ok(agents.data.some((agent) => agent.id === `coworker-owner-${owner.slug}:worker`));
    }
  });
});
