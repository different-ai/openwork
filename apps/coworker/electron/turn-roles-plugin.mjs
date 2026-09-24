import { NATIVE_TURN_ROLES, COWORKER_ROLE_SEPARATOR } from "./native-turns.mjs";
import { installNativePlugin } from "./native-plugin.mjs";

export const TURN_ROLES_PLUGIN = `import { Plugin } from "@opencode-ai/plugin/effect";
import { Tool } from "@opencode-ai/schema/tool";
import { Rpc } from "@opencode-ai/schema/rpc";
import { Effect, Scope } from "effect";
import { readFile } from "node:fs/promises";
import path from "node:path";
const roles = ${JSON.stringify(NATIVE_TURN_ROLES)};
const separator = ${JSON.stringify(COWORKER_ROLE_SEPARATOR)};
export default Plugin.define({ id: "coworker.turn-roles", effect: (ctx) => Effect.gen(function* () {
  const roleDenies = (role) => new Set([...role.permissions.map((rule) => rule.action), ...Object.keys(role.tools).filter((name) => role.tools[name] === false)]);
  const sensitive = new Set(roles.flatMap((role) => [...roleDenies(role)]));
  const reads = new Set(["coworker_documents_list", "coworker_document_read", "coworker_self_read", "coworker_team_list", "coworker_assignments_list", "coworker_workers_list", "coworker_worker_findings"]);
  const scope = yield* Scope.Scope;
  let prepared = false;
  // Roles derive from every base: the configured build agent (generic ids) and each
  // coworker's own primary agent in this team location (id + separator + role).
  const bases = (editor) => editor.list().filter((agent) => agent.id === "build" || (agent.id.startsWith("coworker-") && agent.id !== "coworker-coordinator" && !agent.id.includes(separator) && agent.mode === "primary" && !agent.hidden && !roles.some((role) => role.id === agent.id)));
  const roleId = (base, role) => base.id === "build" ? role.id : base.id + separator + role.id.slice("coworker-".length);
  const denied = new Map();
  const derived = new Map();
  const install = (editor, inherit) => {
    const build = editor.get("build");
    if (inherit && build) for (const base of bases(editor)) {
      if (base.id === "build") continue;
      editor.update(base.id, (agent) => {
        const count = teamMode ? homePolicyCounts.get(base.id) : 0;
        if (count === undefined || count > agent.permissions.length) throw new Error("The native owner policy is not prepared.");
        const local = count ? agent.permissions.slice(-count) : [];
        const shared = agent.permissions.slice(0, agent.permissions.length - count).map((rule) => JSON.stringify(rule));
        const additional = build.permissions.filter((rule) => { const index = shared.indexOf(JSON.stringify(rule)); if (index < 0) return true; shared.splice(index, 1); return false; });
        if (count && additional.length) throw new Error("This combination of global build and owner policies requires explicit compatibility support.");
        const permissions = [...structuredClone(build.permissions), ...local];
        const inheritedSystem = typeof build.system === "string" ? build.system : "";
        const system = inheritedSystem && !agent.system?.startsWith(inheritedSystem) ? inheritedSystem + "\\n\\n" + (agent.system ?? "") : agent.system;
        Object.assign(agent, structuredClone(build), { id: base.id, name: base.name, mode: base.mode, hidden: base.hidden, description: base.description, system, permissions });
      });
    }
    denied.clear();
    derived.clear();
    for (const base of bases(editor)) for (const role of roles) {
      const id = roleId(base, role);
      denied.set(id, roleDenies(role));
      derived.set(id, { base: base.id, role: role.id });
      editor.update(id, (agent) => {
        // Config is a post-plugin in beta19271. Stay closed during activation, then
        // the host awaits prepare RPC before session binding/permission preflight.
        if (!inherit) return Object.assign(agent, { hidden: true, permissions: [{ action: "*", resource: "*", effect: "deny" }] });
        Object.assign(agent, structuredClone(base), { id, name: id, hidden: true,
          permissions: [...structuredClone(base.permissions), ...role.permissions.map((rule) => ({ ...rule }))] });
      });
    }
  };
  // The transform replays after config changes (a new coworker adds a base), so
  // roles for a teammate added later inherit without another readiness call.
  yield* ctx.agent.transform((editor) => install(editor, prepared));
  const verify = Effect.gen(function* () {
    for (const [id, { base, role }] of derived) {
      const actual = (yield* ctx.agent.get({ agentID: id }).pipe(Effect.orDie)).data;
      const parent = (yield* ctx.agent.get({ agentID: base }).pipe(Effect.orDie)).data;
      if (JSON.stringify(actual.permissions) !== JSON.stringify([...parent.permissions, ...roles.find((item) => item.id === role).permissions])) {
        throw new Error("Native turn role inheritance was not installed.");
      }
    }
  });
  const prepare = yield* Effect.cached(Effect.gen(function* () {
    const plugins = yield* ctx.plugin.list().pipe(Effect.orDie);
    if (!plugins.data.some((plugin) => plugin.id === "opencode.config.agent" && plugin.state.status === "active")) {
      throw new Error("Native turn roles require completed native agent configuration.");
    }
    if (teamMode && !plugins.data.some((plugin) => plugin.id === "coworker.abilities" && plugin.state.status === "active")) throw new Error("The admitted filesystem scope hook is not active.");
    yield* ctx.agent.transform((editor) => { if (!editor.get("build")) throw new Error("Native turn roles require the configured build agent."); install(editor, true); });
    yield* verify;
    prepared = true;
  }).pipe(Effect.provideService(Scope.Scope, scope)));
  yield* ctx.rpc.register(Rpc.define({ id: "coworker.turn-roles", methods: {
    prepare: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: { ready: { const: true }, filesystemScopeRequired: { type: "boolean" } }, required: ["ready", "filesystemScopeRequired"], additionalProperties: false },
    },
  }, events: {} }), { prepare: () => refreshPolicy.pipe(Effect.orDie, Effect.andThen(checkPolicy), Effect.orDie, Effect.andThen(prepare), Effect.map(() => ({ ready: true, filesystemScopeRequired: teamMode }))) }).pipe(Effect.orDie);
  yield* ctx.session.hook("prompt", (event) => Effect.gen(function* () {
    const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie);
    if (denied.has(session.agent)) yield* prepare;
  }));
  // The app's loopback MCP is registered once for the whole team, so a direct MCP
  // call carries no coworker identity. Every "coworker" namespace tool therefore
  // executes through the broker with this call's trusted session identity; the
  // broker resolves the owner from the app's own admission records.
  const connection = () => Effect.tryPromise({
    try: async (signal) => JSON.parse(await readFile(path.join(ctx.location.directory, ".opencode", "coworker-context.json"), { encoding: "utf8", signal })),
    catch: () => new Tool.Error({ message: "The native coworker connection is unavailable." }),
  });
  const brokered = (name, fallback) => (input, context) => Effect.gen(function* () {
    const config = yield* connection();
    if (config.mode !== "team") return yield* fallback(input, context);
    const directory = ctx.location.directory;
    if ([directory, context.sessionID, context.messageID, context.id].some((value) => typeof value !== "string" || !value)) {
      return yield* Effect.fail(new Tool.Error({ message: "This tool has no active native call identity." }));
    }
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(config.url, { method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.token },
          body: JSON.stringify({ name, args: input, context: { sessionID: context.sessionID, messageID: context.messageID, callID: context.id, directory } }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error || "Native tool failed. Do not replay an uncertain action.");
        if (typeof result?.text !== "string") throw new Error("The native result did not contain text.");
        return { output: result.structured ?? result.text, content: [{ type: "text", text: result.text }], metadata: { ...(result.structured ? { structuredContent: result.structured } : {}), isError: result.isError === true } };
      },
      catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : "Native tool failed." }),
    });
  });
  // Only allowlisted ordinary MCP reads use Code Mode. Broker tools, mutations
  // with rich receipts, and unclassified coworker tools remain direct. Preserve
  // explicit false and unrelated native/third-party defaults. Aliases retain
  // both the canonical permission action and the role-sensitive execution gate.
  const teamMode = yield* Effect.tryPromise({ try: async () => {
    try { return JSON.parse(await readFile(path.join(ctx.location.directory, ".opencode", "coworker-context.json"), "utf8")).mode === "team"; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
  }, catch: () => new Tool.Error({ message: "The native coworker connection is unavailable." }) }).pipe(Effect.orDie);
  let homePolicyText = teamMode ? yield* Effect.promise(() => readFile(path.join(ctx.location.directory, "opencode.json"), "utf8")) : "";
  let homePolicy = teamMode ? JSON.parse(homePolicyText) : {};
  const homePolicyCounts = new Map(Object.entries(homePolicy.agents ?? {}).map(([id, agent]) => [id, agent.permissions?.length ?? 0]));
  const refreshPolicy = Effect.gen(function* () {
    if (!teamMode) return;
    const text = yield* Effect.promise(() => readFile(path.join(ctx.location.directory, "opencode.json"), "utf8"));
    if (text === homePolicyText) return;
    const previous = JSON.parse(homePolicyText), next = JSON.parse(text);
    const unrelated = (config) => ({ ...config, agents: Object.fromEntries(Object.entries(config.agents ?? {}).filter(([id]) => !id.startsWith("coworker-owner-"))) });
    if (JSON.stringify(unrelated(previous)) !== JSON.stringify(unrelated(next))) throw new Error("Non-owner native configuration changed; refresh that configuration before admission.");
    if (typeof ctx.agent.reload !== "function") throw new Error("This runtime cannot refresh native owner policies.");
    // Native config-agent reloads its own file snapshot from a watched event.
    // A newly written teammate may reach this RPC before that event does. The
    // app owns only coworker-owner-* entries, so materialize those exact entries
    // in our existing agent transform instead of waiting for a watcher or
    // restarting the engine. Other native config remains under its own plugin.
    homePolicy = next;
    homePolicyCounts.clear();
    for (const [id, agent] of Object.entries(next.agents ?? {})) homePolicyCounts.set(id, agent.permissions?.length ?? 0);
    yield* ctx.agent.reload();
    for (const [id, expected] of Object.entries(next.agents ?? {})) {
      if (!id.startsWith("coworker-owner-")) continue;
      const result = yield* ctx.agent.get({ agentID: id });
      const rules = expected.permissions ?? [];
      if (!result.data.system?.endsWith(expected.system) || (rules.length && JSON.stringify(result.data.permissions.slice(-rules.length)) !== JSON.stringify(rules))) {
        throw new Error("The native owner policy did not match the current configuration.");
      }
    }
    const current = yield* Effect.promise(() => readFile(path.join(ctx.location.directory, "opencode.json"), "utf8"));
    if (current !== text) throw new Error("Native owner policies changed again during preparation.");
    homePolicyText = text;
  });
  const checkPolicy = teamMode ? Effect.tryPromise({ try: async () => {
    if (await readFile(path.join(ctx.location.directory, "opencode.json"), "utf8") !== homePolicyText) throw new Error("The team configuration changed. Reload native configuration before another tool invocation.");
  }, catch: (error) => new Tool.Error({ message: error.message }) }) : Effect.void;
  if (teamMode) yield* ctx.agent.transform((editor) => {
    const build = editor.get("build");
    if (!build) throw new Error("The native build policy is unavailable.");
    const owners = Object.entries(homePolicy.agents ?? {}).filter(([id]) => id.startsWith("coworker-owner-"));
    const ownerIds = new Set(owners.map(([id]) => id));
    for (const agent of editor.list()) if (agent.id.startsWith("coworker-owner-") && !ownerIds.has(agent.id.split(separator)[0])) editor.remove(agent.id);
    for (const [id, spec] of owners) editor.update(id, (agent) => {
      Object.assign(agent, structuredClone(build), { id, name: id, mode: spec.mode, hidden: false,
        description: spec.description, system: spec.system,
        permissions: [...structuredClone(build.permissions), ...structuredClone(spec.permissions ?? [])] });
    });
  });
  yield* ctx.tool.transform((editor) => {
    for (const tool of editor.list()) {
      const action = tool.options?.permission ?? tool.id;
      const restricted = sensitive.has(tool.id) || sensitive.has(action);
      if (!restricted && !tool.id.startsWith("coworker_") && !action.startsWith("coworker_")) continue;
      const codemode = !teamMode && !restricted && tool.options?.namespace === "coworker" && reads.has(tool.id) && reads.has(action) && tool.options?.codemode !== false;
      const execute = tool.options?.namespace === "coworker" && tool.id.startsWith("coworker_") ? brokered(tool.id.slice("coworker_".length), tool.execute) : tool.execute;
      editor.update(tool.id, (updated) => {
        const { pinned, ...options } = updated.options ?? {};
        updated.options = { ...options, permission: action, codemode, ...(codemode && pinned !== undefined ? { pinned } : {}) };
        updated.execute = (input, context) => denied.has(context.agent) && (!prepared || denied.get(context.agent).has(tool.id) || denied.get(context.agent).has(action))
          ? Effect.fail(new Tool.Error({ message: "This native turn role cannot use " + tool.id + "." })) : execute(input, context);
      });
    }
  });
  yield* ctx.session.hook("context", (event) => Effect.sync(() => {
    const blocked = denied.get(event.agent);
    if (blocked && !prepared) throw new Error("Native turn role inheritance is not ready.");
    if (blocked) for (const name of Object.keys(event.tools)) if (blocked.has(name)) delete event.tools[name];
    // With OpenWork Connect on this turn, web search goes through its capabilities.
    // Removing the native tool also removes its provider-consent prompt.
    if (event.tools["openwork-cloud_search_capabilities"] && event.tools.websearch) {
      delete event.tools.websearch;
      event.system.push({ type: "text", text: "Search the web through OpenWork Connect: call openwork-cloud_search_capabilities for a web search capability, then openwork-cloud_execute_capability with the exact returned identifier. If Connect has no web search, read known pages with webfetch or the built-in browser." });
    }
    if ((event.agent === "build" || event.agent.startsWith("coworker-") || blocked) && event.tools.execute) event.system.push({ type: "text", text: "Use native execute for eligible multi-step tool reads: combine independent reads, filter the results, and return a concise answer. Discover exact available signatures from the native tool catalog; do not guess names or copy an inventory. Keep Coworker's mutations, rich receipts, delegation, and browser/computer controls on their direct tools. Code Mode does not grant permissions or bypass this turn's role. Do not retry an uncertain action." });
  }));
  yield* ctx.tool.hook("execute.before", (event) => checkPolicy.pipe(Effect.andThen(() => denied.has(event.agent) && (!prepared || denied.get(event.agent).has(event.tool))
    ? Effect.fail(new Tool.Error({ message: "This native turn role cannot use " + event.tool + "." })) : Effect.void)));
}) });
`;

