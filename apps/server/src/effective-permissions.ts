/**
 * Effective permissions: what the engine will do for this workspace, and
 * which config layer decided it.
 *
 * The engine evaluates one flat ruleset per agent — its own defaults, then
 * the user's global opencode.json, OpenWork's injected config, and the
 * workspace's opencode.json, deep-merged in that order and read last match
 * wins. This module asks the engine for that ruleset and, for the handful of
 * decisions users care about, reports the winning rule together with the
 * layer that wrote it. OpenWork does not evaluate policy itself.
 */
import { homedir } from "node:os";
import type { EffectiveEnginePermissionAction, EffectiveEnginePermissionRule } from "./agent-context-engine-inspection.js";

export type PermissionSource = "engine" | "global" | "openwork" | "workspace";

export type EffectivePermissionKey =
  | "shell"
  | "edit"
  | "web"
  | "mcp"
  | "outside_folders"
  | "env_files"
  | "doom_loop";

export interface EffectivePermissionRow {
  key: EffectivePermissionKey;
  /** The engine permission name the row summarises. */
  permission: string;
  action: EffectiveEnginePermissionAction;
  /** Winning rule when one matched; null when the engine falls back to its implicit ask. */
  rule: EffectiveEnginePermissionRule | null;
  source: PermissionSource | null;
  /** Rules for this permission that are narrower than the summarised one (allow-lists, folder grants). */
  exceptions: number;
}

export interface PermissionLayers {
  /** `permission` block of the user's global opencode.json, as written. */
  global: unknown;
  /** `permission` block OpenWork injects through OPENCODE_CONFIG. */
  openwork: unknown;
  /** `permission` block of the workspace's opencode.json, as written. */
  workspace: unknown;
}

const PROBES: ReadonlyArray<{ key: EffectivePermissionKey; permission: string; pattern: string }> = [
  { key: "shell", permission: "bash", pattern: "*" },
  { key: "edit", permission: "edit", pattern: "*" },
  { key: "web", permission: "webfetch", pattern: "*" },
  // A tool name no config is expected to spell out, so only catch-all rules decide it.
  { key: "mcp", permission: "openwork_effective_mcp_probe", pattern: "*" },
  { key: "outside_folders", permission: "external_directory", pattern: "*" },
  { key: "env_files", permission: "read", pattern: "/workspace/.env" },
  { key: "doom_loop", permission: "doom_loop", pattern: "*" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAction(value: unknown): value is EffectiveEnginePermissionAction {
  return value === "allow" || value === "ask" || value === "deny";
}

/** Engine `Wildcard.match`: `*` any run, `?` one character, trailing ` *` optional. */
export function matchesPermissionPattern(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized);
}

/** Engine `Permission.evaluate`: the last matching rule wins; nothing matching means ask. */
export function winningRule(
  rules: EffectiveEnginePermissionRule[],
  permission: string,
  pattern: string,
): EffectiveEnginePermissionRule | null {
  let winner: EffectiveEnginePermissionRule | null = null;
  for (const rule of rules) {
    if (matchesPermissionPattern(permission, rule.permission) && matchesPermissionPattern(pattern, rule.pattern)) winner = rule;
  }
  return winner;
}

/** Engine pattern expansion for `~` and `$HOME` prefixes, applied when config is loaded. */
function expandPattern(pattern: string, home: string): string {
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern === "~") return home;
  if (pattern.startsWith("$HOME")) return home + pattern.slice(5);
  return pattern;
}

/** Flatten one config `permission` block the way the engine does (`fromConfig`). */
export function rulesFromPermissionConfig(value: unknown, home = homedir()): EffectiveEnginePermissionRule[] {
  const block = isAction(value) ? { "*": value } : isRecord(value) ? value : null;
  if (!block) return [];
  const rules: EffectiveEnginePermissionRule[] = [];
  for (const [permission, entry] of Object.entries(block)) {
    if (isAction(entry)) {
      rules.push({ permission, pattern: "*", action: entry });
      continue;
    }
    if (!isRecord(entry)) continue;
    for (const [pattern, action] of Object.entries(entry)) {
      if (isAction(action)) rules.push({ permission, pattern: expandPattern(pattern, home), action });
    }
  }
  return rules;
}

function layerContains(layerRules: EffectiveEnginePermissionRule[], rule: EffectiveEnginePermissionRule): boolean {
  return layerRules.some((candidate) =>
    candidate.permission === rule.permission && candidate.pattern === rule.pattern && candidate.action === rule.action);
}

/**
 * Attribute a winning rule to the last layer that wrote it. Layers are
 * checked in the engine's merge order from last to first; a rule found in no
 * config file is the engine's own default.
 */
export function attributeRule(rule: EffectiveEnginePermissionRule, layers: PermissionLayers, home = homedir()): PermissionSource {
  const ordered: Array<[PermissionSource, unknown]> = [
    ["workspace", layers.workspace],
    ["openwork", layers.openwork],
    ["global", layers.global],
  ];
  for (const [source, block] of ordered) {
    if (layerContains(rulesFromPermissionConfig(block, home), rule)) return source;
  }
  return "engine";
}

export function summarizeEffectivePermissions(
  rules: EffectiveEnginePermissionRule[],
  layers: PermissionLayers,
  home = homedir(),
): EffectivePermissionRow[] {
  return PROBES.map(({ key, permission, pattern }) => {
    const rule = winningRule(rules, permission, pattern);
    const exceptions = rules.filter((candidate) =>
      candidate.permission === permission
      && candidate.pattern !== "*"
      && !(candidate.permission === rule?.permission && candidate.pattern === rule.pattern && candidate.action === rule.action)).length;
    return {
      key,
      permission,
      action: rule?.action ?? "ask",
      rule,
      source: rule ? attributeRule(rule, layers, home) : null,
      exceptions,
    };
  });
}

/** Pick the agent whose ruleset governs new threads: the configured default, else the engine's build agent. */
export function selectGoverningAgent<T extends { name: string }>(agents: T[], defaultAgent: string | null): T | null {
  return agents.find((agent) => agent.name === defaultAgent)
    ?? agents.find((agent) => agent.name === "openwork")
    ?? agents.find((agent) => agent.name === "build")
    ?? null;
}
