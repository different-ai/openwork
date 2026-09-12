import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readCoworkerAbilities } from "../src/lib/abilities.ts";

export const ABILITIES_PLUGIN = `import { readFile } from "node:fs/promises";
import path from "node:path";
export default async ({ directory }) => {
  const nativeDirectory = path.resolve(directory);
  const file = path.join(nativeDirectory, ".opencode", "coworker-abilities.json");
  const identityError = "Coworker abilities identity does not match the current workspace. Reload the coworker.";
  const read = async () => {
    let config;
    try { config = JSON.parse(await readFile(file, "utf8")); }
    catch { throw new Error("Coworker abilities configuration could not be read; tool selection was not applied."); }
    if (!config || typeof config.createdAt !== "string" || !config.createdAt || typeof config.workspaceId !== "string"
      || typeof config.directory !== "string" || !config.directory || path.resolve(config.directory) !== nativeDirectory) throw new Error(identityError);
    return config;
  };
  const initial = await read();
  const identity = { createdAt: initial.createdAt, workspaceId: initial.workspaceId, directory: nativeDirectory };
  const fresh = async () => {
    const config = await read();
    if (config.createdAt !== identity.createdAt) throw new Error(identityError);
    // A newly created home can load before its platform workspace is registered.
    if (!identity.workspaceId && config.workspaceId) identity.workspaceId = config.workspaceId;
    if (config.workspaceId !== identity.workspaceId) throw new Error(identityError);
    return config;
  };
  const inheritsEverything = (abilities) => abilities && abilities.version === 1 && Number.isSafeInteger(abilities.revision) && abilities.revision >= 0
    && Object.keys(abilities).sort().join(",") === "mcpServers,revision,skills,version"
    && [abilities.skills, abilities.mcpServers].every((selection) => selection && selection.mode === "all"
      && Object.keys(selection).sort().join(",") === "ids,mode" && Array.isArray(selection.ids) && selection.ids.length <= 256
      && selection.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 4096));
  const failure = (name) => new Error(name === "abilities_check"
    ? "Coworker abilities check failed; this selected tool call was stopped."
    : "Coworker abilities transform failed; selected guidance was not applied.");
  const request = async (config, name, args) => {
    if (typeof config.url !== "string" || !config.url || typeof config.token !== "string" || !config.token) throw failure(name);
    let response;
    let result;
    try {
      response = await fetch(config.url, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + config.token },
        body: JSON.stringify({ name, args, context: identity }), signal: AbortSignal.timeout(8000),
      });
      result = await response.json();
    } catch { throw failure(name); }
    if (!response.ok) {
      if (result?.error === identityError) throw new Error(identityError);
      if (["This skill is not selected for this coworker, or is no longer available.", "This MCP server is not selected for this coworker."].includes(result?.error)) throw new Error(result.error);
      throw failure(name);
    }
    return result;
  };
  return {
    "tool.execute.before": async (input, output) => {
      const config = await fresh();
      if (inheritsEverything(config.abilities)) return;
      const result = await request(config, "abilities_check", { tool: input.tool, args: output.args });
      if (result?.ok !== true) throw failure("abilities_check");
    },
    "experimental.chat.system.transform": async (_input, output) => {
      const config = await fresh();
      if (inheritsEverything(config.abilities)) return;
      const result = await request(config, "abilities_transform", { system: output.system });
      if (!Array.isArray(result?.system) || !result.system.every((text) => typeof text === "string")) throw failure("abilities_transform");
      // The engine retains the original array; replacing the property loses the transform.
      output.system.splice(0, output.system.length, ...result.system);
    },
  };
};
`;

export async function installAbilitiesPlugin(coworker, { url, token }) {
  const directory = path.resolve(coworker.path);
  const root = path.join(directory, ".opencode");
  const target = path.join(directory, "opencode.json");
  let current;
  try { current = JSON.parse(await readFile(target, "utf8")); }
  catch { throw new Error("The coworker OpenCode configuration could not be read; existing settings were kept."); }
  if (!current || typeof current !== "object" || Array.isArray(current) || (current.plugin !== undefined && !Array.isArray(current.plugin))) {
    throw new Error("The coworker OpenCode plugin configuration is invalid; existing settings were kept.");
  }
  if (typeof coworker.createdAt !== "string" || !coworker.createdAt || typeof coworker.workspaceId !== "string"
    || typeof url !== "string" || !url || typeof token !== "string" || !token) throw new Error("Coworker abilities installation requires the current workspace identity and context connection.");
  await mkdir(root, { recursive: true });
  const source = path.join(root, "coworker-abilities.js");
  if (await readFile(source, "utf8").catch(() => "") !== ABILITIES_PLUGIN) await writeFile(source, ABILITIES_PLUGIN, "utf8");
  const connectionFile = path.join(root, "coworker-abilities.json");
  const connection = JSON.stringify({ abilities: readCoworkerAbilities(coworker.abilities), createdAt: coworker.createdAt, workspaceId: coworker.workspaceId, directory, url, token });
  if (await readFile(connectionFile, "utf8").catch(() => "") !== connection) {
    await writeFile(`${connectionFile}.tmp`, connection, { mode: 0o600 });
    await chmod(`${connectionFile}.tmp`, 0o600);
    await rename(`${connectionFile}.tmp`, connectionFile);
  }
  await chmod(connectionFile, 0o600);
  const plugin = pathToFileURL(source).href;
  if ((current.plugin ?? []).includes(plugin)) return;
  await writeFile(`${target}.abilities.tmp`, JSON.stringify({ ...current, plugin: [...(current.plugin ?? []), plugin] }, null, 2), "utf8");
  await rename(`${target}.abilities.tmp`, target);
}
