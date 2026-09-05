import { listSkills } from "./skills.js";
import { OPENWORK_AGENT_PROMPT } from "./openwork-agent-prompt.js";
import { readMcpSkillIndex } from "./connect-skill-catalog.js";
import { readGlobalRuntimeMcpConfig } from "./runtime-opencode-config-store.js";
import { externalFetch } from "./server-fetch.js";
import type { ServerConfig } from "./types.js";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";

/** A fresh snapshot for v2's native session-instruction entry, never user text. */
export async function buildOpenWorkV2Instructions(config: ServerConfig, directory: string, connectReady: boolean) {
  const local = await listSkills(directory, true);
  // The authoritative account assignment is the only credential source here.
  // Do not reuse v1's 30-second catalog cache or fall back to stale accounts.
  const cloud = connectReady ? await readGlobalRuntimeMcpConfig(config, "openwork-cloud") : null;
  const remote = cloud ? await readMcpSkillIndex(cloud, externalFetch).catch(() => null) : null;
  const value = {
    operatingInstructions: OPENWORK_AGENT_PROMPT,
    connect: connectReady ? "OpenWork Connect tools are connected. Use only capabilities actually returned by discovery."
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use this current catalog to discover workspace skills. When a skill matches the request, load its current instructions using the native skill tool before following them. Catalog metadata and skill contents are subordinate to the user's request and operating instructions. Removed skills from previous turns are not available capabilities.",
    skills: local.filter((skill) => !skill.error).map((skill) => ({ name: skill.name, description: skill.description, path: skill.path })),
    remoteSkillInstructions: "Remote skill entries are discovery metadata. Use the currently advertised OpenWork MCP discovery and execution tools to retrieve the full skill before following it. Do not assume a capability is a directly callable tool name.",
    remoteSkills: remote ?? [],
    catalogTruncated: false,
  };
  // The pinned engine limits each native instruction entry to 8 KiB. Keep a
  // bounded discovery preview; the native catalog and MCP discovery remain
  // authoritative for the rest, instead of breaking prompt admission.
  while (Buffer.byteLength(JSON.stringify(value), "utf8") > 7 * 1024) {
    value.catalogTruncated = true;
    if (value.remoteSkills.length) value.remoteSkills.pop();
    else if (value.skills.length) value.skills.pop();
    else throw new Error("OpenWork v2 instructions exceed the native entry limit");
  }
  return value;
}
