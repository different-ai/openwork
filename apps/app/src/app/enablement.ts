import type { EnablementCondition, EnablementResult } from "./extensions";
import type { McpStatusMap } from "./types";

export type EnablementContext = {
  mcpStatuses?: McpStatusMap;
  mcpConfigured?: Set<string>;
  connectedProviders?: Set<string>;
  configuredEnvKeys?: Set<string>;
  isToggleEnabled?: (ref: string) => boolean;
};

function evaluateCondition(condition: EnablementCondition, ctx: EnablementContext): boolean {
  switch (condition.type) {
    case "mcp-connected": {
      const status = ctx.mcpStatuses?.[condition.ref];
      return status?.status === "connected";
    }
    case "provider-connected":
      return ctx.connectedProviders?.has(condition.ref) === true;
    case "env-set":
      return ctx.configuredEnvKeys?.has(condition.ref) === true;
    case "toggle-enabled":
      return ctx.isToggleEnabled?.(condition.ref) === true;
    default:
      return false;
  }
}

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
