import {
  agentPermissionDenialMessage,
  agentPermissionRuleSchema,
  decideAgentPermission,
  websitePatternEngineResources,
  type AgentPermissionAction,
  type AgentPermissionDecision,
  type AgentPermissionRule,
} from "@openwork/types/den/agent-permissions-runtime";
import { mcpServerUrl, type OrganizationMcpServers } from "./organization-mcp-names.js";

export type { AgentPermissionRule };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function agentPermissionRulesOf(policy: { agentPermissions?: { rules: unknown } } | undefined): AgentPermissionRule[] {
  return parseAgentPermissionRules(policy?.agentPermissions?.rules);
}

const WHOLE_CATEGORY_ACTIONS: readonly AgentPermissionAction[] = ["skill", "mcp"];

export function parseAgentPermissionRules(value: unknown): AgentPermissionRule[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const parsed = agentPermissionRuleSchema.safeParse(entry);
    if (!parsed.success) return [];
    const rule = parsed.data;
    if (!WHOLE_CATEGORY_ACTIONS.includes(rule.action) || rule.resource === "*") return [rule];
    return rule.effect === "deny" ? [{ ...rule, resource: "*" }] : [];
  });
}

export function agentPermissionDenial(rules: readonly AgentPermissionRule[], action: AgentPermissionAction, resources: readonly string[]): string | null {
  const decision = decideAgentPermission(rules, action, resources);
  return decision.effect === "deny" && decision.rule ? agentPermissionDenialMessage(decision.rule, decision.resource) : null;
}

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

export type EngineV2PermissionRule = { action: string; resource: string; effect: AgentPermissionDecision };

const V2_ACTIONS: readonly AgentPermissionAction[] = ["shell", "edit", "external_directory", "webfetch", "websearch", "skill"];

function v2Action(action: string): AgentPermissionAction | null {
  return V2_ACTIONS.find((entry) => entry === action) ?? null;
}

const V2_TOOL_ACTIONS: Readonly<Record<string, AgentPermissionAction>> = {
  shell: "shell",
  edit: "edit",
  write: "edit",
  patch: "edit",
  opencode_worktree_remove: "edit",
  webfetch: "webfetch",
  websearch: "websearch",
  skill: "skill",
};

export function agentPermissionEngineV2ToolHidden(rules: readonly AgentPermissionRule[], tool: string): boolean {
  const action = V2_TOOL_ACTIONS[tool];
  if (!action) return false;
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (rule?.action !== action) continue;
    if (rule.effect !== "deny") return false;
    if (rule.resource === "*") return true;
  }
  return false;
}

const SKILL_TOOL_KEEPER = "openwork/agent-permissions/no-skill";

export function agentPermissionEngineV2Rules(rules: readonly AgentPermissionRule[]): EngineV2PermissionRule[] {
  return rules.flatMap((rule) => {
    if (!V2_ACTIONS.includes(rule.action)) return [];
    if (rule.action === "skill") {
      return rule.effect === "deny" && rule.resource === "*"
        ? [{ action: "skill", resource: "*", effect: "deny" }, { action: "skill", resource: SKILL_TOOL_KEEPER, effect: "allow" }]
        : [{ action: "skill", resource: rule.resource, effect: rule.effect }];
    }
    const effect = rule.effect === "deny" ? "ask" : rule.effect;
    if (rule.action !== "webfetch") return [{ action: rule.action, resource: rule.resource, effect }];
    return websitePatternEngineResources(rule.resource, rule.effect).map((resource) => ({ action: "webfetch", resource, effect }));
  });
}

