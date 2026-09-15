import { chmod, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readCoworkerAbilities } from "../src/lib/abilities.ts";
import { installNativePlugin } from "./native-plugin.mjs";

export const ABILITIES_PLUGIN = `import { Plugin } from "@opencode-ai/plugin/effect";
import { Tool } from "@opencode-ai/schema/tool";
import { Effect } from "effect";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
export default Plugin.define({ id: "coworker.abilities", effect: (ctx) => Effect.gen(function* () {
  const nativeDirectory = yield* Effect.promise(() => realpath(ctx.location.directory));
  const file = path.join(nativeDirectory, ".opencode", "coworker-abilities.json");
  const identityError = "Coworker abilities identity does not match the current workspace. Reload the coworker.";
  const failure = (name) => new Tool.Error({ message: name === "abilities_check"
    ? "Coworker abilities check failed; this selected tool call was stopped."
    : "Coworker abilities transform failed; selected guidance was not applied." });
  const read = () => Effect.tryPromise({ try: async (signal) => {
    const config = JSON.parse(await readFile(file, { encoding: "utf8", signal }));
    if (!config || typeof config.createdAt !== "string" || !config.createdAt || typeof config.workspaceId !== "string"
      || typeof config.directory !== "string" || !config.directory || await realpath(config.directory) !== nativeDirectory) throw new Error(identityError);
    return config;
  }, catch: (error) => new Tool.Error({ message: error.message === identityError ? identityError : "Coworker abilities configuration could not be read; tool selection was not applied." }) });
  const initial = yield* read().pipe(Effect.orDie);
  const identity = { createdAt: initial.createdAt, workspaceId: initial.workspaceId, directory: nativeDirectory };
  const fresh = () => Effect.gen(function* () {
    const config = yield* read();
    if (config.createdAt !== identity.createdAt) return yield* Effect.fail(new Tool.Error({ message: identityError }));
    if (!identity.workspaceId && config.workspaceId) identity.workspaceId = config.workspaceId;
    if (config.workspaceId !== identity.workspaceId) return yield* Effect.fail(new Tool.Error({ message: identityError }));
    return config;
  });
  const inheritsEverything = (abilities) => abilities && abilities.version === 1 && Number.isSafeInteger(abilities.revision) && abilities.revision >= 0
    && Object.keys(abilities).sort().join(",") === "mcpServers,revision,skills,version"
    && [abilities.skills, abilities.mcpServers].every((selection) => selection && selection.mode === "all"
      && Object.keys(selection).sort().join(",") === "ids,mode" && Array.isArray(selection.ids) && selection.ids.length <= 256
      && selection.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 4096));
  const request = (config, name, args) => Effect.tryPromise({ try: async (signal) => {
    if (typeof config.url !== "string" || !config.url || typeof config.token !== "string" || !config.token) throw failure(name);
    const response = await fetch(config.url, { method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.token },
      body: JSON.stringify({ name, args, context: identity }), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
    const result = await response.json();
    if (!response.ok) {
      if ([identityError, "This skill is not selected for this coworker, or is no longer available.", "This MCP server is not selected for this coworker."].includes(result?.error)) throw new Tool.Error({ message: result.error });
      throw failure(name);
    }
    return result;
  }, catch: (error) => error instanceof Tool.Error ? error : failure(name) });
  const nativeSkills = () => ctx.skill.list().pipe(Effect.map((catalog) => catalog.data.map(({ id, name, description, location }) => ({ id, name, description, location }))), Effect.mapError(() => failure("abilities_check")));
  const check = (config, tool, args, server) => Effect.gen(function* () {
    if (inheritsEverything(config.abilities)) return;
    const skills = tool === "skill" || tool === "openwork-cloud_execute_capability" ? yield* nativeSkills() : undefined;
    const result = yield* request(config, "abilities_check", { tool, args, ...(server ? { server } : {}), ...(skills ? { nativeSkills: skills } : {}) });
    if (result?.ok !== true) return yield* Effect.fail(failure("abilities_check"));
  });
  const servers = new Set();
  yield* ctx.mcp.transform((editor) => { for (const [name] of editor.list()) servers.add(name); });
  yield* ctx.tool.transform((editor) => {
    for (const tool of editor.list()) {
      if (tool.id === "skill" && !tool.options?.namespace) continue;
      const execute = tool.execute;
      const name = tool.id;
      const namespace = tool.options?.namespace;
      editor.update(name, (updated) => {
        updated.execute = (args, context) => Effect.gen(function* () {
          const config = yield* fresh();
          yield* check(config, name, args, servers.has(namespace) ? namespace : undefined);
          return yield* execute(args, context);
        });
      });
    }
  });
  yield* ctx.permission.hook("evaluate", (event) => {
    if (event.action !== "skill" || event.effect === "deny") return Effect.void;
    return Effect.gen(function* () {
      const config = yield* fresh();
      for (const id of event.resources) yield* check(config, "skill", { id });
    }).pipe(Effect.matchCause({ onFailure: () => { event.effect = "deny"; event.message = "This skill is not selected for this coworker, or is no longer available."; }, onSuccess: () => undefined }));
  });
  yield* ctx.session.hook("prompt", (event) => Effect.gen(function* () {
    if (!event.prompt.skills?.length) return;
    const config = yield* fresh();
    for (const skill of event.prompt.skills) yield* check(config, "skill", { id: skill.id });
  }).pipe(Effect.orDie));
  yield* ctx.session.hook("context", (event) => Effect.gen(function* () {
    const config = yield* fresh();
    if (inheritsEverything(config.abilities)) return;
    const positions = event.system.flatMap((part, index) => part.type === "text" && typeof part.text === "string" ? [index] : []);
    const system = positions.map((index) => event.system[index].text);
    const skills = yield* nativeSkills();
    const result = yield* request(config, "abilities_transform", { system, nativeSkills: skills });
    if (!Array.isArray(result?.system) || result.system.length < system.length || !result.system.every((text) => typeof text === "string")) return yield* Effect.fail(failure("abilities_transform"));
    for (let index = 0; index < positions.length; index++) event.system[positions[index]] = { ...event.system[positions[index]], text: result.system[index] };
    event.system.push(...result.system.slice(positions.length).map((text) => ({ type: "text", text })));
  }).pipe(Effect.orDie));
}) });
`;

export async function installAbilitiesPlugin(coworker, { url, token }) {
  const directory = await realpath(coworker.path);
  const root = path.join(directory, ".opencode");
  if (typeof coworker.createdAt !== "string" || !coworker.createdAt || typeof coworker.workspaceId !== "string"
    || typeof url !== "string" || !url || typeof token !== "string" || !token) throw new Error("Coworker abilities installation requires the current workspace identity and context connection.");
  await mkdir(root, { recursive: true });
  const connectionFile = path.join(root, "coworker-abilities.json");
  const connection = JSON.stringify({ abilities: readCoworkerAbilities(coworker.abilities), createdAt: coworker.createdAt, workspaceId: coworker.workspaceId, directory, url, token });
  if (await readFile(connectionFile, "utf8").catch(() => "") !== connection) {
    await writeFile(`${connectionFile}.tmp`, connection, { mode: 0o600 });
    await chmod(`${connectionFile}.tmp`, 0o600);
    await rename(`${connectionFile}.tmp`, connectionFile);
  }
  await chmod(connectionFile, 0o600);
  await installNativePlugin(coworker, "coworker-abilities.js");
}
