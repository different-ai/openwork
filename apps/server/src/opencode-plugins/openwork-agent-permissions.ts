import {
  agentPermissionV1ToolDenial,
  applyAgentPermissionsToV1Config,
  parseAgentPermissionRules,
} from "../agent-permission-engine.js";
import { parseOrganizationMcpServers } from "../organization-mcp-names.js";

// OpenWork's agent permissions plugin for OpenCode v1. OpenWork passes the
// member's rules as plugin options, with the organization MCP servers it
// registered itself. The config hook runs after every config document has
// merged, so a project's own config cannot loosen them; the tool hook blocks
// what v1 config cannot express (website patterns) before the tool runs, and
// names the rule that blocked it.
export default async function openworkAgentPermissions(_input: unknown, options?: { rules?: unknown; organizationMcp?: unknown }) {
  const rules = parseAgentPermissionRules(options?.rules);
  const organizationMcp = parseOrganizationMcpServers(options?.organizationMcp);
  return {
    config: async (config: Record<string, unknown>) => {
      applyAgentPermissionsToV1Config(config, rules, organizationMcp);
    },
    "tool.execute.before": async (input: { tool: string }, output: { args: unknown }) => {
      const denial = agentPermissionV1ToolDenial(rules, input.tool, output.args);
      if (denial) throw new Error(denial);
    },
  };
}
