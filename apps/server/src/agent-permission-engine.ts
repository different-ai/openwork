// Agent permissions (packages/types/src/den/agent-permissions.ts) as each
// OpenCode engine applies them. Den delivers a member's permissions as ordered
// rules; this module maps them onto the engines' own permission config and
// says which tool calls, local skills and local MCP servers they block. It has
// no engine SDK or server dependency so the engine plugins can bundle it.
import {
  agentPermissionDenialMessage,
  agentPermissionRuleSchema,
  decideAgentPermission,
  websitePatternEngineResources,
  type AgentPermissionAction,
  type AgentPermissionDecision,
  type AgentPermissionRule,
} from "@openwork/types/den/agent-permissions-runtime";
import { isOrganizationMcpName, mcpServerUrl, type OrganizationMcpServers } from "./organization-mcp-names.js";

export type { AgentPermissionRule };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The rules in a verified desktop policy (Den sends them in its desktop config). */
export function agentPermissionRulesOf(policy: { agentPermissions?: { rules: unknown } } | undefined): AgentPermissionRule[] {
  return parseAgentPermissionRules(policy?.agentPermissions?.rules);
}

/** Rules from plugin options or a stored policy; anything malformed is dropped. */
export function parseAgentPermissionRules(value: unknown): AgentPermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = agentPermissionRuleSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Why the rules block this action on these resources, or null. */
export function agentPermissionDenial(rules: readonly AgentPermissionRule[], action: AgentPermissionAction, resources: readonly string[]): string | null {
  const decision = decideAgentPermission(rules, action, resources);
  return decision.effect === "deny" && decision.rule ? agentPermissionDenialMessage(decision.rule, decision.resource) : null;
}

/**
 * Why the rules block an MCP server from OpenWork's own runtime config, or
 * null. Organization names there are OpenWork's registrations (members cannot
 * create them), so they are never blocked.
 */
export function agentPermissionMcpDenial(rules: readonly AgentPermissionRule[], name: string): string | null {
  return isOrganizationMcpName(name) ? null : agentPermissionDenial(rules, "mcp", [name]);
}

/**
 * Why the rules block an MCP server an engine has from any config source, or
 * null. A server with an organization name is skipped only when it is the one
 * OpenWork registered under that name, at the same address.
 */
export function agentPermissionEngineMcpDenial(
  rules: readonly AgentPermissionRule[],
  name: string,
  server: unknown,
  organizationMcp: OrganizationMcpServers,
): string | null {
  const url = mcpServerUrl(server);
  if (url !== null && Object.hasOwn(organizationMcp, name) && organizationMcp[name]?.includes(url)) return null;
  return agentPermissionDenial(rules, "mcp", [name]);
}

// ---------------------------------------------------------------------------
// OpenCode v2: native permission rules, refined by the agent permissions plugin
// ---------------------------------------------------------------------------

export type EngineV2PermissionRule = { action: string; resource: string; effect: AgentPermissionDecision };

const V2_ACTIONS: readonly AgentPermissionAction[] = ["shell", "edit", "webfetch", "websearch", "skill"];

function v2Action(action: string): AgentPermissionAction | null {
  return V2_ACTIONS.find((entry) => entry === action) ?? null;
}

/**
 * The rules v2 evaluates natively, in order. A native denial skips the
 * permission hook and reaches the agent as a bare "Permission denied", even
 * through tools OpenWork wraps, so the plugin decides denials instead: they
 * ask natively, which still stops a call if the plugin is missing. Local
 * skills keep native denials so the engine leaves blocked skills out of the
 * catalog it offers. Website patterns become URL wildcards that never block a
 * URL the pattern allows; the plugin then decides with the exact pattern.
 */
export function agentPermissionEngineV2Rules(rules: readonly AgentPermissionRule[]): EngineV2PermissionRule[] {
  return rules.flatMap((rule) => {
    if (!V2_ACTIONS.includes(rule.action)) return [];
    const effect = rule.effect === "deny" && rule.action !== "skill" ? "ask" : rule.effect;
    if (rule.action !== "webfetch") return [{ action: rule.action, resource: rule.resource, effect }];
    return websitePatternEngineResources(rule.resource, rule.effect).map((resource) => ({ action: "webfetch", resource, effect }));
  });
}

