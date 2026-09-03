/**
 * The tools a coworker has for itself — its assignments, its memory, and its
 * soul — are served by Open Coworker to the engine as one MCP server named
 * `coworker`, so the engine names them `coworker_assignment_create` and so on.
 * This module is the one place that knows those names; the main process serves
 * them and the renderer describes them.
 */

export const COWORKER_TOOLS_MCP_NAME = "coworker";

export const ASSIGNMENT_TOOL_NAMES = [
  "assignments_list",
  "assignment_create",
  "assignment_update",
  "assignment_run_now",
  "assignment_remove",
] as const;

export const SELF_TOOL_NAMES = ["memory_remember", "memory_forget", "soul_update", "self_read"] as const;

/** The team tools: who else is on the team, hand work to a teammate, propose a new one. Only the person ever adds a coworker. */
export const TEAM_TOOL_NAMES = ["team_list", "team_refer", "team_suggest"] as const;

export type AssignmentToolName = (typeof ASSIGNMENT_TOOL_NAMES)[number];
export type SelfToolName = (typeof SELF_TOOL_NAMES)[number];
export type TeamToolName = (typeof TEAM_TOOL_NAMES)[number];
export type CoworkerToolName = AssignmentToolName | SelfToolName | TeamToolName;

const ALL_TOOL_NAMES: ReadonlySet<string> = new Set<string>([...ASSIGNMENT_TOOL_NAMES, ...SELF_TOOL_NAMES, ...TEAM_TOOL_NAMES]);

function isCoworkerToolName(value: string): value is CoworkerToolName {
  return ALL_TOOL_NAMES.has(value);
}

/** The bare tool name behind an engine tool id (`coworker_assignment_create` → `assignment_create`), or null for any other tool. */
export function coworkerToolName(tool: string): CoworkerToolName | null {
  const prefix = `${COWORKER_TOOLS_MCP_NAME}_`;
  const bare = tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
  return isCoworkerToolName(bare) ? bare : null;
}

export function isAssignmentTool(name: CoworkerToolName): name is AssignmentToolName {
  return (ASSIGNMENT_TOOL_NAMES as readonly string[]).includes(name);
}

export function isTeamTool(name: CoworkerToolName): name is TeamToolName {
  return (TEAM_TOOL_NAMES as readonly string[]).includes(name);
}
