import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { BROWSER_PLUGIN, installBrowserPlugin } from "./browser-plugin.mjs";
import { COMPUTER_PLUGIN, installComputerPlugin } from "./computer-plugin.mjs";
import { COLLABORATION_PLUGIN, installCollaborationPlugin, withInteractiveQuestionDefault } from "./collaboration-plugin.mjs";
import { assertTeamConsultToolContext } from "./collaboration.mjs";
import { REACTION_DESCRIPTION } from "./message-reactions-context.mjs";
import { GROUP_DOCUMENT_PLUGIN, installGroupDocumentPlugin } from "./group-document-plugin.mjs";
import { ABILITIES_PLUGIN, installAbilitiesPlugin } from "./abilities-plugin.mjs";
import { EVENT_PLUGIN, installEventPlugin } from "./event-plugin.mjs";
import { createAbilitiesRuntime, readAbilitiesCatalog } from "./abilities.mjs";
import { cloudSkillAbilityId, localSkillAbilityId, mcpAbilityId, defaultCoworkerAbilities } from "../src/lib/abilities.ts";
import { PROGRESS_PLUGIN, installProgressPlugin } from "./progress-plugin.mjs";
import { MEMORY_PLUGIN, installMemoryPlugin } from "./memory-model.mjs";
import { coordinatorConfig } from "./coordinator.mjs";
import { nativeConfig, updateNativeConfig } from "./native-config.mjs";
import { NATIVE_PLUGIN_DEPENDENCIES, NATIVE_PLUGIN_VERSION, configureNativePluginBundles, validateNativePluginManifest, verifyNativePluginBundles } from "./native-plugin.mjs";
import { TURN_ROLES_PLUGIN, prepareNativeTurnRoles } from "./turn-roles-plugin.mjs";
import { NATIVE_TURN_ROLES } from "./native-turns.mjs";
import { createCoworkerToolsServer } from "./coworker-tools.mjs";
import { assertWorkerToolContext, WORKER_MANAGEMENT } from "./worker-controls.mjs";
import { nativeV2SkillsSchema } from "@openwork/headless-threads/v2";
import { selectCatalogSkill, selectionFields, validateSkillSelections, sameSkillFields, selectedCloudSkillScope } from "../src/lib/skill-selection.ts";

// Use the published, pinned packages, not a v1-shaped SDK double. The standalone
// dependency fixture avoids changing another owner's workspace package/lockfile.
const sdkRoot = process.env.COWORKER_NATIVE_PLUGIN_TEST_ROOT
  ?? fileURLToPath(new URL(`../resources/sidecars/.native-plugin-sdk-${NATIVE_PLUGIN_VERSION}/`, import.meta.url));
const require = createRequire(path.join(sdkRoot, "package.json"));
const modules = path.join(sdkRoot, "node_modules");
const bundleRoot = process.env.OPENWORK_COWORKER_PLUGIN_BUNDLE_DIR
  ?? fileURLToPath(new URL("../resources/native-plugins/", import.meta.url));
configureNativePluginBundles(bundleRoot);
const resolve = (name) => name.startsWith("@opencode-ai/schema/")
  ? path.join(modules, "@opencode-ai/schema/dist", name.slice("@opencode-ai/schema/".length) + ".js")
  : name === "@opencode-ai/plugin/effect" ? path.join(modules, "@opencode-ai/plugin/dist/effect/index.js") : require.resolve(name);
const imported = (name) => import(pathToFileURL(resolve(name)).href);
const { Effect, Scope, Exit, Schema } = await imported("effect");
const { Config } = await imported("@opencode-ai/schema/config");
const { Agent } = await imported("@opencode-ai/schema/agent");
for (const [name, version] of Object.entries(NATIVE_PLUGIN_DEPENDENCIES)) {
  assert.equal(JSON.parse(await readFile(path.join(modules, name, "package.json"), "utf8")).version, version);
}
assert.equal(JSON.parse(await readFile(new URL("../native-runtime.json", import.meta.url), "utf8")).opencodeV2Version, NATIVE_PLUGIN_VERSION);
assert.equal(JSON.parse(await readFile(new URL("../../server/src/opencode-v2-artifacts-beta19271.json", import.meta.url), "utf8")).version, NATIVE_PLUGIN_VERSION);

