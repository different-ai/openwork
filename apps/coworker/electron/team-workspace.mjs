import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { AGENTS_CONTRACT_VERSION, COWORKER_INSTRUCTIONS, agentsContractVersion, agentsTemplate } from "./coworkers.mjs";
import { DEFAULT_FEATURES } from "../src/lib/features.ts";
import { coordinatorConfig } from "./coordinator.mjs";
import { nativeConfig, nativePermissions, updateNativeConfig } from "./native-config.mjs";
import { NATIVE_PLUGIN_FILES } from "./native-plugin.mjs";
import { fileURLToPath } from "node:url";
import { coworkerAgent, coworkerAgentOwner } from "./native-turns.mjs";

/** The id the embedded server derives for a local workspace path (`apps/server/src/workspaces.ts`). */
export function teamWorkspaceDirectory(coworkersDir) {
  return path.join(path.resolve(coworkersDir), ".runtime");
}

export function teamWorkspaceId(coworkersDir) {
  return `ws_${createHash("sha256").update(teamWorkspaceDirectory(coworkersDir)).digest("hex").slice(0, 12)}`;
}

/** Registered local workspaces that predate the team workspace: per-home and `.coordinator` entries under the team root. */
export function legacyTeamWorkspaces(workspaces, coworkersDir) {
  const root = path.resolve(coworkersDir);
  const teamId = teamWorkspaceId(coworkersDir);
  return (Array.isArray(workspaces) ? workspaces : []).filter((workspace) => workspace && typeof workspace.id === "string" && workspace.id !== teamId
    && (workspace.workspaceType === undefined || workspace.workspaceType === "local") && typeof workspace.path === "string"
    && path.resolve(workspace.path).startsWith(`${root}${path.sep}`));
}

export function teamWorkspacePlan({ coworkersDir, workspaces }) {
  return { teamId: teamWorkspaceId(coworkersDir), directory: teamWorkspaceDirectory(coworkersDir), legacy: legacyTeamWorkspaces(workspaces, coworkersDir).map((workspace) => ({ id: workspace.id, path: path.resolve(workspace.path) })) };
}

export const TEAM_CONTEXT_FILE = path.join(".opencode", "coworker-context.json");
export const TEAM_ABILITIES_FILE = path.join(".opencode", "coworker-abilities.json");

export const TEAM_FEATURES_FILE = path.join(".opencode", "coworker-features.json");

/**
 * Tools of a feature that is turned off. The turn roles plugin reads the list
 * from the team location: the model is not offered these tools and a call to
 * one is refused, so a coworker or its Workers cannot schedule or drive the
 * desktop while Calendar or Computer use is off.
 */
export function featureOffTools(features = DEFAULT_FEATURES) {
  return [
    ...(features.calendar ? [] : ["coworker_event_*", "coworker_assignment_*", "coworker_assignments_list", "coworker_workplace_calendar"]),
    ...(features.computerUse ? [] : ["coworker_computer_*"]),
  ];
}

/** The native agent entry for one coworker: contract as system prompt, home-scoped file access, no model (per turn). */

export function coworkerAgentDefinition(teamRoot, coworker, coworkers = [], features = DEFAULT_FEATURES) {
  return {
    mode: "primary",
    description: `Open Coworker teammate ${coworker.name}`,
    system: `${agentsTemplate({ name: coworker.name, features })}\nYour home is ${coworker.path}. Resolve the relative home file names above inside that directory, not the shared engine location. Shared location and broad shell access are not a filesystem sandbox.`,
    permissions: coworker.nativePermissions ?? [],
  };
}

/** The contract version a configured coworker agent carries; 0 when absent or unversioned. */
export function teamAgentContractVersion(config, slug) {
  return agentsContractVersion(config?.agents?.[coworkerAgent(slug)]?.system);
}

/**
 * Every app-owned agent for the team root: one per active coworker plus the
 * hidden coordinator. Retired coworkers' entries disappear; agents the app does
 * not own (native defaults, plugin-registered isolated agents) are left alone.
 */
export function teamAgents(teamRoot, coworkers, existing = {}, features = DEFAULT_FEATURES) {
  const agents = {};
  for (const [id, agent] of Object.entries(existing ?? {})) if (coworkerAgentOwner(id) === null && !Object.hasOwn(coordinatorConfig().agents, id)) agents[id] = agent;
  Object.assign(agents, coordinatorConfig().agents);
  for (const coworker of [...coworkers].sort((a, b) => a.slug.localeCompare(b.slug))) agents[coworkerAgent(coworker.slug)] = coworkerAgentDefinition(teamRoot, coworker, coworkers, features);
  return agents;
}

