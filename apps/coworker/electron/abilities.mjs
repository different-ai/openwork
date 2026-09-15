import path from "node:path";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  abilitySelected, cloudSkillAbilityId, localSkillAbilityId, mcpAbilityId,
  mcpServerForTool, readCoworkerAbilities,
} from "../src/lib/abilities.ts";

const CLOUD = "openwork-cloud";
const CLOUD_EXECUTE = `${CLOUD}_execute_capability`;
const IDENTITY_ERROR = "Coworker abilities identity does not match the current workspace. Reload the coworker.";
const CATALOG_ERROR = "The abilities catalog could not be fully read. Saved selections are unchanged.";
const SKILL_ERROR = "This skill is not selected for this coworker, or is no longer available.";
const MCP_ERROR = "This MCP server is not selected for this coworker.";
const CHECK_ERROR = "The abilities catalog is unavailable; this selected tool call could not be checked.";
const ordinaryTool = (tool) => tool.startsWith("coworker_") || !tool.includes("_");
const unmappedBuiltin = (tool) => tool.startsWith("browser_") || tool.startsWith("computer_") || ["apply_patch", "plan_enter", "plan_exit"].includes(tool);
const all = (abilities) => abilities.skills.mode === "all" && abilities.mcpServers.mode === "all";
const nonempty = (value) => typeof value === "string" && value.length > 0;
const publicText = (value) => typeof value === "string" ? value
  .replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, "[endpoint omitted]")
  .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/-]+=*/gi, "[credential omitted]").slice(0, 1024) : "";

function catalogMetadata(value) {
  if (!value || !Array.isArray(value.skills) || !Array.isArray(value.mcpServers) || !Array.isArray(value.errors)) {
    return { skills: [], mcpServers: [], errors: [CATALOG_ERROR] };
  }
  let incomplete = value.errors.length > 0;
  const skills = value.skills.flatMap((skill) => {
    if (!skill || !nonempty(skill.name)) { incomplete = true; return []; }
    const metadata = { name: skill.name, description: publicText(skill.description), source: skill.source,
      ...(nonempty(skill.nativeId) ? { nativeId: skill.nativeId } : {}) };
    if (skill.source === "local" && nonempty(skill.location)) {
      return [{ ...metadata, id: localSkillAbilityId(skill.location), location: skill.location }];
    }
    if (skill.source === "cloud" && typeof skill.capability === "string" && /^(?:skill:[^:]+|plugin:[^:]+:[^:]+)$/.test(skill.capability)) {
      return [{ ...metadata, id: cloudSkillAbilityId(skill.capability), capability: skill.capability }];
    }
    incomplete = true;
    return [];
  });
  const mcpServers = value.mcpServers.flatMap((server) => {
    if (!server || !nonempty(server.name)) { incomplete = true; return []; }
    return [{
      id: mcpAbilityId(server.name), name: server.name, description: publicText(server.description),
      source: publicText(server.source), available: server.available === true,
      gateway: server.name === CLOUD || server.gateway === true,
    }];
  });
  return { skills, mcpServers, errors: incomplete ? [CATALOG_ERROR] : [] };
}

function xml(value) {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&<>"'\n\r\t]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;", "\n": "&#10;", "\r": "&#13;", "\t": "&#9;",
  })[character]);
}

function filterRemoteSkills(system, capabilities) {
  const selected = new Set(capabilities.map(xml));
  return system.map((text) => text.replace(/(^|\n)([ \t]*<available_remote_skills>)([\s\S]*?)(<\/available_remote_skills>)/g,
    (_block, before, open, content, close) => before + open + content.replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/g, (entry) => {
      const capability = /\bcapability="([^"]*)"/.exec(entry.slice(0, entry.indexOf(">") + 1))?.[1];
      return selected.has(capability) ? entry : "";
    }) + close));
}

function guidance(abilities, catalog) {
  const lines = [
    `<coworker_abilities configuration="tool-selection" revision="${abilities.revision}">`,
    "Configuration only, not new authority or an authorization sandbox. Existing permissions and broad built-in tools are unchanged.",
    `Skills: ${abilities.skills.mode}. MCP servers: ${abilities.mcpServers.mode}. Only currently listed selections appear below; missing saved IDs are not replaced.`,
  ];
  let remaining = 4000;
  let count = 0;
  let omitted = 0;
  const add = (entry) => {
    if (count >= 24 || entry.length > remaining) { omitted++; return; }
    lines.push(entry);
    remaining -= entry.length;
    count++;
  };
  if (abilities.skills.mode === "selected") {
    const selected = catalog.skills.filter((skill) => abilitySelected(abilities.skills, skill.id));
    if (!selected.length) lines.push("No selected skills are currently listed.");
    for (const skill of selected) add(skill.source === "local"
      ? `<local_skill name="${xml(skill.name)}" location="${xml(skill.location)}" />`
      : `<remote_skill capability="${xml(skill.capability)}" />`);
  }
  if (abilities.mcpServers.mode === "selected") {
    const selected = catalog.mcpServers.filter((server) => abilitySelected(abilities.mcpServers, server.id));
    if (!selected.length) lines.push("No selected MCP servers are currently listed.");
    for (const server of selected) add(`<mcp_server name="${xml(server.name)}" available="${server.available}" />`);
    lines.push("Known available Cloud skill loads follow the skills selector even without the general gateway. Other gateway operations follow MCP selection.");
  }
  lines.push("openwork-cloud is a broad shared gateway, not per-connection selection. These settings do not restrict terminal, file, browser, computer, or delegation access.");
  if (omitted) lines.push(`${omitted} entries omitted from this bounded summary; normal tool checks still use the full selection.`);
  if (catalog.errors.length) lines.push(CATALOG_ERROR);
  lines.push("</coworker_abilities>");
  return lines.join("\n");
}