test("native launch scripts finish prerequisite builds before loading plugin preparation", async () => {
  for (const [script, expected] of [
    ["dev.mjs", ["@openwork/headless-threads", "openwork-server"]],
    ["electron-build.mjs", ["@openwork/automations", "@openwork/headless-threads", "openwork-server"]],
  ]) {
    const commandStub = `import { EventEmitter } from "node:events";
      function complete(command, args) {
        if (!/pnpm(?:\\.cmd)?$/.test(command) || args.length !== 3 || args[0] !== "--filter" || args[2] !== "build") throw new Error("Unexpected bootstrap command");
        globalThis.completedBuilds.push(args[1]);
      }
      export function spawnSync(command, args) { complete(command, args); return { status: 0 }; }
      export function spawn(command, args) {
        const child = new EventEmitter();
        queueMicrotask(() => { complete(command, args); child.emit("exit", 0); });
        return child;
      }`;
    const preload = `import assert from "node:assert/strict"; import { registerHooks } from "node:module";
      globalThis.completedBuilds = [];
      registerHooks({ resolve(specifier, context, next) {
        if (specifier === "node:child_process") return { url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(commandStub)}`)}, shortCircuit: true };
        if (specifier.endsWith("/prepare-native-plugins.mjs")) {
          assert.deepEqual(globalThis.completedBuilds, ${JSON.stringify(expected)});
          console.log("Native preparation reached after completed builds"); process.exit(0);
        }
        if (specifier === "@openwork/headless-threads/v2") throw new Error("Headless v2 is not built yet");
        return next(specifier, context);
      } });`;
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, fileURLToPath(new URL(`../scripts/${script}`, import.meta.url))], { encoding: "utf8", timeout: 10_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Native preparation reached after completed builds/);
    if (script === "electron-build.mjs") {
      const hook = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "--input-type=module", "-e", `await import(${JSON.stringify(new URL(`../scripts/${script}`, import.meta.url).href)})`], { encoding: "utf8", timeout: 10_000 });
      assert.equal(hook.status, 0, hook.stderr);
      assert.equal(hook.stdout, "", "Importing packaging hooks must not build or prepare plugins");
    }
  }
  // Exercise the real main warmup body: readiness must be awaited, and a failed
  // or incomplete RPC receipt must never put a workspace in the warmed set.
  const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const source = main.slice(main.indexOf("async function runCoworkerWorkspaceWarmup("), main.indexOf("\nfunction warmCoworkerWorkspace("));
  const ready = Promise.withResolvers();
  const reached = Promise.withResolvers();
  const calls = [];
  const warmedCoworkerWorkspaces = new Set();
  const handle = { managedOpencodeV2: { isAlive: () => true } };
  const coworker = { slug: "fixture", name: "Fixture", workspaceId: "ws_fixture" };
  let reply = () => ready.promise;
  const warm = runInNewContext(`${source}\nrunCoworkerWorkspaceWarmup`, {
    ensureToolsServer: async () => ({}), installNativeCoworkerPlugins: async () => undefined,
    ensurePlatformServer: async () => handle, registerCoworkerTools: async () => undefined,
    toolsRegistered: new Set(), serverHandle: handle, warmedCoworkerWorkspaces, prepareNativeTurnRoles,
    nativeWorkspaceRequest: async (_handle, _workspaceId, method, route, body) => {
      calls.push({ method, route, body });
      if (route === "/api/plugin") return { data: ["collaboration", "computer", "browser", "group-documents", "turn-roles", "events", "abilities"].map((id) => ({ id: `coworker.${id}`, state: { status: "active" } })) };
      if (route === "/api/rpc/coworker.turn-roles/prepare") { reached.resolve(); return reply(); }
    },
  });
  const warming = warm(coworker);
  await reached.promise;
  assert.equal(warmedCoworkerWorkspaces.size, 0);
  assert.deepEqual(calls.map((call) => call.route), ["/api/plugin/await-activation", "/api/plugin", "/api/rpc/coworker.turn-roles/prepare"]);
  assert.deepEqual(calls.at(-1).body, { input: {} });
  ready.resolve({ output: { ready: true } });
  await warming;
  assert.equal(warmedCoworkerWorkspaces.has("ws_fixture"), true);
  warmedCoworkerWorkspaces.clear();
  reply = async () => ({ output: { ready: false } });
  await assert.rejects(warm(coworker), /inheritance is not ready/);
  assert.equal(warmedCoworkerWorkspaces.size, 0);
  reply = async () => { throw new Error("Readiness failed"); };
  await assert.rejects(warm(coworker), /Readiness failed/);
  assert.equal(warmedCoworkerWorkspaces.size, 0);
});

async function fixture(t, source, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-native-plugin-"));
  const scope = Effect.runSync(Scope.make());
  t.after(async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); await rm(root, { recursive: true, force: true }); });
  const hooks = new Map();
  const agents = new Map([["build", Agent.Info.default("build")]]);
  const tools = new Map((options.tools ?? ["browser_eval", "webmcp_call_tool", "webmcp_future_action", "computer_open", "coworker_document_read", "coworker_self_memory_read", "coworker_team_list"].map((name) => ({ id: name, name }))).map((tool) => [tool.id, tool]));
  const editor = { list: () => [...tools.values()], add: (tool) => tools.set(tool.name, tool), remove: (id) => tools.delete(id), update: (id, update) => { if (tools.has(id)) update(tools.get(id)); } };
  const model = { providerID: "fixture", id: "small", modelID: "wire-small", enabled: true, status: "active", capabilities: { input: ["text"], output: ["text"] }, cost: [{ input: 0.1, output: 0.2 }], variants: [], limit: { output: 4096 }, ...options.model };
  const register = (domain) => (name, callback) => Effect.sync(() => { hooks.set(`${domain}.${name}`, callback); return { dispose: Effect.void }; });
  let refreshMcp = () => {};
  const ctx = {
    location: { directory: root },
    agent: { get: ({ agentID }) => Effect.succeed({ data: agents.get(agentID) }), transform: (fn) => Effect.sync(() => fn({ get: (id) => agents.get(id), update: (id, update) => { const item = agents.get(id) ?? Agent.Info.default(id); update(item); agents.set(id, item); } })) },
    plugin: { list: () => Effect.succeed({ data: options.configActive === false ? [] : [{ id: "opencode.config.agent", state: { status: "active" } }] }) },
    rpc: { register: (_definition, handlers) => Effect.sync(() => { for (const [name, handler] of Object.entries(handlers)) hooks.set(`rpc.${name}`, handler); return { dispose: Effect.void }; }) },
    tool: { transform: (fn) => Effect.sync(() => fn(editor)), hook: register("tool") },
    permission: { hook: register("permission") },
    skill: { list: () => Effect.succeed({ data: options.skills ?? [] }) },
    mcp: { transform: (fn) => Effect.sync(() => { refreshMcp = () => fn({ list: () => (options.servers ?? []).map((name) => [name, {}]) }); refreshMcp(); }), reload: () => Effect.sync(() => refreshMcp()) },
    session: { hook: register("session"), get: () => Effect.succeed({ agent: options.agent, model: { providerID: "fixture", id: "small" } }) },
    catalog: { model: { list: () => Effect.succeed({ data: [model] }) }, provider: { get: () => Effect.succeed({ data: { package: "@opencode-ai/ai/providers/openai-compatible", activation: "enabled" } }) } },
  };
  await options.setup?.(root);
  const code = source.replace(/from "(@opencode-ai\/[^"\n]+|effect|zod)"/g, (_match, name) => `from ${JSON.stringify(pathToFileURL(resolve(name)).href)}`);
  const plugin = (await import(`data:text/javascript,${encodeURIComponent(code)}#${root}`)).default;
  assert.equal(typeof plugin.effect, "function");
  assert.equal(plugin.setup, undefined);
  await Effect.runPromise(Effect.provideService(plugin.effect(ctx), Scope.Scope, scope));
  const run = (domain, name, event) => Effect.runPromise(hooks.get(`${domain}.${name}`)(event));
  return { root, tools, run, model, agents, reloadMcp: () => Effect.runPromise(ctx.mcp.reload()) };
}

