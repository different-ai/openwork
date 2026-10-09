import {
  agentPermissionEngineMcpDenial,
  agentPermissionEngineV2Decision,
  parseAgentPermissionRules,
} from "../agent-permission-engine.js";
import { parseOrganizationMcpServers } from "../organization-mcp-names.js";

type Registration = { dispose(): Promise<void> };
type PermissionEvent = {
  readonly action: string;
  readonly resources: readonly string[];
  effect: "allow" | "ask" | "deny";
  message?: string;
};
type ToolError = { error?: { _tag?: unknown; permission?: unknown; resources?: unknown; reason?: string } };
type ExecuteAfter = { readonly status: string; readonly error?: ToolError };
type McpEditor = {
  list(): Iterable<readonly [string, unknown]>;
  set(name: string, config: Record<string, unknown>): void;
};
type Context = {
  options: { rules?: unknown; organizationMcp?: unknown };
  mcp: { transform(callback: (editor: McpEditor) => void): Promise<Registration> };
  permission: { hook(name: "evaluate", callback: (event: PermissionEvent) => void): Promise<Registration> };
  tool: { hook(name: "execute.after", callback: (event: ExecuteAfter) => void): Promise<Registration> };
};

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

// OpenWork's agent permissions plugin for OpenCode v2. OpenWork also writes
// the member's rules into the engine's own permission rules, with denials as
// Ask first; this plugin decides them, keeps them from being loosened by a
// project's config, decides websites with the exact patterns, and says which
// rule blocked a call.
export default {
  id: "openwork.agent-permissions",
  async setup(context: Context) {
    const rules = parseAgentPermissionRules(context.options.rules);
    const organizationMcp = parseOrganizationMcpServers(context.options.organizationMcp);
    // Called whenever the engine's own rules did not deny, which is every
    // agent permission but a blocked local skill.
    const permission = await context.permission.hook("evaluate", (event) => {
      const decision = agentPermissionEngineV2Decision(rules, event.action, event.resources, event.effect);
      event.effect = decision.effect;
      if (decision.message) event.message = decision.message;
    });
    // A blocked local skill is denied natively; name its rule when the error reaches this hook.
    const explain = await context.tool.hook("execute.after", (event) => {
      const blocked = event.status === "error" ? event.error?.error : undefined;
      if (blocked?._tag !== "Permission.BlockedError" || typeof blocked.permission !== "string") return;
      const decision = agentPermissionEngineV2Decision(rules, blocked.permission, strings(blocked.resources), "allow");
      if (decision.message) blocked.reason = decision.message;
    });
    // OpenCode has no permission action for MCP servers, so blocked local
    // servers are kept but disabled, from any config source. The organization
    // servers OpenWork registered pass through here too and stay as they are.
    const servers = rules.some((rule) => rule.action === "mcp")
      ? await context.mcp.transform((editor) => {
        for (const [name, server] of [...editor.list()]) {
          if (agentPermissionEngineMcpDenial(rules, name, server, organizationMcp) === null) continue;
          if (typeof server === "object" && server !== null) editor.set(name, { ...server, disabled: true });
        }
      })
      : undefined;
    return async () => {
      await servers?.dispose();
      await explain.dispose();
      await permission.dispose();
    };
  },
};