/** Await after native activation and before declaring the workspace warm. This
 * readiness barrier does not evaluate, approve or override a permission. */
export async function awaitNativePluginActivation(request, { apiContract = "beta19271", signal = AbortSignal.timeout(120_000) } = {}) {
  if (apiContract === "beta19271") {
    await request("POST", "/api/plugin/await-activation");
    return request("GET", "/api/plugin");
  }
  if (apiContract !== "native-2") throw new Error("Unknown native API contract.");
  for (;;) {
    signal.throwIfAborted();
    const result = await request("GET", "/api/plugin");
    if (!Array.isArray(result?.data)) throw new Error("Invalid native plugin inventory.");
    if (result.data.some((plugin) => plugin.state?.status === "failed")) throw new Error("A native plugin failed activation.");
    if (result.data.length && result.data.every((plugin) => plugin.state?.status === "active")) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function prepareNativeTurnRoles(request, { requireFilesystemScope = false } = {}) {
  const result = await request("POST", "/api/rpc/coworker.turn-roles/prepare", { input: {} });
  if (result?.output?.ready !== true) throw new Error("Native turn role inheritance is not ready.");
  if (requireFilesystemScope && result.output.filesystemScopeRequired !== true) throw new Error("The admitted filesystem scope hook is not ready.");
}

export async function installTurnRolesPlugin(coworker) {
  await installNativePlugin(coworker, "coworker-turn-roles.js", (config) => {
    const agents = { ...config.agents };
    for (const role of NATIVE_TURN_ROLES) if (Object.hasOwn(agents, role.id)) throw new Error(`The reserved native turn role ${role.id} is already configured. Its settings were not overwritten.`);
    for (const id of Object.keys(agents)) if (id.includes(COWORKER_ROLE_SEPARATOR)) throw new Error(`The reserved native turn role ${id} is already configured. Its settings were not overwritten.`);
    return { ...config, agents };
  });
}
