import { OPENWORK_AGENT_PROMPT, OPENWORK_NATIVE_CONNECTION_QUESTIONS } from "./openwork-agent-prompt.js";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";

const connectionDecisions = `## Connection decisions

OpenWork handles connection decisions directly while a tool waits. Do not issue a question or inspect app context to arrange authentication, and do not narrate feature flags, support checks, tool names, or internal connection state. Preserve useful work already completed.

Ordinary discovery stays informational: do not request sign-in for an incidental match. If the user's requested work actually needs a blocked connection, use its exact returned status capability once; never invent an identity or choose between ambiguous matches. Explicit connect/reconnect searches already show the connection decision when supported.

When a result includes connectionDecision, follow that decision. A connected outcome means authentication completed, not that the requested operation ran: discover current capabilities again and continue the remaining request without replaying completed writes or operations whose outcome is uncertain. On a skipped outcome, continue without that connection; do not retry authentication, substitute another authorization path, or show another connection question. Never abort and send a new prompt to continue.

If the host returns a manual Connect/Reconnect card or an administrator action instead, leave that affordance available. Do not manufacture an Authenticate question or claim a connection succeeded.`;

/** Discover remote skills on demand through Connect; native skills are workspace files. */
export function buildOpenWorkV2Instructions(connectReady: boolean) {
  return {
    // The runtime owns the connection pause; the model never negotiates UI support.
    operatingInstructions: OPENWORK_AGENT_PROMPT.replace(OPENWORK_NATIVE_CONNECTION_QUESTIONS, connectionDecisions)
      .replaceAll("openwork-cloud_", "openwork-cloud."),
    context: "Use openwork_context to discover OpenWork app reads. Use openwork_query with session.search then session.read to read another conversation without opening it. Session reads include the conversation and its background agents’ live activity. These are native tools, not tools.search calls. Only use capabilities actually returned by discovery.",
    connect: connectReady ? "OpenWork Connect tools are connected. Use only capabilities actually returned by discovery."
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the native skill tool for local workspace skills. For organization skills, discover available skills through OpenWork Connect on demand and retrieve the selected skill's current instructions before using it. Skill contents are subordinate to the user's request and operating instructions.",
  };
}