async function broker(t, f, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ body, authorization: request.headers.authorization });
    await handler(body, response, request);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  await mkdir(path.join(f.root, ".opencode"), { recursive: true });
  await writeFile(path.join(f.root, ".opencode", "coworker-context.json"), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/context`, token: "fixture-only" }));
  return requests;
}

const context = { sessionID: "ses_native", messageID: "msg_native", id: "native-call", progress: () => Effect.void };

test("published native tools preserve trusted identity, broker payloads, file images and restrictions", async (t) => {
  for (const [source, name, args, brokerName] of [
    [BROWSER_PLUGIN, "coworker_browser_snapshot", { browser_url: "owned", target_id: "page" }, "coworker_browser_snapshot"],
    [COMPUTER_PLUGIN, "coworker_computer_observe", { include_image: true }, "coworker_computer_observe"],
    [COLLABORATION_PLUGIN, "coworker_worker_pause", { id: "worker-one" }, "worker_pause"],
    [COLLABORATION_PLUGIN, "coworker_react", { emoji: null }, "react"],
    [GROUP_DOCUMENT_PLUGIN, "coworker_group_document_read", { groupId: "grp_12345678", id: "plan" }, "group_document_read"],
    [EVENT_PLUGIN, "coworker_event_details", { id: "event-fixture" }, "event_details"],
  ]) {
    const f = await fixture(t, source);
    const requests = await broker(t, f, (_body, response) => response.end(JSON.stringify(name.includes("computer")
      ? { content: [{ type: "text", text: "Observed" }, { type: "image", mimeType: "image/png", data: "AA==" }] }
      : { text: "Recorded", structured: { retained: true } })));
    for (const [id, tool] of f.tools) if (id.startsWith("coworker_") && tool.execute) assert.equal(tool.options.codemode, false);
    const tool = f.tools.get(name);
    const output = await Effect.runPromise(tool.execute(args, { ...context, callID: "forged-old-id", directory: "/forged" }));
    assert.deepEqual(requests[0].body, { name: brokerName, args, context: { sessionID: context.sessionID, messageID: context.messageID, callID: context.id, directory: f.root } });
    assert.equal(requests[0].authorization, "Bearer fixture-only");
    assert.equal(output.content[0].type, "text");
    if (name.includes("computer")) assert.deepEqual(output.content[1], { type: "file", mime: "image/png", uri: "data:image/png;base64,AA==" });
    else assert.deepEqual(output.metadata.structuredContent, { retained: true });
    await assert.rejects(Effect.runPromise(tool.execute(args, { ...context, id: undefined, callID: "old-id" })), /native call identity/);
    await assert.rejects(Effect.runPromise(tool.execute({ ...args, context: { id: "spoof" } }, context)), /Invalid native tool arguments/);
    await assert.rejects(Effect.runPromise(tool.execute(args, context), { signal: AbortSignal.abort() }));
    assert.equal(requests.length, 1);
    for (const id of ["coworker_document_read", "coworker_self_memory_read", "coworker_team_list"]) assert.ok(f.tools.has(id));
    const broad = source === BROWSER_PLUGIN ? "browser_eval" : source === COMPUTER_PLUGIN ? "computer_open" : undefined;
    if (broad) { assert.equal(f.tools.has(broad), false); await assert.rejects(f.run("tool", "execute.before", { tool: broad }), /Unrestricted/); }
    if (source === BROWSER_PLUGIN) {
      for (const name of ["webmcp_call_tool", "webmcp_future_action", "browser_future_action"]) {
        assert.equal(f.tools.has(name), false);
        await assert.rejects(f.run("tool", "execute.before", { tool: name }), /Unrestricted browser/);
      }
      assert.equal(requests.length, 1);
      assert.equal(f.tools.has("coworker_browser_resume"), false);
      assert.ok(f.tools.get("coworker_browser_handoff").input["~standard"].validate({ browser_url: "owned", target_id: "page", reason: "resume" }).issues);
      assert.ok(f.tools.get("coworker_browser_click").input["~standard"].validate({ browser_url: "owned", target_id: "page", uid: 1 }).issues);
    }
    if (source === COMPUTER_PLUGIN) {
      const act = f.tools.get("coworker_computer_act");
      const key = { type: "key", key: "enter", modifiers: ["command"] };
      for (const value of [{ observation_id: "observation" }, { observation_id: "observation", action: key, actions: [key] }, { observation_id: "observation", actions: Array(9).fill(key) }]) {
        await assert.rejects(Effect.runPromise(act.execute(value, context)), /Invalid native tool arguments/);
      }
      const args = { observation_id: "observation", actions: [{ type: "triple_click", x: 2, y: 3, modifiers: ["shift"] }, key, { type: "wait", ms: 50 }] };
      await Effect.runPromise(act.execute(args, context));
      assert.deepEqual(requests.at(-1).body.args, args);
      assert.equal(f.tools.get("coworker_computer_observe").input["~standard"].validate({ elements: "all", include_image: false }).issues, undefined);
    }
    if (name === "coworker_react") {
      assert.equal(tool.description, REACTION_DESCRIPTION);
      assert.equal(tool.options.codemode, false);
      assert.equal(tool.input["~standard"].validate({ emoji: "x".repeat(64), messageId: "m".repeat(256) }).issues, undefined);
      for (const args of [{}, { emoji: "x".repeat(65) }, { emoji: null, messageId: "m".repeat(257) }, { emoji: null, actor: "other" }]) {
        await assert.rejects(Effect.runPromise(tool.execute(args, context)), /Invalid native tool arguments/);
      }
      await Effect.runPromise(tool.execute({ emoji: "\u2764\ufe0f", messageId: "message_target" }, context));
      assert.deepEqual(requests.at(-1).body.args, { emoji: "\u2764\ufe0f", messageId: "message_target" });
    }
    if (source === EVENT_PLUGIN) {
      const create = f.tools.get("coworker_event_create");
      const input = { title: "Plan", objective: "Review", leadSlug: "scout", participantSlugs: ["scout"], startsAt: 1000, schedule: { kind: "once", timezone: "Europe/Paris", at: 1000 } };
      await Effect.runPromise(create.execute({ input }, context));
      assert.deepEqual(requests.at(-1).body, { name: "event_create", args: { input }, context: { sessionID: context.sessionID, messageID: context.messageID, callID: context.id, directory: f.root } });
      await assert.rejects(Effect.runPromise(create.execute({ input: { ...input, durationMinutes: 4 } }, context)), /Invalid native tool arguments/);
      assert.equal(create.options.codemode, false);
    }
    if (source === GROUP_DOCUMENT_PLUGIN) {
      for (const extra of [{ id: "plan" }, { expectedRevision: 1 }, { groupId: "../outside" }, { body: "x".repeat(100001) }, { author: "spoof" }]) {
        await assert.rejects(Effect.runPromise(f.tools.get("coworker_group_document_save").execute({ groupId: "grp_12345678", title: "Plan", body: "draft", ...extra }, context)), /Invalid native tool arguments/);
      }
    }
  }
  const reads = ["documents_list", "document_read", "self_read", "team_list", "assignments_list", "workers_list", "worker_findings"];
  const direct = ["document_create", "document_update", "document_archive", "context_set", "assignment_create", "memory_note", "soul_update", "team_suggest", "future_read"];
  let effects = 0;
  const tool = (id, options) => ({ id, name: id, options, execute: () => Effect.sync(() => { effects++; return { content: "Witness" }; }) });
  const f = await fixture(t, TURN_ROLES_PLUGIN, { agent: "coworker-worker", tools: [
    ...reads.map((name) => tool(`coworker_${name}`, { namespace: "coworker", codemode: true })),
    ...direct.map((name) => tool(`coworker_${name}`, { namespace: "coworker", codemode: true, pinned: true })),
    tool("coworker_browser_tabs", { codemode: false }),
    tool("coworker_react", { codemode: false }),
    tool("reaction_alias", { permission: "coworker_react", codemode: true, pinned: true }),
    tool("management_alias", { permission: "coworker_assignment_create", codemode: true }),
    tool("receipt_alias", { permission: "coworker_document_create", codemode: true }),
    tool("read", undefined), tool("third_party_read", { codemode: true, pinned: true }), tool("third_party_direct", { codemode: false }),
  ] });
  for (const name of reads) assert.equal(f.tools.get(`coworker_${name}`).options.codemode, true);
  for (const name of [...direct.map((name) => `coworker_${name}`), "coworker_browser_tabs", "coworker_react", "reaction_alias", "management_alias", "receipt_alias"]) {
    assert.equal(f.tools.get(name).options.codemode, false, name);
    assert.equal(f.tools.get(name).options.pinned, undefined, name);
  }
  assert.equal(f.tools.get("read").options, undefined);
  assert.deepEqual(f.tools.get("third_party_read").options, { codemode: true, pinned: true });
  assert.deepEqual(f.tools.get("third_party_direct").options, { codemode: false });
  assert.equal(f.tools.get("coworker_browser_tabs").options.permission, "coworker_browser_tabs", "post-transform aliases retain canonical permission identity");
  await assert.rejects(Effect.runPromise(f.tools.get("coworker_document_read").execute({}, { ...context, agent: "coworker-worker" })), /cannot use/);
  // Configuration arrives after plugin setup, before host readiness/preflight.
  f.agents.get("build").permissions.push({ action: "skill", resource: "approved", effect: "allow" }, { action: "skill", resource: "private", effect: "deny" });
  assert.deepEqual(await f.run("rpc", "prepare", {}), { ready: true });
  assert.deepEqual(f.agents.get("coworker-worker").permissions, [...f.agents.get("build").permissions, ...NATIVE_TURN_ROLES.find((role) => role.id === "coworker-worker").permissions]);
  const inherited = structuredClone(f.agents.get("coworker-worker"));
  await f.run("rpc", "prepare", {});
  await f.run("session", "prompt", { sessionID: context.sessionID });
  assert.deepEqual(f.agents.get("coworker-worker"), inherited, "RPC/prompt readiness share one inheritance registration");
  for (const name of ["coworker_assignment_create", "management_alias", "coworker_browser_tabs", "coworker_react", "reaction_alias"]) {
    const alias = { ...f.tools.get(name), name: "renamed_again" };
    await assert.rejects(Effect.runPromise(alias.execute({}, { ...context, agent: "coworker-worker" })), /cannot use/);
  }
  assert.equal(effects, 0, "protected aliases and unprepared roles cannot produce effects");
  await assert.rejects(f.run("tool", "execute.before", { agent: "coworker-worker", tool: "coworker_react" }), /cannot use/);
  const workerContext = { agent: "coworker-worker", tools: { coworker_react: {}, coworker_document_read: {} }, system: [] };
  await f.run("session", "context", workerContext);
  assert.equal(workerContext.tools.coworker_react, undefined);
  assert.ok(workerContext.tools.coworker_document_read);
  const explicit = await fixture(t, TURN_ROLES_PLUGIN, { tools: [tool("coworker_document_read", { namespace: "coworker", codemode: false })] });
  assert.equal(explicit.tools.get("coworker_document_read").options.codemode, false);
  const notConfigured = await fixture(t, TURN_ROLES_PLUGIN, { configActive: false });
  await assert.rejects(notConfigured.run("rpc", "prepare", {}), /completed native agent configuration/);
  assert.deepEqual(notConfigured.agents.get("coworker-worker").permissions, [{ action: "*", resource: "*", effect: "deny" }]);
  const event = { agent: "build", tools: { execute: {} }, system: [] };
  await f.run("session", "context", event);
  assert.match(event.system[0].text, /native execute/);
  const disabled = { agent: "build", tools: {}, system: [] };
  await f.run("session", "context", disabled);
  assert.deepEqual(disabled, { agent: "build", tools: {}, system: [] }, "guidance never restores a configured execute deny");
});

test("native abilities enforce selected attachments, permission evaluation and Code Mode leaves with live identity", async (t) => {
  const uri = "skill://native-ability/SKILL.md";
  const capability = "plugin:plg_fixture:cob_skill";
  const cloudId = `openwork-cloud-${createHash("sha256").update(uri).digest("hex").slice(0, 16)}`;
  const selected = (skills = [], servers = [], revision = 0) => ({ version: 1, revision, skills: { mode: "selected", ids: skills }, mcpServers: { mode: "selected", ids: servers.map(mcpAbilityId) } });
  let coworker;
  let connection = { url: "http://127.0.0.1:1/context", token: "fixture-only" };
  let unavailable = false;
  const effects = [];
  const options = {
    servers: ["notes", "other", "openwork-cloud", "coworker"], skills: [],
    tools: [
      { id: "notes_search", name: "notes_search", input: {}, options: { namespace: "notes", codemode: true }, execute: () => Effect.sync(() => { effects.push("notes"); return { content: "Found" }; }) },
      { id: "other_search", name: "other_search", input: {}, options: { namespace: "other", permission: "skill", codemode: true }, execute: () => Effect.sync(() => { effects.push("other"); return { content: "Forbidden" }; }) },
      { id: "shell", name: "shell", input: {}, execute: () => Effect.sync(() => { effects.push("shell"); return { content: "Ordinary" }; }) },
    ],
    setup: async (root) => {
      const location = path.join(root, "local", "SKILL.md");
      options.skills = [{ id: "native-local", name: "Duplicate", location, content: "PRIVATE_LOCAL_BODY" },
        { id: cloudId, name: "Duplicate", location: path.join(root, "cloud", "SKILL.md"), content: "PRIVATE_CLOUD_BODY" }];
      coworker = { slug: "fixture", path: root, createdAt: "2026-09-12", workspaceId: "ws_fixture", abilities: selected([localSkillAbilityId(location), cloudSkillAbilityId(capability)], ["notes"]) };
      await mkdir(path.join(root, ".opencode"));
      await writeFile(path.join(root, ".opencode", "coworker-abilities.json"), JSON.stringify({ ...coworker, directory: root, ...connection }));
    },
  };
  const f = await fixture(t, ABILITIES_PLUGIN, options);
  const runtime = createAbilitiesRuntime({ coworkerFor: async () => coworker,
    readCatalog: (home, nativeSkills) => readAbilitiesCatalog(home, async (route) => {
      assert.equal(route.endsWith("/opencode2/api/skill"), false, "permission checks must not recurse through host admission");
      return route === "/experimental/connect/skills" ? { skills: [{ url: uri, capability }] }
        : { items: options.servers.map((name) => ({ name, config: {} })) };
    }, nativeSkills),
  });
  const calls = await broker(t, f, async (body, response) => {
    assert.equal(JSON.stringify(body).includes("PRIVATE_"), false);
    if (unavailable) { response.writeHead(503); response.end(JSON.stringify({ error: "Bearer private-error" })); return; }
    try {
      const input = { ...body.args, ...body.context };
      const result = body.name === "abilities_check" ? await runtime.check(coworker.slug, input) : await runtime.transform(coworker.slug, input);
      response.end(JSON.stringify(result));
    } catch (error) { response.writeHead(400); response.end(JSON.stringify({ error: error.message })); }
  });
  connection = JSON.parse(await readFile(path.join(f.root, ".opencode", "coworker-context.json"), "utf8"));
  const save = () => writeFile(path.join(f.root, ".opencode", "coworker-abilities.json"), JSON.stringify({ ...coworker, directory: f.root, ...connection }));
  await save();
  const permission = async (id, effect = "allow") => {
    const event = { sessionID: context.sessionID, agent: "build", action: "skill", resources: [id], effect };
    await f.run("permission", "evaluate", event); return event;
  };
  assert.equal((await permission("native-local", "ask")).effect, "ask");
  assert.equal((await permission(cloudId)).effect, "allow");
  assert.equal((await permission("not-selected")).effect, "deny");
  const beforeDeny = calls.length;
  assert.equal((await permission(cloudId, "deny")).effect, "deny");
  assert.equal(calls.length, beforeDeny);
  await f.run("session", "prompt", { sessionID: context.sessionID, prompt: { text: "Use selected", skills: [{ id: cloudId }] } });
  await assert.rejects(f.run("session", "prompt", { sessionID: context.sessionID, prompt: { text: "Forbidden", skills: [{ id: "not-selected" }] } }), /not selected/);
  await Effect.runPromise(f.tools.get("notes_search").execute({ server: "other" }, context));
  const alias = { ...f.tools.get("other_search"), name: "renamed" };
  await assert.rejects(Effect.runPromise(alias.execute({ server: "notes" }, context)), /not selected/);
  assert.deepEqual(effects, ["notes"]);
  assert.equal(f.tools.get("notes_search").options.codemode, true);
  const event = { system: [{ type: "text", text: "Keep this instruction" }] };
  const system = event.system;
  await f.run("session", "context", event);
  assert.equal(event.system, system);
  assert.equal(event.system[0].text, "Keep this instruction");
  coworker.abilities = selected([], [], 1);
  await save();
  options.servers = options.servers.filter((name) => name !== "notes");
  await f.reloadMcp();
  assert.equal((await permission(cloudId)).effect, "deny");
  await assert.rejects(Effect.runPromise(f.tools.get("notes_search").execute({}, context)), /MCP server is not selected/);
  assert.equal(calls.at(-1).body.args.server, "notes");
  await Effect.runPromise(f.tools.get("shell").execute({}, context));
  assert.deepEqual(effects, ["notes", "shell"]);
  unavailable = true;
  assert.equal((await permission(cloudId)).effect, "deny");
  await assert.rejects(f.run("session", "context", { system: [] }), /transform failed/);
  unavailable = false;
  coworker.abilities = defaultCoworkerAbilities();
  await save();
  const beforeAll = calls.length;
  await Effect.runPromise(f.tools.get("other_search").execute({}, context));
  await f.run("session", "context", { system: [] });
  assert.equal(calls.length, beforeAll);
  coworker.createdAt = "replacement";
  await save();
  await assert.rejects(Effect.runPromise(f.tools.get("other_search").execute({}, context)), /identity does not match/);
  assert.equal(calls.length, beforeAll);
});

test("native main binds Worker skills to admitted provenance and consultations to exact calls", { timeout: 5_000 }, async () => {
  const main = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const recovery = await readFile(new URL("./native-recovery.mjs", import.meta.url), "utf8");
  const dispatchNativeTurn = runInNewContext(`${recovery.replace(/^import .*\n/gm, "").replace(/^export /gm, "")}\ndispatchNativeTurn`, { nativeV2SkillsSchema });
  const helpers = main.slice(main.indexOf("function assertSkillSession("), main.indexOf("async function readyWorkerClient("));
  const start = main.indexOf("    onContextTool:");
  const handler = main.slice(start, main.indexOf("    handlers:", start));
  const workspaceId = "ws_fixture";
  const sessionA = { baseUrl: "http://127.0.0.1:1", orgId: "org_a", token: "fixture-a" };
  const sessionB = { ...sessionA, orgId: "org_b", token: "fixture-b" };
  const account = (session) => ({ baseUrl: session.baseUrl, orgId: session.orgId, accountId: session.token === sessionA.token ? "user_a" : "user_b" });
  const cloudA = { id: "openwork-cloud-fixture", name: "Briefing", content: "A only", location: "/private/cloud/a/SKILL.md", source: { type: "openwork-cloud", uri: "skill://fixture", scope: "a".repeat(64) } };
  const cloudB = { ...cloudA, content: "B only", location: "/private/cloud/b/SKILL.md", source: { ...cloudA.source, scope: "b".repeat(64) } };
  const local = { id: "local-fixture", name: "Local", content: "Local only", location: "/workspace/fixture/.opencode/skills/local/SKILL.md" };
  const originFields = selectionFields([selectCatalogSkill([cloudA], { id: cloudA.id }, workspaceId, account(sessionA))]);
  const entry = { id: "work_fixture", state: "running", sentAt: 1, messageId: "msg_parent", workspaceId, agent: "build", nativeAdmission: "prepared",
    owner: { kind: "private", slug: "fixture", threadId: "ses_fixture" }, ...originFields };
  const part = { type: "tool", callId: "call_fixture", tool: "coworker_team_consult", toolStatus: "running", toolInput: {} };
  const snapshot = { threadId: "ses_fixture", directory: "/workspace/fixture", messages: [
    { id: entry.messageId, role: "user", parts: [{ type: "text", text: "Original request" }] },
    { id: "msg_assistant", role: "assistant", parentId: entry.messageId, parts: [part] },
  ] };
  const nativeContext = { sessionID: snapshot.threadId, messageID: "msg_assistant", callID: part.callId, directory: snapshot.directory };
  const requests = [];
  const admissions = [];
  let accountReads = 0;
  let rosterReads = 0;
  let catalog = [cloudA, local];
  let beforeCoworkerRead = async () => {};
  let beforeCatalogRead = async () => {};
  const handle = { url: "http://127.0.0.1:1" };
  const sandbox = {
    AbortSignal, Headers, URL, structuredClone, createHash, nativeV2SkillsSchema, selectCatalogSkill, selectionFields, validateSkillSelections, sameSkillFields, selectedCloudSkillScope,
    denSession: sessionA, serverHandle: handle, appliedSkillSession: { handle, session: sessionA }, ownerToken: "fixture-owner", coworkersDir: "/workspace",
    getCoworker: async () => { await beforeCoworkerRead(); return { slug: "fixture", workspaceId }; },
    ensurePlatformServer: async () => handle,
    createHeadlessThreadClient: (options) => ({
      getThreadSnapshot: async (threadId) => ({ threadId, messages: [], native: { engine: "v2" } }),
      sendTurn: async (threadId, turn) => {
        await options.fetch(`${handle.url}/workspace/${workspaceId}/opencode2/api/session/${threadId}/prompt`, { method: "POST", body: JSON.stringify({ id: turn.messageId, text: turn.prompt, skills: turn.skills }) });
        return { threadId, messageId: turn.messageId };
      },
    }),
    createNativeV2Client: () => ({ listSkills: async () => { await beforeCatalogRead(); return structuredClone(catalog); } }),
    fetch: async (url, init) => {
      if (new URL(url).pathname.endsWith("/prompt")) { admissions.push({ headers: new Headers(init.headers), input: JSON.parse(init.body) }); return Response.json({}); }
      assert.equal(new URL(url).pathname, "/v1/me");
      accountReads++;
      return Response.json({ user: { id: account(sandbox.denSession).accountId } });
    },
    maintenanceAdmission: { run: (work) => work() }, COMPUTER_TOOLS: {}, BROWSER_TOOLS: {}, groupDocumentTools: new Set(), eventNativeSchemas: {},
    WORKER_MANAGEMENT, assertWorkerToolContext, assertTeamConsultToolContext,
    listCoworkers: async () => { rosterReads++; return [{ slug: "teammate", name: "Teammate" }]; },
    collaboration: {
      change: async (change) => change({ executions: { [entry.id]: entry } }),
      context: async (slug, context, expected, validate) => {
        const admitted = structuredClone(entry);
        if (expected) validate({ slug, context, ...expected, entry: admitted, snapshot, workspaceId, active: true });
        else if (!["private", "group", "consultation", "assignment"].includes(admitted.owner.kind)) throw new Error("Workers cannot manage collaboration.");
        return { entry: admitted, callId: context.callID, assertActive() {} };
      },
      request: async (trusted, kind, input) => { requests.push({ trusted, kind, input }); return { text: "Requested" }; },
    },
  };
  const api = runInNewContext(`${helpers}\n({ skillAwareClient, resolveWorkerSkills, ${handler} })`, sandbox);
  const consult = { to: "TEAMMATE", question: "Review the bounded plan", continuation: { objective: "Plan", resumeInstructions: "Use the review" } };
  const invoke = (name, args) => api.onContextTool("fixture", { name, args, context: nativeContext });
  part.toolInput = structuredClone(consult);
  for (const name of ["read", "coworker_react"]) {
    part.tool = name;
    await assert.rejects(invoke("team_consult", consult), /exact running native tool/);
  }
  part.tool = "coworker_team_consult";
  await assert.rejects(invoke("team_consult", { ...consult, question: "Substituted private question" }), /exact running native tool/);
  part.toolStatus = "completed";
  await assert.rejects(invoke("team_consult", consult), /exact running native tool/);
  part.toolStatus = "running";
  entry.owner.kind = "worker";
  await assert.rejects(invoke("team_consult", consult), /exact running native tool/);
  assert.equal(requests.length, 0);
  assert.equal(rosterReads, 0);
  entry.owner.kind = "private";
  await invoke("team_consult", consult);
  assert.equal(requests[0].kind, "consultation");
  assert.equal(requests[0].input.to, "teammate");
  assert.equal(part.toolInput.to, "TEAMMATE");
  requests.length = 0;
  const spawn = { name: "Briefing", goal: "Read the briefing", skills: [{ id: cloudA.id }], continuation: consult.continuation };
  part.tool = "coworker_worker_spawn";
  part.toolInput = structuredClone(spawn);
  catalog = [{ ...cloudA, name: "Updated catalog title" }, local];
  await invoke("worker_spawn", spawn);
  assert.deepEqual(requests[0].input.skillSelections, originFields.skillSelections);
  requests.length = 0;
  catalog = [cloudA, local];
  Object.assign(entry, selectionFields([]));
  await assert.rejects(invoke("worker_spawn", spawn), /account could not be verified/);
  await assert.rejects(api.resolveWorkerSkills("fixture", { ...spawn, ...originFields }, entry), /account could not be verified/);
  const admissionClient = () => api.skillAwareClient({ baseUrl: handle.url, workspaceId, token: "fixture-owner", captureSkillOrigin: true });
  const admit = () => dispatchNativeTurn({ client: admissionClient(), threadId: entry.owner.threadId,
    turn: { ...entry, prompt: "Use a natively discovered skill" }, markAttempted: async () => {
      assert.equal(entry.cloudSkillOrigin.messageId, entry.messageId);
      entry.nativeAdmission = "attempted";
    }, signal: new AbortController().signal });
  await admit();
  assert.equal(admissions.length, 1);
  assert.deepEqual(admissions[0].input.skills, []);
  assert.equal(admissions[0].headers.get("x-openwork-native-skills-scope"), cloudA.source.scope);
  const savedOrigin = JSON.parse(JSON.stringify(entry.cloudSkillOrigin));
  assert.deepEqual(savedOrigin.account, account(sessionA));
  assert.equal(savedOrigin.scope, cloudA.source.scope);
  assert.equal(JSON.stringify(savedOrigin).includes(sessionA.token), false);
  delete entry.cloudSkillOrigin;
  await assert.rejects(api.resolveWorkerSkills("fixture", { ...spawn, cloudSkillOrigin: savedOrigin }, entry), /account could not be verified/);
  entry.cloudSkillOrigin = savedOrigin;
  sandbox.denSession = { ...sessionA };
  sandbox.appliedSkillSession = { handle, session: sandbox.denSession };
  await invoke("worker_spawn", spawn);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].input.skillSelections[0].account, account(sessionA));
  assert.equal(requests[0].input.skillSelections[0].source.scope, cloudA.source.scope);
  assert.deepEqual(entry.skillSelections, []);
  requests.length = 0;
  const fresh = await api.resolveWorkerSkills("fixture", spawn);
  assert.equal(fresh.skillSelections[0].source.scope, cloudA.source.scope);
  for (const resolve of [() => invoke("worker_spawn", spawn), () => api.resolveWorkerSkills("fixture", spawn)]) {
    sandbox.denSession = sessionA;
    sandbox.appliedSkillSession = { handle, session: sessionA };
    catalog = [cloudA, local];
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    beforeCoworkerRead = async () => { entered.resolve(); await release.promise; };
    const pending = resolve();
    await entered.promise;
    sandbox.denSession = sessionB;
    sandbox.appliedSkillSession = { handle, session: sessionB };
    catalog = [cloudB, local];
    release.resolve();
    await assert.rejects(pending, /OpenWork account changed/);
  }
  beforeCoworkerRead = async () => {};
  await assert.rejects(invoke("worker_spawn", spawn), /OpenWork account changed/);
  assert.equal(requests.length, 0);
  const recovered = await dispatchNativeTurn({ client: {
    getThreadSnapshot: async (threadId) => ({ threadId, messages: [], native: { engine: "v2", pendingInputIds: [entry.messageId] } }),
    prepareSkillOrigin: async () => { throw new Error("Recovery must not mint today's origin"); },
    sendTurn: async () => { throw new Error("Recovery must not resend"); },
  }, threadId: entry.owner.threadId, turn: { messageId: entry.messageId, agent: "build", nativeAdmission: "attempted" },
  markAttempted: async () => { throw new Error("Recovery must retain the attempted phase"); } });
  assert.equal(recovered.alreadyPresent, true);
  assert.deepEqual(entry.cloudSkillOrigin, savedOrigin);
  sandbox.denSession = sessionA;
  sandbox.appliedSkillSession = { handle, session: sessionA };
  for (const changeAt of [1, 2]) {
    catalog = [cloudA, local];
    let reads = 0;
    beforeCatalogRead = async () => { if (++reads === changeAt) catalog = [cloudB, local]; };
    await assert.rejects(invoke("worker_spawn", spawn), /OpenWork account changed|source changed/);
    assert.equal(requests.length, 0);
  }
  beforeCatalogRead = async () => {};
  sandbox.denSession = sessionB;
  sandbox.appliedSkillSession = { handle, session: sessionB };
  const localSpawn = { ...spawn, skills: [{ id: local.id }] };
  part.toolInput = structuredClone(localSpawn);
  await invoke("worker_spawn", localSpawn);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input.skillSelections[0].id, local.id);
  assert.equal(requests[0].input.skillSelections[0].source, undefined);
  assert.equal(requests[0].input.skillSelections[0].account, undefined);
  requests.length = 0;
  entry.messageId = "msg_next";
  entry.nativeAdmission = "prepared";
  snapshot.messages[0].id = entry.messageId;
  snapshot.messages[1].parentId = entry.messageId;
  await admit();
  assert.equal(admissions.length, 2);
  assert.equal(admissions[1].headers.get("x-openwork-native-skills-scope"), cloudB.source.scope);
  assert.deepEqual(entry.skillSelections, []);
  part.toolInput = structuredClone(spawn);
  await invoke("worker_spawn", spawn);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].input.skillSelections[0].account, account(sessionB));
  assert.equal(requests[0].input.skillSelections[0].source.scope, cloudB.source.scope);
  const beforeRace = JSON.parse(JSON.stringify(entry.cloudSkillOrigin));
  entry.messageId = "msg_prepare_race";
  entry.nativeAdmission = "prepared";
  sandbox.denSession = sessionA;
  sandbox.appliedSkillSession = { handle, session: sessionA };
  catalog = [cloudA, local];
  beforeCatalogRead = async () => {
    sandbox.denSession = sessionB;
    sandbox.appliedSkillSession = { handle, session: sessionB };
    catalog = [cloudB, local];
  };
  await assert.rejects(admit(), /OpenWork account changed/);
  assert.equal(admissions.length, 2);
  assert.equal(entry.nativeAdmission, "prepared");
  assert.deepEqual(structuredClone(entry.cloudSkillOrigin), beforeRace);
  beforeCatalogRead = async () => {};
  catalog = [local];
  entry.messageId = "msg_local_only";
  sandbox.appliedSkillSession = null;
  const beforeLocal = accountReads;
  await admit();
  assert.equal(accountReads, beforeLocal);
  assert.equal(admissions.length, 3);
  assert.equal(admissions[2].headers.get("x-openwork-native-skills-scope"), null);
  assert.equal(entry.cloudSkillOrigin.scope, null);
});

test("Effect interruption aborts live broker transport and waits for exact-call cancellation acknowledgement", async (t) => {
  for (const [source, name, args] of [
    [BROWSER_PLUGIN, "coworker_browser_fill", { browser_url: "owned", target_id: "page", snapshot_id: "snapshot", uid: 1, value: "text" }],
    [COMPUTER_PLUGIN, "coworker_computer_act", { observation_id: "observation", actions: [{ type: "key", key: "enter" }, { type: "wait", ms: 50 }] }],
  ]) {
    const f = await fixture(t, source);
    const started = Promise.withResolvers();
    const cancelling = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    const requests = await broker(t, f, async (body, response) => {
      if (!body.cancel) { started.resolve(); return; }
      cancelling.resolve(); await release.promise; response.end("{}");
    });
    const controller = new AbortController();
    const operation = Effect.runPromise(f.tools.get(name).execute(args, context), { signal: controller.signal });
    const rejected = assert.rejects(operation);
    await started.promise;
    controller.abort();
    await cancelling.promise;
    let settled = false;
    operation.finally(() => { settled = true; }).catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "interruption cannot finish before broker cleanup drains");
    release.resolve();
    await rejected;
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].body, { ...requests[0].body, cancel: true });
  }
});

test("native isolated hooks strip ambient input, bound wire tokens and block retries/tools/auxiliary requests", async (t) => {
  for (const [source, agent, text, maximum] of [
    [PROGRESS_PLUGIN, "progress-summary", '[{"id":"status","text":"Preparing a reply."}]', 80],
    [MEMORY_PLUGIN, "auto-memory", '{"recent":[{"id":"one","speaker":"user","text":"Budget is 42 EUR."}],"shortTerm":[],"longTerm":[]}', 1000],
  ]) {
    for (const endpoint of ["chat/completions", "responses"]) {
      const f = await fixture(t, source, { agent });
      assert.deepEqual(f.agents.get(agent).permissions, [{ action: "*", resource: "*", effect: "deny" }]);
      assert.equal(f.agents.get(agent).hidden, true);
      const identity = { sessionID: "ses_summary", agent, model: { providerID: "fixture", id: "small" } };
      for (const invalid of ["not json", "x".repeat(20001)]) {
        await assert.rejects(f.run("session", "prompt", { sessionID: "ses_invalid", messageID: "msg_invalid", prompt: { text: invalid } }), /refused/);
      }
      await assert.rejects(f.run("session", "prompt", { sessionID: "ses_attached", messageID: "msg_attached", prompt: { text, files: [{ uri: "file:///private" }] } }), /refused/);
      await f.run("session", "prompt", { sessionID: identity.sessionID, messageID: "msg_prompt", prompt: { text, files: undefined, agents: undefined, skills: undefined } });
      const event = { ...identity, system: [{ type: "text", text: "ambient-canary" }], messages: [{ role: "assistant", content: [{ type: "text", text: "history-canary" }] }], tools: { shell: {} }, generation: { maxTokens: 9000 }, providerOptions: { reasoning: "high" } };
      await f.run("session", "context", event);
      assert.deepEqual(event.tools, {});
      assert.deepEqual(event.providerOptions, {});
      assert.equal(event.generation.maxTokens, maximum);
      assert.doesNotMatch(JSON.stringify(event), /ambient-canary|history-canary/);
      const request = { ...identity, kind: "primary" };
      await f.run("session", "model.request", request);
      const http = { ...request, request: new Request(`http://127.0.0.1:1/v1/${endpoint}`, { method: "POST", headers: { Authorization: "fixture-only" }, body: JSON.stringify({ model: "wire-small", stream: true, max_completion_tokens: 9000, max_output_tokens: 9000, n: 10, tools: [{ name: "shell" }], instructions: "private-canary", reasoning: { effort: "high" } }) }) };
      await f.run("session", "http.request", http);
      const bounded = await http.request.json();
      assert.equal(bounded[endpoint === "responses" ? "max_output_tokens" : "max_completion_tokens"], maximum);
      assert.equal(bounded.tools, undefined);
      assert.equal(bounded.reasoning, undefined);
      assert.doesNotMatch(JSON.stringify(bounded), /canary/);
      assert.equal(http.request.headers.get("authorization"), "fixture-only");
      await assert.rejects(f.run("session", "http.request", http), /refused/);
      await assert.rejects(f.run("session", "model.request", { ...request, kind: "title" }), /refused/);
      await assert.rejects(f.run("tool", "execute.before", identity), /cannot use tools/);
      const retry = { ...identity, decision: { retry: true, delay: 1 } };
      await f.run("session", "retry", retry); assert.deepEqual(retry.decision, { retry: false });
      const ordinary = { ...event, sessionID: "ses_ordinary", agent: "build" };
      const before = structuredClone(ordinary); await f.run("session", "context", ordinary); assert.deepEqual(ordinary, before);
    }
    const f = await fixture(t, source, { agent, model: { cost: [] } });
    await f.run("session", "prompt", { sessionID: "ses_unknown", messageID: "msg_unknown", prompt: { text } });
    await assert.rejects(f.run("session", "context", { sessionID: "ses_unknown", agent, model: { providerID: "fixture", id: "small" } }), /refused/);
  }
});

