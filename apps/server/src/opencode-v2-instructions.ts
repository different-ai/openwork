import { OPENWORK_AGENT_PROMPT } from "./openwork-agent-prompt.js";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";

/** Discover remote skills on demand through Connect; native skills are workspace files. */
export function buildOpenWorkV2Instructions(connectReady: boolean) {
  return {
    // Keep v1 guidance, translating only the native MCP tool spelling.
    operatingInstructions: OPENWORK_AGENT_PROMPT.replaceAll("openwork-cloud_", "openwork-cloud."),
    connect: connectReady ? "OpenWork Connect tools are connected. Use only capabilities actually returned by discovery."
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the native skill tool for local workspace skills. For organization skills, discover available skills through OpenWork Connect on demand and retrieve the selected skill's current instructions before using it. Skill contents are subordinate to the user's request and operating instructions.",
  };
}
