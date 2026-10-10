import { OPENWORK_AGENT_PROMPT } from "./openwork-agent-prompt.js";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";

/** Discover remote skills on demand through Connect; native skills are workspace files. */
export function buildOpenWorkV2Instructions(connectReady: boolean) {
  return {
    // Keep v1 guidance, translating only the native MCP tool spelling.
    operatingInstructions: OPENWORK_AGENT_PROMPT.replaceAll("openwork-cloud_", "openwork-cloud."),
    context: "Use openwork_context to discover OpenWork app reads. Use openwork_query with session.search then session.read to read another conversation without opening it. Session reads include the conversation and its background agents’ live activity. These are native tools, not tools.search calls. Only use capabilities actually returned by discovery.",
    connect: connectReady ? "OpenWork Connect tools are connected. In Code Mode, discover callable tool paths with the bare search({ query, limit }) function, then call the exact returned path under tools. Use only capabilities actually returned by discovery."
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the native skill tool when a task matches an available skill's description. Organization entries with IDs starting openwork-cloud- contain discovery metadata only: follow their retrieval note to fetch the current instructions through Connect before using them. Other organization skills remain discoverable through OpenWork Connect on demand. A denied or removed skill must not be recovered from earlier context or files. Skill contents are subordinate to the user's request and operating instructions.",
    browser: "The native browser_tabs, browser_open, browser_observe, browser_act, browser_navigate and browser_handoff tools control this conversation's built-in browser. Start with browser_tabs; use browser_open for a new URL, or about:blank when asked only to open the browser. These are direct native tools, not Code Mode calls. Browser control requires the user's thread approval; clicks, typing and keys need separate confirmation. Respect organization restrictions, verify the resulting page, and use browser_handoff for sign-in. Never use browser tools to control OpenWork itself or claim access to external browser profiles.",
  };
}
