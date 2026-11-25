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
  permission: string;
  action: EffectiveEnginePermissionAction;
  rule: EffectiveEnginePermissionRule | null;
  source: PermissionSource | null;
  exceptions: number;
}

export interface PermissionLayers {
  global: unknown;
  openwork: unknown;
  workspace: unknown;
}

const PROBES: ReadonlyArray<{ key: EffectivePermissionKey; permission: string; pattern: string }> = [
  { key: "shell", permission: "bash", pattern: "*" },
  { key: "edit", permission: "edit", pattern: "*" },
  { key: "web", permission: "webfetch", pattern: "*" },
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

function expandPattern(pattern: string, home: string): string {
  if (pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern === "~") return home;
  if (pattern.startsWith("$HOME")) return home + pattern.slice(5);
  return pattern;
}

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

export function selectGoverningAgent<T extends { name: string }>(agents: T[], defaultAgent: string | null): T | null {
  return agents.find((agent) => agent.name === defaultAgent)
    ?? agents.find((agent) => agent.name === "openwork")
    ?? agents.find((agent) => agent.name === "build")
    ?? null;
}