export function agentPermissionEngineV2Decision(
  rules: readonly AgentPermissionRule[],
  action: string,
  resources: readonly string[],
  engineEffect: "allow" | "ask" | "deny",
  commandLine?: string,
): { effect: "allow" | "ask" | "deny"; message?: string } {
  const ourAction = v2Action(action);
  if (!ourAction) return { effect: engineEffect };
  const assigned = commandLine !== undefined && resources.every((resource) => commandLine.includes(resource)) ? assignedValues(commandLine) : undefined;
  const parsed = ourAction === "shell" ? resources.map((resource) => parseShellCommands(resource, assigned)) : [];
  const commands = ourAction === "shell" ? parsed.flatMap((entry) => entry.commands) : resources;
  const ours = decideAgentPermission(rules, ourAction, commands);
  if (ours.effect === "deny" && ours.rule) return { effect: "deny", message: agentPermissionDenialMessage(ours.rule, ours.resource) };
  if (parsed.some((entry) => entry.unchecked) && rules.some((rule) => rule.action === "shell" && rule.effect !== "allow")) {
    const decision = commandsDecision(rules);
    if (decision?.effect === "deny") return { effect: "deny", message: agentPermissionDenialMessage(decision, "*") };
    return { effect: engineEffect === "deny" ? "deny" : "ask" };
  }
  if (ours.effect === "ask" && engineEffect === "allow") return { effect: "ask" };
  return { effect: engineEffect };
}

function commandsDecision(rules: readonly AgentPermissionRule[]): AgentPermissionRule | undefined {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (rule?.action === "shell" && rule.resource === "*") return rule;
  }
  return undefined;
}

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

function withoutAssignments(command: string): string {
  const words = command.split(/\s+/);
  let first = 0;
  while (first < words.length - 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[first] ?? "")) first++;
  return words.slice(first).join(" ");
}

const SHELL_KEYWORDS = new Set(["!", "{", "}", "if", "then", "elif", "else", "fi", "while", "until", "do", "done", "time"]);

function withoutShellKeywords(command: string): string {
  let rest = command.trim();
  for (let previous = ""; previous !== rest;) {
    previous = rest;
    rest = rest.replace(/^\(+\s*/, "").replace(/^case\s+\S+\s+in\s+/, "").replace(/^[^\s()]*\)\s*/, "");
    const word = /^\S+/.exec(rest)?.[0];
    if (word && SHELL_KEYWORDS.has(word)) rest = rest.slice(word.length).trimStart();
  }
  let end = rest.length;
  while (rest[end - 1] === ")") end--;
  return rest.slice(0, end).trimEnd();
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index]!;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (char === "\\" && index + 1 < command.length) {
      word = (word ?? "") + command[++index]!;
    } else if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "su", "runuser"]);

const COMMAND_WRAPPERS = new Set([
  "sudo", "doas", "env", "nohup", "nice", "ionice", "command", "builtin", "exec", "timeout", "xargs",
  "stdbuf", "setsid", "watch", "chrt", "taskset", "unbuffer", "caffeinate", "busybox", "toybox", "-exec", "-execdir", "-ok", "-okdir",
]);

const SHELL_PARSE_BUDGET = 2_000_000;

const SHELL_PARSE_DEPTH = 8;

type Spend = (characters: number) => boolean;

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

function commandsFrom(words: readonly string[], from: number, spend: Spend): string[] {
  const found: string[] = [];
  for (let at = from; at < words.length; at++) {
    const word = words[at]!;
    if (word.startsWith("-") || COMMAND_WRAPPERS.has(programName(word))) continue;
    const command = words.slice(at).join(" ");
    if (!spend(command.length)) break;
    found.push(command);
  }
  return found;
}

function byProgramName(command: string): string {
  const space = command.search(/\s/);
  return space === -1 ? programName(command) : `${programName(command.slice(0, space))}${command.slice(space)}`;
}