/**
 * The decision a v2 permission evaluation ends with: the engine's, made at
 * least as strict as the organization's, with the rule that blocks a call
 * named in its message.
 */
export function agentPermissionEngineV2Decision(
  rules: readonly AgentPermissionRule[],
  action: string,
  resources: readonly string[],
  engineEffect: "allow" | "ask" | "deny",
): { effect: "allow" | "ask" | "deny"; message?: string } {
  const ourAction = v2Action(action);
  if (!ourAction) return { effect: engineEffect };
  const ours = decideAgentPermission(rules, ourAction, resources);
  if (ours.effect === "deny" && ours.rule) return { effect: "deny", message: agentPermissionDenialMessage(ours.rule, ours.resource) };
  if (ours.effect === "ask" && engineEffect === "allow") return { effect: "ask" };
  return { effect: engineEffect };
}

// ---------------------------------------------------------------------------
// OpenCode v1: permission maps applied after every config document merged
// ---------------------------------------------------------------------------

const V1_PERMISSION_KEYS: readonly (readonly [AgentPermissionAction, string])[] = [
  ["shell", "bash"],
  ["edit", "edit"],
  ["webfetch", "webfetch"],
  ["websearch", "websearch"],
  ["skill", "skill"],
];

/** v1 accepts only one decision for these, not patterns. */
const V1_SCALAR_ACTIONS: readonly AgentPermissionAction[] = ["webfetch", "websearch"];

type V1Permission = Record<string, AgentPermissionDecision | [pattern: string, effect: AgentPermissionDecision][]>;

/** The rules for one action in order, keeping only the last rule for a repeated pattern so the winner stays last. */
function orderedPatterns(rules: readonly AgentPermissionRule[], action: AgentPermissionAction): [string, AgentPermissionDecision][] {
  const seen = new Set<string>();
  const entries: [string, AgentPermissionDecision][] = [];
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (!rule || rule.action !== action || seen.has(rule.resource)) continue;
    seen.add(rule.resource);
    entries.unshift([rule.resource, rule.effect]);
  }
  return entries;
}

/**
 * The v1 permission config for the rules. Commands, file edits and local
 * skills keep their patterns. Websites and web search take one decision: the
 * `*` rule when nothing else needs a pattern; otherwise the plugin checks
 * each URL before the fetch runs.
 */
export function agentPermissionEngineV1Permission(rules: readonly AgentPermissionRule[], { scalarFallbackOnly = false } = {}): V1Permission {
  const permission: V1Permission = {};
  for (const [action, key] of V1_PERMISSION_KEYS) {
    const entries = orderedPatterns(rules, action);
    if (entries.length === 0) continue;
    if (V1_SCALAR_ACTIONS.includes(action)) {
      const all = entries.find(([pattern]) => pattern === "*")?.[1];
      const patterned = entries.some(([pattern, effect]) => pattern !== "*" && effect !== "deny");
      if (all === "deny" && !patterned) permission[key] = "deny";
      else if (all === "ask") permission[key] = "ask";
      continue;
    }
    // The engine config file is written with sorted keys, so only restrictive
    // entries go there: allowed exceptions are applied in order by the plugin.
    permission[key] = scalarFallbackOnly ? entries.filter(([, effect]) => effect !== "allow") : entries;
  }
  return permission;
}

function mergeV1Permission(existing: unknown, permission: V1Permission): Record<string, unknown> {
  const merged: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      merged[key] = value;
      continue;
    }
    const current = merged[key];
    const map: Record<string, unknown> = typeof current === "string" ? { "*": current } : isRecord(current) ? { ...current } : {};
    // Re-append the organization's patterns after everything else: the last
    // matching pattern decides, so no earlier entry can loosen them.
    for (const [pattern] of value) delete map[pattern];
    for (const [pattern, effect] of value) map[pattern] = effect;
    merged[key] = map;
  }
  return merged;
}

/**
 * Applies the rules to a merged v1 config in place: the organization's
 * patterns go last in the global and every agent's permissions, and blocked
 * local MCP servers are disabled, whichever config document added them.
 */
