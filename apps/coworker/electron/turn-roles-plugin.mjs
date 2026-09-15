import { NATIVE_TURN_ROLES } from "./native-turns.mjs";
import { installNativePlugin } from "./native-plugin.mjs";

export const TURN_ROLES_PLUGIN = `import { Plugin } from "@opencode-ai/plugin/effect";
import { Tool } from "@opencode-ai/schema/tool";
import { Rpc } from "@opencode-ai/schema/rpc";
import { Effect, Scope } from "effect";
const roles = ${JSON.stringify(NATIVE_TURN_ROLES)};
export default Plugin.define({ id: "coworker.turn-roles", effect: (ctx) => Effect.gen(function* () {
  const denied = new Map(roles.map((role) => [role.id, new Set([...role.permissions.map((rule) => rule.action), ...Object.keys(role.tools).filter((name) => role.tools[name] === false)])]));
  const sensitive = new Set([...denied.values()].flatMap((names) => [...names]));
  const reads = new Set(["coworker_documents_list", "coworker_document_read", "coworker_self_read", "coworker_team_list", "coworker_assignments_list", "coworker_workers_list", "coworker_worker_findings"]);
  const scope = yield* Scope.Scope;
  let prepared = false;
  // Config is a post-plugin in beta19271. Stay closed during activation, then
  // the host awaits prepare RPC before session binding/permission preflight.
  // Prompt remains a fallback for native callers without selected-skill preflight.
  yield* ctx.agent.transform((editor) => {
    for (const role of roles) editor.update(role.id, (agent) => Object.assign(agent, { hidden: true, permissions: [{ action: "*", resource: "*", effect: "deny" }] }));
  });
  const prepare = yield* Effect.cached(Effect.gen(function* () {
    const plugins = yield* ctx.plugin.list().pipe(Effect.orDie);
    if (!plugins.data.some((plugin) => plugin.id === "opencode.config.agent" && plugin.state.status === "active")) {
      throw new Error("Native turn roles require completed native agent configuration.");
    }
    yield* ctx.agent.transform((editor) => {
      const build = editor.get("build");
      if (!build) throw new Error("Native turn roles require the configured build agent.");
      for (const role of roles) editor.update(role.id, (agent) => {
        Object.assign(agent, structuredClone(build), { id: role.id, name: role.id, hidden: true,
          permissions: [...structuredClone(build.permissions), ...role.permissions.map((rule) => ({ ...rule }))] });
      });
    });
    const build = (yield* ctx.agent.get({ agentID: "build" }).pipe(Effect.orDie)).data;
    for (const role of roles) {
      const actual = (yield* ctx.agent.get({ agentID: role.id }).pipe(Effect.orDie)).data;
      if (JSON.stringify(actual.permissions) !== JSON.stringify([...build.permissions, ...role.permissions])) {
        throw new Error("Native turn role inheritance was not installed.");
      }
    }
    prepared = true;
  }).pipe(Effect.provideService(Scope.Scope, scope)));
  yield* ctx.rpc.register(Rpc.define({ id: "coworker.turn-roles", methods: {
    prepare: {
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: { ready: { const: true } }, required: ["ready"], additionalProperties: false },
    },
  }, events: {} }), { prepare: () => prepare.pipe(Effect.as({ ready: true })) }).pipe(Effect.orDie);
  yield* ctx.session.hook("prompt", (event) => Effect.gen(function* () {
    const session = yield* ctx.session.get({ sessionID: event.sessionID }).pipe(Effect.orDie);
    if (denied.has(session.agent)) yield* prepare;
  }));
  // Only allowlisted ordinary MCP reads use Code Mode. Broker tools, mutations
  // with rich receipts, and unclassified coworker tools remain direct. Preserve
  // explicit false and unrelated native/third-party defaults. Aliases retain
  // both the canonical permission action and the role-sensitive execution gate.
  yield* ctx.tool.transform((editor) => {
    for (const tool of editor.list()) {
      const action = tool.options?.permission ?? tool.id;
      const restricted = sensitive.has(tool.id) || sensitive.has(action);
      if (!restricted && !tool.id.startsWith("coworker_") && !action.startsWith("coworker_")) continue;
      const codemode = !restricted && tool.options?.namespace === "coworker" && reads.has(tool.id) && reads.has(action) && tool.options?.codemode !== false;
      const execute = tool.execute;
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
    if ((event.agent === "build" || blocked) && event.tools.execute) event.system.push({ type: "text", text: "Use native execute for eligible multi-step tool reads: combine independent reads, filter the results, and return a concise answer. Discover exact available signatures from the native tool catalog; do not guess names or copy an inventory. Keep Coworker's mutations, rich receipts, delegation, and browser/computer controls on their direct tools. Code Mode does not grant permissions or bypass this turn's role. Do not retry an uncertain action." });
  }));
  yield* ctx.tool.hook("execute.before", (event) => denied.has(event.agent) && (!prepared || denied.get(event.agent).has(event.tool))
    ? Effect.fail(new Tool.Error({ message: "This native turn role cannot use " + event.tool + "." })) : Effect.void);
}) });
`;

/** Await after native activation and before declaring the workspace warm. This
 * readiness barrier does not evaluate, approve or override a permission. */
export async function prepareNativeTurnRoles(request) {
  const result = await request("POST", "/api/rpc/coworker.turn-roles/prepare", { input: {} });
  if (result?.output?.ready !== true) throw new Error("Native turn role inheritance is not ready.");
}

export async function installTurnRolesPlugin(coworker) {
  await installNativePlugin(coworker, "coworker-turn-roles.js", (config) => {
    const agents = { ...config.agents };
    for (const role of NATIVE_TURN_ROLES) if (Object.hasOwn(agents, role.id)) throw new Error(`The reserved native turn role ${role.id} is already configured. Its settings were not overwritten.`);
    return { ...config, agents };
  });
}