function namesProgramDynamically(command: string): boolean {
  const program = /^\S*/.exec(command)?.[0] ?? "";
  return program !== "[" && program !== "[[" && /[$`*?[{]/.test(program);
}

const LITERAL_ASSIGNMENT = /(?<![^\s;&|(){}`'"])([A-Za-z_][A-Za-z0-9_]*)=((?:[^\s;&|()<>'"`$\\]|'[^']*'|"[^"$`\\]*")+)(?![^\s;&|()<>'"`])/g;

const FOR_LOOP = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]*)/g;

export type AssignedValues = ReadonlyMap<string, ReadonlySet<string>>;

function assignedValues(text: string): AssignedValues {
  const values = new Map<string, Set<string>>();
  const assign = (name: string, value: string) => {
    if (!value || /[$`]/.test(value)) return;
    const known = values.get(name) ?? new Set<string>();
    values.set(name, known.add(value));
  };
  const scanned = text.slice(0, SHELL_PARSE_BUDGET);
  for (const [, name, value] of scanned.matchAll(LITERAL_ASSIGNMENT)) assign(name!, shellWords(value!).join(" "));
  for (const [, name, list] of scanned.matchAll(FOR_LOOP)) {
    const words = shellWords(list!);
    const end = words.indexOf("do");
    for (const word of end === -1 ? words : words.slice(0, end)) assign(name!, word);
  }
  return values;
}

const VARIABLE_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-=+]([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

const RESOLVED_COMMANDS_LIMIT = 32;

function resolvedCommands(command: string, values: AssignedValues): string[] {
  const program = /^\S*/.exec(command)?.[0] ?? "";
  let resolved = [command];
  for (const [reference, braced, word, plain] of program.matchAll(VARIABLE_REFERENCE)) {
    const options = new Set(values.get((braced ?? plain)!));
    if (word && !/[$`]/.test(word)) options.add(word);
    if (options.size === 0) continue;
    resolved = resolved.flatMap((entry) => [...options].map((value) => entry.replaceAll(reference, value))).slice(0, RESOLVED_COMMANDS_LIMIT);
  }
  return resolved.filter((entry) => entry !== command);
}

function interpreterPayloads(command: string, spend: Spend): string[] {
  const words = shellWords(command);
  const found: string[] = [];
  const evalAt = words.findIndex((word) => programName(word) === "eval");
  if (evalAt !== -1) found.push(words.slice(evalAt + 1).join(" "));
  const shellAt = words.findIndex((word) => SHELL_INTERPRETERS.has(programName(word)));
  for (let at = shellAt === -1 ? words.length : shellAt + 1; at < words.length; at++) {
    const option = words[at]!;
    if (/^-[A-Za-z]*c[A-Za-z]*$/.test(option) || option === "--command") found.push(words[at + 1] ?? "");
    else if (option.startsWith("--command=")) found.push(option.slice("--command=".length));
  }
  if (command.split(/[\s|;&()<>]+/).some((token) => SHELL_INTERPRETERS.has(programName(token)))) {
    found.push(...words.filter((word) => /\s/.test(word)), ...commandsFrom(words, 1, spend));
  }
  return found;
}

function wrappedCommands(command: string, spend: Spend): string[] {
  const words = shellWords(command);
  const at = words.findIndex((word) => COMMAND_WRAPPERS.has(programName(word)));
  return at === -1 ? [] : commandsFrom(words, at + 1, spend);
}

export function parseShellCommands(command: string, assigned: AssignedValues = assignedValues(command)): { commands: string[]; unchecked: boolean } {
  const found = new Set<string>();
  let unchecked = false;
  let budget = SHELL_PARSE_BUDGET;
  const spend: Spend = (characters) => {
    budget -= characters;
    if (budget < 0) unchecked = true;
    return budget >= 0;
  };
  const visit = (text: string, depth: number) => {
    const line = text.trim();
    if (!line || found.has(line)) return;
    if (depth > SHELL_PARSE_DEPTH || !spend(line.length)) {
      unchecked = true;
      return;
    }
    const add = (candidate: string) => {
      const command = withoutShellKeywords(candidate);
      const stripped = withoutAssignments(command);
      for (const entry of [candidate, withoutAssignments(candidate), command, stripped, byProgramName(stripped)]) found.add(entry);
      if (!namesProgramDynamically(stripped)) return;
      unchecked = true;
      for (const resolved of resolvedCommands(stripped, assigned)) visit(resolved, depth + 1);
    };
    add(line);
    const unquoted = shellWords(line).join(" ");
    if (unquoted) add(unquoted);
    for (const payload of interpreterPayloads(line, spend)) visit(payload, depth + 1);
    for (const wrapped of wrappedCommands(line, spend)) visit(wrapped, depth + 1);
    for (const inner of shellSubstitutions(line)) visit(inner, depth + 1);
    for (const part of line.split(/&&|\|\||[;|&\n{}]/)) visit(part, depth + 1);
  };
  visit(command, 0);
  return { commands: [...found].filter(Boolean), unchecked };
}

export function shellCommands(command: string): string[] {
  return parseShellCommands(command).commands;
}