export function applyAgentPermissionsToV1Config(
  config: Record<string, unknown>,
  rules: readonly AgentPermissionRule[],
  organizationMcp: OrganizationMcpServers,
): void {
  if (rules.length === 0) return;
  const permission = agentPermissionEngineV1Permission(rules);
  config.permission = mergeV1Permission(config.permission, permission);
  if (isRecord(config.agent)) {
    for (const agent of Object.values(config.agent)) {
      if (isRecord(agent) && isRecord(agent.permission)) agent.permission = mergeV1Permission(agent.permission, permission);
    }
  }
  if (isRecord(config.mcp)) {
    for (const [name, server] of Object.entries(config.mcp)) {
      if (isRecord(server) && agentPermissionEngineMcpDenial(rules, name, server, organizationMcp)) server.enabled = false;
    }
  }
}

/** The restrictive part of the rules for the engine config file, where key order is not kept. */
export function agentPermissionV1FallbackPermission(rules: readonly AgentPermissionRule[]): V1Permission {
  return agentPermissionEngineV1Permission(rules, { scalarFallbackOnly: true });
}

export function mergeAgentPermissionsIntoV1Permission(existing: unknown, rules: readonly AgentPermissionRule[], { fallbackOnly = false } = {}): Record<string, unknown> {
  // Members without agent permissions keep exactly the permission config they had.
  if (rules.length === 0) return isRecord(existing) ? existing : {};
  return mergeV1Permission(existing, fallbackOnly ? agentPermissionV1FallbackPermission(rules) : agentPermissionEngineV1Permission(rules));
}

const V1_EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);

/** The text inside each `$(…)`, `<(…)`, `>(…)` and backtick substitution of a command line. */
function shellSubstitutions(line: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "`") {
      const end = line.indexOf("`", index + 1);
      if (end === -1) break;
      found.push(line.slice(index + 1, end));
      index = end;
    } else if ((char === "$" || char === "<" || char === ">") && line[index + 1] === "(") {
      let depth = 0;
      let end = index + 1;
      for (; end < line.length; end++) {
        if (line[end] === "(") depth++;
        else if (line[end] === ")" && --depth === 0) break;
      }
      found.push(line.slice(index + 2, end));
      index = end;
    }
  }
  return found;
}

/** The command without the variable assignments in front of it (`A=1 rm x` runs `rm x`). */
function withoutAssignments(command: string): string {
  const words = command.split(/\s+/);
  let first = 0;
  while (first < words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first] ?? "")) first++;
  return words.slice(first).join(" ");
}

/**
 * The commands a shell command line runs, roughly as the engine's parser finds
 * them: the line, each part between separators, and each command
 * substitution, searched again in turn. A rough split only adds candidates, so
 * a pattern can block more than the line runs, never less.
 */
function shellCommands(command: string): string[] {
  const found = new Set<string>();
  const visit = (text: string, depth: number) => {
    const line = text.trim();
    if (!line || found.has(line) || depth > 8) return;
    found.add(line);
    found.add(withoutAssignments(line));
    for (const inner of shellSubstitutions(line)) visit(inner, depth + 1);
    for (const part of line.split(/&&|\|\||[;|&\n]/)) visit(part, depth + 1);
  };
  visit(command, 0);
  return [...found].filter(Boolean);
}

/** Why the rules block a v1 tool call, or null. Checked before the tool runs, ahead of the engine's own permission check. */
export function agentPermissionV1ToolDenial(rules: readonly AgentPermissionRule[], tool: string, args: unknown): string | null {
  if (rules.length === 0) return null;
  const input = isRecord(args) ? args : {};
  if (tool === "bash" && typeof input.command === "string") return agentPermissionDenial(rules, "shell", shellCommands(input.command));
  if (tool === "webfetch" && typeof input.url === "string") return agentPermissionDenial(rules, "webfetch", [input.url]);
  if (tool === "websearch") return agentPermissionDenial(rules, "websearch", ["*"]);
  if (tool === "skill" && typeof input.name === "string") return agentPermissionDenial(rules, "skill", [input.name]);
  if (V1_EDIT_TOOLS.has(tool)) return agentPermissionDenial(rules, "edit", ["*"]);
  return null;
}
