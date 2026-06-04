import type { EnablementCondition, EnablementResult } from "./extensions";
import type { McpStatusMap } from "./types";

/**
 * Runtime context needed to evaluate enablement conditions.
 * Each field is optional — missing context means the condition is unmet.
 */
export type EnablementContext = {
  /** MCP server runtime statuses keyed by server name. */
  mcpStatuses?: McpStatusMap;
  /** Set of MCP server names that are at least configured (in opencode.json). */
  mcpConfigured?: Set<string>;
  /** Set of loaded plugin package names or path fragments. */
  loadedPlugins?: Set<string>;
  /** Set of connected provider IDs. */
  connectedProviders?: Set<string>;
  /** Set of environment variable keys that are configured. */
  configuredEnvKeys?: Set<string>;
  /** Permission results from the Computer Use --check binary. */
  permissions?: { accessibility?: boolean; screenRecording?: boolean };
  /** Toggle state reader — returns true if the extension toggle is on. */
  isToggleEnabled?: (ref: string) => boolean;
};

/**
 * Evaluate a single enablement condition against runtime context.
 */
function evaluateCondition(condition: EnablementCondition, ctx: EnablementContext): boolean {
  switch (condition.type) {
    case "mcp-connected": {
      const status = ctx.mcpStatuses?.[condition.ref];
      return status?.status === "connected";
    }
    case "plugin-loaded":
      return ctx.loadedPlugins?.has(condition.ref) === true;
    case "provider-connected":
      return ctx.connectedProviders?.has(condition.ref) === true;
    case "env-set":
      return ctx.configuredEnvKeys?.has(condition.ref) === true;
    case "permission-granted": {
      if (!ctx.permissions) return false;
      if (condition.ref === "accessibility") return ctx.permissions.accessibility === true;
      if (condition.ref === "screenRecording") return ctx.permissions.screenRecording === true;
      return false;
    }
    case "toggle-enabled":
      return ctx.isToggleEnabled?.(condition.ref) === true;
    default:
      return false;
  }
}

/**
 * Evaluate all enablement conditions for an extension.
 * Returns per-condition results and an overall `active` boolean.
 */
export function evaluateEnablement(
  conditions: EnablementCondition[] | undefined,
  ctx: EnablementContext,
): { active: boolean; results: EnablementResult[] } {
  if (!conditions || conditions.length === 0) {
    return { active: false, results: [] };
  }
  const results = conditions.map((condition) => ({
    condition,
    met: evaluateCondition(condition, ctx),
  }));
  return {
    active: results.every((r) => r.met),
    results,
  };
}

/**
 * For plain MCP entries that don't have an extension manifest,
 * generate a default single-condition enablement: mcp-connected.
 */
export function defaultMcpEnablement(serverName: string): EnablementCondition[] {
  return [{ type: "mcp-connected", ref: serverName, label: "MCP server connected" }];
}