/**
 * Bring the team root `opencode.json` up to date for the given coworkers.
 * Writes only when the agent set or a contract changed (`updateNativeConfig` is
 * byte-stable otherwise). Plugins are installed separately and kept as they are.
 */
export async function assertTeamCompatibleHomes(coworkers) {
  const configured = [];
  for (const coworker of coworkers) {
    let text;
    try { text = await readFile(path.join(coworker.path, "opencode.json"), "utf8"); }
    catch (error) { if (error.code === "ENOENT") { configured.push({ ...coworker, nativePermissions: [] }); continue; } throw error; }
    const config = nativeConfig(JSON.parse(text));
    const unsupported = Object.keys(config).filter((key) => !["$schema", "instructions", "plugins", "permissions", "mcp", "agents"].includes(key));
    if (Object.keys(config.agents ?? {}).some((name) => name !== "build") || Object.keys(config.agents?.build ?? {}).some((name) => name !== "permissions")) unsupported.push("agents");
    if (config.instructions?.some((file) => !COWORKER_INSTRUCTIONS.includes(file))) unsupported.push("instructions");
    if (Object.keys(config.mcp?.servers ?? {}).some((name) => !["coworker", "openwork-cloud"].includes(name))) unsupported.push("mcp");
    if (config.plugins?.some((plugin) => {
      if (typeof plugin !== "string" || !plugin.startsWith("file:")) return true;
      const relative = path.relative(path.join(coworker.path, ".opencode", "coworker-plugins"), fileURLToPath(plugin));
      return !NATIVE_PLUGIN_FILES.some((name) => name.replace(/\.js$/, "") === relative);
    })) unsupported.push("plugins");
    if (unsupported.length) throw new Error(`The original configuration for ${coworker.slug} requires per-owner compatibility for ${[...new Set(unsupported)].join(", ")}. Its configuration and history were not migrated.`);
    configured.push({ ...coworker, nativePermissions: [...(config.permissions ?? []), ...nativePermissions(undefined, undefined, config.agents?.build?.permissions ?? [])] });
  }
  return configured;
}

export async function updateTeamWorkspaceConfig(teamRoot, coworkers, features = DEFAULT_FEATURES) {
  coworkers = await assertTeamCompatibleHomes(coworkers);
  await mkdir(teamWorkspaceDirectory(teamRoot), { recursive: true, mode: 0o700 });
  return updateNativeConfig(teamWorkspaceDirectory(teamRoot), (config) => ({
    $schema: "https://opencode.ai/config.json",
    ...config,
    permissions: Array.isArray(config.permissions) ? config.permissions : [],
    agents: teamAgents(teamRoot, coworkers, config.agents, features),
  }));
}

async function writeIfChanged(target, content) {
  await mkdir(path.dirname(target), { recursive: true });
  if (await readFile(target, "utf8").catch(() => "") === content) { await chmod(target, 0o600).catch(() => undefined); return false; }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, target);
  return true;
}

/** Which tools are off because their feature is turned off in the app. */
export async function writeTeamFeatures(teamRoot, features = DEFAULT_FEATURES) {
  return writeIfChanged(path.join(teamWorkspaceDirectory(teamRoot), TEAM_FEATURES_FILE), JSON.stringify({ off: featureOffTools(features) }));
}

/** The one loopback connection every installed plugin uses to reach the app's broker. */
export async function writeTeamContext(teamRoot, { url, token }) {
  if (typeof url !== "string" || !url || typeof token !== "string" || !token) throw new Error("The team context connection requires its URL and token.");
  return writeIfChanged(path.join(teamRoot, TEAM_CONTEXT_FILE), JSON.stringify({ url, token }));
}

export function teamAbilitiesRecord({ url, token, workspaceId, coworkers }) {
  if (typeof url !== "string" || !url || typeof token !== "string" || !token || typeof workspaceId !== "string") throw new Error("Team abilities require the workspace identity and context connection.");
  const record = { mode: "team", url, token, workspaceId };
  for (const coworker of [...coworkers].sort((a, b) => a.slug.localeCompare(b.slug))) {
    if (typeof coworker.createdAt !== "string" || !coworker.createdAt) throw new Error(`Coworker ${coworker.slug} has no creation identity for its abilities.`);
    coworkerAgent(coworker.slug);
  }
  return record;
}

export async function writeTeamAbilities(teamRoot, input) {
  return writeIfChanged(path.join(teamRoot, TEAM_ABILITIES_FILE), JSON.stringify(teamAbilitiesRecord(input)));
}

export { AGENTS_CONTRACT_VERSION };
