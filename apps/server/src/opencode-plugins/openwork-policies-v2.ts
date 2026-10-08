import { policyRuleDenial, policyRuleDenialMessage, type PolicyRuleAction, type SourcedPolicyRule } from "@openwork/types/den/policy-rules-runtime";
import { isOrganizationMcpName } from "../organization-mcp-names.js";

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
  options: { rules?: SourcedPolicyRule[] };
  mcp: { transform(callback: (editor: McpEditor) => void): Promise<Registration> };
  permission: { hook(name: "evaluate", callback: (event: PermissionEvent) => void): Promise<Registration> };
  tool: { hook(name: "execute.after", callback: (event: ExecuteAfter) => void): Promise<Registration> };
};

// Actions this plugin keeps the organization's rules for.
const ENFORCED: readonly PolicyRuleAction[] = ["shell", "skill"];

function enforced(action: unknown): action is PolicyRuleAction {
  return ENFORCED.some((entry) => entry === action);
}

/** Why the organization's rules block this request, or null when they do not. */
export function teamRuleDenial(rules: readonly SourcedPolicyRule[], action: unknown, resources: readonly unknown[]): string | null {
  if (!enforced(action)) return null;
  const denial = policyRuleDenial(rules, action, resources.filter((resource) => typeof resource === "string"));
  return denial ? policyRuleDenialMessage(denial) : null;
}

// The OpenWork policies plugin. OpenWork also writes the member's team rules
// into the engine's own permission rules; this plugin keeps them from being
// loosened by a project's config and says which rule blocked a call, as
// OpenCode's Plan plugin does for its own permission rules.
export default {
  id: "openwork.policies",
  async setup(context: Context) {
    const rules = context.options.rules ?? [];
    // Reached only when the engine's rules allow the request, for example
    // after a project's config added its own allow rule.
    const permission = await context.permission.hook("evaluate", (event) => {
      const message = teamRuleDenial(rules, event.action, event.resources);
      if (message === null) return;
      event.effect = "deny";
      event.message = message;
    });
    const explain = await context.tool.hook("execute.after", (event) => {
      const blocked = event.status === "error" ? event.error?.error : undefined;
      if (blocked?._tag !== "Permission.BlockedError" || !Array.isArray(blocked.resources)) return;
      const message = teamRuleDenial(rules, blocked.permission, blocked.resources);
      if (message !== null) blocked.reason = message;
    });
    // OpenCode has no permission action for MCP servers, so `mcp` rules apply
    // to the server registry the way OpenCode's provider policies apply to its
    // catalog: a blocked local server is kept but disabled, from any source.
    const servers = rules.some((rule) => rule.action === "mcp")
      ? await context.mcp.transform((editor) => {
        for (const [name, server] of [...editor.list()]) {
          if (isOrganizationMcpName(name) || policyRuleDenial(rules, "mcp", [name]) === null) continue;
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