/** Read existing platform catalogs without returning MCP config, headers, or skill bodies. */
export async function readAbilitiesCatalog(coworker, request, nativeSkills) {
  const workspace = `/workspace/${encodeURIComponent(coworker.workspaceId)}`;
  const results = await Promise.allSettled([
    nativeSkills === undefined ? request(`${workspace}/opencode2/api/skill`) : Promise.resolve({ data: nativeSkills }),
    request("/experimental/connect/skills"),
    request(`${workspace}/mcp`),
  ]);
  const [native, cloud, mcp] = results.map((result) => result.status === "fulfilled" ? result.value : null);
  const errors = [];
  if (!Array.isArray(native?.data)) errors.push("Native skills are unavailable.");
  if (!Array.isArray(cloud?.skills)) errors.push("Cloud skills are unavailable.");
  if (!Array.isArray(mcp?.items)) errors.push("MCP inventory is unavailable.");
  const skills = (Array.isArray(native?.data) ? native.data : []).flatMap((skill) => {
    if (!nonempty(skill?.id) || !nonempty(skill.location) || !nonempty(skill.name)) { errors.push(CATALOG_ERROR); return []; }
    const metadata = { nativeId: skill.id, name: skill.name, description: skill.description };
    if (!skill.id.startsWith("openwork-cloud-")) return [{ ...metadata, source: "local", location: skill.location }];
    const matches = (Array.isArray(cloud?.skills) ? cloud.skills : []).filter((entry) => typeof entry.url === "string" && entry.url.startsWith("skill://")
      && `openwork-cloud-${createHash("sha256").update(entry.url).digest("hex").slice(0, 16)}` === skill.id
      && (!skill.source || (skill.source.type === "openwork-cloud" && skill.source.uri === entry.url)));
    if (matches.length !== 1) { errors.push(CATALOG_ERROR); return []; }
    return [{ ...metadata, source: "cloud", capability: matches[0].capability }];
  });
  const savedLocations = readCoworkerAbilities(coworker.abilities).skills.ids.filter((id) => id.startsWith("local:")).map((id) => id.slice(6));
  const canonicalSaved = await Promise.all(savedLocations.map(async (location) => ({ location, path: await realpath(location).catch(() => null) })));
  for (const skill of skills) {
    if (skill.source !== "local" || savedLocations.includes(skill.location)) continue;
    const actual = await realpath(skill.location).catch(() => null);
    const saved = actual && canonicalSaved.find((item) => item.path === actual);
    if (saved) skill.location = saved.location;
  }
  return catalogMetadata({
    skills,
    mcpServers: (Array.isArray(mcp?.items) ? mcp.items : []).filter((item) => item?.name !== "coworker").map((item) => ({
      name: item.name,
      description: item.name === CLOUD ? "Shared OpenWork Connect gateway, including connected apps and generic tools." : "Configured MCP server",
      source: item.source === "config.project" ? "This coworker" : item.source === "config.global" ? "This Mac" : "Remote",
      available: item.config?.enabled !== false && item.config?.disabled !== true && item.disabledByTools !== true,
      gateway: item.name === CLOUD,
    })),
    errors,
  });
}