test(`generated config is strict native ${NATIVE_PLUGIN_VERSION}, migrates once with backup and preserves user files`, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "coworker-native-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = await createCoworkerToolsServer({ resolveSlug: () => null, handlers: {}, tools: [] });
  t.after(() => server.stop());
  const generated = server.mcpConfig("fixture-only");
  assert.equal(generated.codemode, true, "startup registration explicitly enables native Code Mode");
  const connection = { url: server.url.replace("/mcp", "/context"), token: "fixture-only" };
  const old = { ...generated, codemode: false };
  const original = JSON.stringify({ plugin: ["file:///user-plugin.js"], agent: { personal: { prompt: "My instructions", permission: { question: "deny" } } }, permission: { "*": "ask", bash: { "git *": "allow" } }, tools: { read: false }, instructions: ["memory/custom.md"], mcp: { coworker: old, notes: { type: "remote", url: "http://127.0.0.1:1/mcp", enabled: true, codemode: false }, defaults: { type: "remote", url: "http://127.0.0.1:1/mcp" } } });
  await writeFile(path.join(root, "opencode.json"), original);
  await writeFile(path.join(root, "soul.md"), "Keep this identity.");
  await mkdir(path.join(root, ".opencode"));
  const userPackage = '{"type":"commonjs","dependencies":{"user-package":"1.0.0"}}';
  await writeFile(path.join(root, ".opencode", "package.json"), userPackage);
  const manifest = JSON.parse(await readFile(path.join(bundleRoot, "manifest.json"), "utf8"));
  await verifyNativePluginBundles();
  for (const name of ["coworker-events.js", "coworker-abilities.js"]) {
    const incomplete = structuredClone(manifest);
    delete incomplete.entries[name];
    assert.throws(() => validateNativePluginManifest(incomplete), /manifest/);
  }
  const home = { path: root, createdAt: "fixture-created", workspaceId: "ws_fixture" };
  const installers = [installBrowserPlugin, installComputerPlugin, installGroupDocumentPlugin, installEventPlugin, installProgressPlugin, installMemoryPlugin, (home) => installAbilitiesPlugin(home, connection)];
  await installCollaborationPlugin(home, connection);
  for (const install of installers) await install(home);
  const first = await readFile(path.join(root, "opencode.json"), "utf8");
  const config = JSON.parse(first);
  Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" })(config);
  Schema.decodeUnknownSync(Config.Info, { onExcessProperty: "error" })(coordinatorConfig());
  assert.equal(await readFile(path.join(root, "opencode.json.pre-v2.bak"), "utf8"), original);
  assert.equal(await readFile(path.join(root, "soul.md"), "utf8"), "Keep this identity.");
  assert.equal(await readFile(path.join(root, ".opencode", "package.json"), "utf8"), userPackage);
  assert.deepEqual(config.instructions, ["memory/custom.md"]);
  assert.deepEqual(config.agents.personal.permissions, [{ action: "question", resource: "*", effect: "deny" }]);
  assert.equal(config.mcp.servers.notes.disabled, false);
  assert.equal(config.mcp.servers.notes.codemode, false);
  assert.equal(config.mcp.servers.defaults.codemode, undefined);
  assert.deepEqual(config.mcp.servers.coworker, nativeConfig({ mcp: { coworker: generated } }).mcp.servers.coworker, "disk and startup use the same native registration");
  const nativeOld = nativeConfig({ mcp: { coworker: old } });
  assert.equal(nativeOld.mcp.servers.coworker.codemode, false, "a name and generated-looking shape alone are insufficient");
  assert.equal(nativeConfig(nativeOld, { coworkerConnection: connection }).mcp.servers.coworker.codemode, true);
  for (const [candidate, broker] of [
    [nativeOld.mcp.servers.coworker, undefined], [nativeOld.mcp.servers.coworker, { ...connection, token: "another-token" }],
    [{ ...nativeOld.mcp.servers.coworker, url: "http://127.0.0.1:1/mcp" }, connection],
    [{ ...nativeOld.mcp.servers.coworker, url: "https://example.invalid/mcp" }, { ...connection, url: "https://example.invalid/context" }],
    [{ ...nativeOld.mcp.servers.coworker, timeout: { catalog: 5000 } }, connection],
    [{ ...nativeOld.mcp.servers.coworker, headers: { ...generated.headers, "X-User": "custom" } }, connection],
  ]) assert.equal(nativeConfig({ mcp: { servers: { coworker: candidate } } }, { coworkerConnection: broker }).mcp.servers.coworker.codemode, false);
  assert.equal(nativeConfig({ mcp: { servers: { user: nativeOld.mcp.servers.coworker } } }, { coworkerConnection: connection }).mcp.servers.user.codemode, false);
  for (const install of installers) await install(home);
  assert.equal(await readFile(path.join(root, "opencode.json"), "utf8"), first);
  await writeFile(path.join(root, "opencode.json"), JSON.stringify({ ...config, mcp: { ...config.mcp, servers: { ...config.mcp.servers, coworker: nativeOld.mcp.servers.coworker } } }));
  assert.equal(await updateNativeConfig(root), true, "already-native app-owned false also migrates");
  assert.equal(await readFile(path.join(root, "opencode.json"), "utf8"), first);
  assert.equal(await readFile(path.join(root, "opencode.json.pre-v2.bak"), "utf8"), original);
  assert.equal(await updateNativeConfig(root), false);
  assert.deepEqual(withInteractiveQuestionDefault({ permissions: [{ action: "*", resource: "*", effect: "deny" }] }).permissions, [{ action: "*", resource: "*", effect: "deny" }]);
  assert.equal(withInteractiveQuestionDefault({}).permissions[0].action, "question");
  assert.throws(() => nativeConfig({ provider: { custom: {} } }), /Cannot safely migrate/);
  await writeFile(path.join(root, "opencode.json"), "{ damaged");
  await assert.rejects(updateNativeConfig(root));
  assert.equal(await readFile(path.join(root, "opencode.json"), "utf8"), "{ damaged");
});
