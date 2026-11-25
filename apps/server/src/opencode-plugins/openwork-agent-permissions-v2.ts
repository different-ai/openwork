import {
  agentPermissionEngineMcpDenial,
  agentPermissionEngineV2Decision,
  agentPermissionEngineV2ToolHidden,
  parseAgentPermissionRules,
} from "../agent-permission-engine.js";
import { parseOrganizationMcpServers } from "../organization-mcp-names.js";

type Registration = { dispose(): Promise<void> };
type PermissionEvent = {
  readonly action: string;
  readonly resources: readonly string[];
  readonly source?: { readonly type?: string; readonly id?: string };
  effect: "allow" | "ask" | "deny";
  message?: string;
};
type ToolError = { error?: { _tag?: unknown; permission?: unknown; resources?: unknown; reason?: string } };
type ExecuteBefore = { readonly tool: string; readonly id: string; readonly input: unknown };
type ExecuteAfter = { readonly status: string; readonly error?: ToolError };
type McpEditor = {
  list(): Iterable<readonly [string, unknown]>;
  set(name: string, config: Record<string, unknown>): void;
};
type Context = {
  options: { rules?: unknown; organizationMcp?: unknown };
  mcp: { transform(callback: (editor: McpEditor) => void): Promise<Registration> };
  permission: { hook(name: "evaluate", callback: (event: PermissionEvent) => void): Promise<Registration> };
  tool: {
    transform(callback: (editor: { list(): readonly { id: string }[]; remove(id: string): void }) => void): Promise<Registration>;
    hook(name: "execute.before", callback: (event: ExecuteBefore) => void): Promise<Registration>;
    hook(name: "execute.after", callback: (event: ExecuteAfter) => void): Promise<Registration>;
  };
};

const COMMAND_LINES_KEPT = 100;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export default {
  id: "openwork.agent-permissions",
  async setup(context: Context) {
    const rules = parseAgentPermissionRules(context.options.rules);
    const organizationMcp = parseOrganizationMcpServers(context.options.organizationMcp);
    const catalog = await context.tool.transform((editor) => {
      for (const tool of editor.list()) {
        if (agentPermissionEngineV2ToolHidden(rules, tool.id)) editor.remove(tool.id);
      }
    });
    const commandLines = new Map<string, string>();
    const lines = await context.tool.hook("execute.before", (event) => {
      const command = typeof event.input === "object" && event.input !== null ? (event.input as { command?: unknown }).command : undefined;
      if (event.tool !== "shell" || typeof command !== "string") return;
      commandLines.set(event.id, command);
      if (commandLines.size > COMMAND_LINES_KEPT) commandLines.delete(commandLines.keys().next().value!);
    });
    const permission = await context.permission.hook("evaluate", (event) => {
      const line = event.source?.type === "tool" && event.source.id ? commandLines.get(event.source.id) : undefined;
      const decision = agentPermissionEngineV2Decision(rules, event.action, event.resources, event.effect, line);
      event.effect = decision.effect;
      if (decision.message) event.message = decision.message;
    });
    const explain = await context.tool.hook("execute.after", (event) => {
      const blocked = event.status === "error" ? event.error?.error : undefined;
      if (blocked?._tag !== "Permission.BlockedError" || typeof blocked.permission !== "string") return;
      const decision = agentPermissionEngineV2Decision(rules, blocked.permission, strings(blocked.resources), "allow");
      if (decision.message) blocked.reason = decision.message;
    });
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
      await lines.dispose();
      await catalog.dispose();
    };
  },
};