export function createAbilitiesRuntime({ coworkerFor, readCatalog }) {
  const knownSkills = new Map();

  async function current(slug, input, editor = false) {
    let coworker;
    try { coworker = await coworkerFor(slug); } catch { throw new Error(IDENTITY_ERROR); }
    if (!coworker || coworker.slug !== slug || !nonempty(input?.createdAt) || input.createdAt !== coworker.createdAt || !nonempty(coworker.path)
      || (!editor && (typeof input.workspaceId !== "string" || input.workspaceId !== coworker.workspaceId || !nonempty(input.directory)))) throw new Error(IDENTITY_ERROR);
    if (!editor) {
      const canonical = (directory) => realpath(directory).catch(() => path.resolve(directory));
      const [expected, actual] = await Promise.all([canonical(coworker.path), canonical(input.directory)]);
      if (expected !== actual) throw new Error(IDENTITY_ERROR);
    }
    return coworker;
  }

  function remember(coworker, catalog) {
    const identity = JSON.stringify([coworker.createdAt, coworker.workspaceId, path.resolve(coworker.path)]);
    let entry = knownSkills.get(coworker.slug);
    if (entry?.identity !== identity) { entry = { identity, capabilities: new Set() }; knownSkills.set(coworker.slug, entry); }
    for (const id of readCoworkerAbilities(coworker.abilities).skills.ids) if (id.startsWith("cloud:")) entry.capabilities.add(id.slice(6));
    for (const skill of catalog?.skills ?? []) if (skill.source === "cloud") entry.capabilities.add(skill.capability);
    return entry.capabilities;
  }

  async function read(coworker, nativeSkills) {
    try { return catalogMetadata(await readCatalog(coworker, nativeSkills)); }
    catch { return { skills: [], mcpServers: [], errors: [CATALOG_ERROR] }; }
  }

  return {
    async catalog(input) {
      const coworker = await current(input?.slug, input, true);
      remember(coworker);
      const catalog = await read(coworker);
      remember(await current(input.slug, input, true), catalog);
      return catalog;
    },
    async check(slug, input) {
      let coworker = await current(slug, input);
      if (!nonempty(input.tool) || !input.args || typeof input.args !== "object" || Array.isArray(input.args)) throw new Error("A native tool name and argument object are required for abilities selection.");
      let abilities = readCoworkerAbilities(coworker.abilities);
      remember(coworker);
      const tool = input.tool;
      if (nonempty(input.server) && input.server !== CLOUD && input.server !== "coworker") {
        if (!abilitySelected(abilities.mcpServers, mcpAbilityId(input.server))) throw new Error(MCP_ERROR);
        return { ok: true };
      }
      if (all(abilities) || input.server === "coworker" || (tool === "skill" ? abilities.skills.mode === "all"
        : (!input.server && ordinaryTool(tool)) || (abilities.mcpServers.mode === "all" && tool !== CLOUD_EXECUTE))) return { ok: true };
      const catalog = await read(coworker, input.nativeSkills);
      coworker = await current(slug, input);
      abilities = readCoworkerAbilities(coworker.abilities);
      const known = remember(coworker, catalog);
      if (all(abilities)) return { ok: true };
      if (tool === "skill") {
        if (abilities.skills.mode === "all") return { ok: true };
        const id = input.args.id;
        const matches = catalog.skills.filter((skill) => nonempty(id) && skill.nativeId === id);
        if (matches.length !== 1 || !abilitySelected(abilities.skills, matches[0].id)) throw new Error(SKILL_ERROR);
        return { ok: true };
      }
      const server = nonempty(input.server) ? input.server : mcpServerForTool(tool, catalog.mcpServers.map((item) => item.name));
      if (tool === CLOUD_EXECUTE && (!server || server === CLOUD)) {
        const capability = input.args.name;
        const skill = catalog.skills.find((item) => item.source === "cloud" && item.capability === capability);
        if (skill || known.has(capability) || (typeof capability === "string" && capability.startsWith("skill:"))) {
          if (!skill || !abilitySelected(abilities.skills, skill.id)) throw new Error(SKILL_ERROR);
          return { ok: true };
        }
        if (abilities.skills.mode === "selected" && catalog.errors.length && typeof capability === "string" && capability.startsWith("plugin:")) throw new Error(CHECK_ERROR);
      }
      if (abilities.mcpServers.mode === "all") return { ok: true };
      const name = server ?? (tool.startsWith(`${CLOUD}_`) ? CLOUD : undefined);
      if (name) {
        if (!abilitySelected(abilities.mcpServers, mcpAbilityId(name))) throw new Error(MCP_ERROR);
      } else if (catalog.errors.length && !unmappedBuiltin(tool)) throw new Error(CHECK_ERROR);
      return { ok: true };
    },
    async transform(slug, input) {
      let coworker = await current(slug, input);
      if (!Array.isArray(input.system) || !input.system.every((text) => typeof text === "string")) throw new Error("Native system instructions must be an array of strings.");
      let abilities = readCoworkerAbilities(coworker.abilities);
      if (all(abilities)) return { system: input.system };
      remember(coworker);
      const catalog = await read(coworker, input.nativeSkills);
      coworker = await current(slug, input);
      abilities = readCoworkerAbilities(coworker.abilities);
      remember(coworker, catalog);
      if (all(abilities)) return { system: input.system };
      const system = abilities.skills.mode === "selected" ? filterRemoteSkills(input.system, catalog.skills
        .filter((skill) => skill.source === "cloud" && abilitySelected(abilities.skills, skill.id)).map((skill) => skill.capability)) : input.system;
      return { system: [...system, guidance(abilities, catalog)] };
    },
  };
}
