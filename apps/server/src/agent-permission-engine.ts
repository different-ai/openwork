// Agent permissions (packages/types/src/den/agent-permissions.ts) as OpenCode
// v2 applies them; OpenCode v1 does not enforce them. Den delivers a member's
// permissions as ordered rules; this module maps them onto v2's own permission
// rules and says which tool calls, local skills and local MCP servers they
// block. It has no engine SDK or server dependency so the v2 plugin can bundle it.
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

/** The rules in a verified desktop policy (Den sends them in its desktop config). */
export function agentPermissionRulesOf(policy: { agentPermissions?: { rules: unknown } } | undefined): AgentPermissionRule[] {
  return parseAgentPermissionRules(policy?.agentPermissions?.rules);
}

/** Local skills and local MCP servers are each allowed or blocked as a whole. */
const WHOLE_CATEGORY_ACTIONS: readonly AgentPermissionAction[] = ["skill", "mcp"];

/**
 * Rules from plugin options or a stored policy; anything malformed is dropped.
 * A policy stored before skills and MCP servers became switches may still
 * name them: a name it blocks blocks the whole category, since the switch can
 * only block everything, and a name it allows is dropped.
 */
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

/** Why the rules block this action on these resources, or null. */
export function agentPermissionDenial(rules: readonly AgentPermissionRule[], action: AgentPermissionAction, resources: readonly string[]): string | null {
  const decision = decideAgentPermission(rules, action, resources);
  return decision.effect === "deny" && decision.rule ? agentPermissionDenialMessage(decision.rule, decision.resource) : null;
}

/**
 * Why the rules block an MCP server an engine has from any config source, or
 * null: every local server is blocked when local MCP servers are. The
 * organization's servers OpenWork registered (OpenWork Cloud and the
 * connections passed through it, registeredOrganizationMcpServers) are never
 * blocked, but only under their name and at the address OpenWork registered.
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
 * ask natively, which still stops a call if the plugin is missing. Blocked
 * local skills keep a native denial so the engine leaves them out of the
 * catalog it offers. The engine cannot tell a Cloud skill's discovery entry
 * from a local skill named like one, so those entries are left out too; the
 * organization's skills stay available through OpenWork Connect, which Den
 * serves and authorizes. A denial for every skill is followed by an allow for
 * a name no skill has: with only the denial the engine removes the skill tool
 * and does not bring it back once skills are allowed again, and the plugin
 * still refuses any skill that matched it. Website patterns become URL wildcards that never
 * block a URL the pattern allows; the plugin then decides with the exact
 * pattern.
 */
/** A skill name no folder can have (skill ids are folder names), allowed natively only to keep the skill tool registered. */
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

/**
 * The decision a v2 permission evaluation ends with: the engine's, made at
 * least as strict as the organization's, with the rule that blocks a call
 * named in its message. The engine asks about each command of a line on its
 * own and leaves out bare assignments, so `commandLine`, the whole line of the
 * shell call when known, supplies the values that may name a command's
 * program (`x=rm; $x -rf dir`). It is used only when it holds every resource.
 */
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
  // A line the parser cannot fully check is blocked where commands are, and
  // asked about where any command rule restricts it.
  if (parsed.some((entry) => entry.unchecked) && rules.some((rule) => rule.action === "shell" && rule.effect !== "allow")) {
    const decision = commandsDecision(rules);
    if (decision?.effect === "deny") return { effect: "deny", message: agentPermissionDenialMessage(decision, "*") };
    return { effect: engineEffect === "deny" ? "deny" : "ask" };
  }
  if (ours.effect === "ask" && engineEffect === "allow") return { effect: "ask" };
  return { effect: engineEffect };
}

/** The rule that sets the decision for every command, if any: the last command rule for `*`. */
function commandsDecision(rules: readonly AgentPermissionRule[]): AgentPermissionRule | undefined {
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index];
    if (rule?.action === "shell" && rule.resource === "*") return rule;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Shell commands: the commands a command line runs, for command rules
// ---------------------------------------------------------------------------

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

/** Reserved words and grouping a command can follow: `then rm x`, `do rm x`, `! rm x` and `{ rm x` run `rm x`. */
const SHELL_KEYWORDS = new Set(["!", "{", "}", "if", "then", "elif", "else", "fi", "while", "until", "do", "done", "time"]);

/**
 * The command without the shell keywords, subshell parentheses and case
 * pattern in front of it, and without a closing parenthesis after it:
 * `if true; then rm x; fi`, `(rm x)` and `case $a in b) rm x;; esac` run `rm x`.
 */
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

/** The words of a command, with quotes and backslash escapes removed. */
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

/** Programs that run their `-c` argument as a command line: shells, and `su` and `runuser` through one. */
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish", "su", "runuser"]);

/** Programs, and `find` actions, that run the command following their own options and arguments. */
const COMMAND_WRAPPERS = new Set([
  "sudo", "doas", "env", "nohup", "nice", "ionice", "command", "builtin", "exec", "timeout", "xargs",
  "stdbuf", "setsid", "watch", "chrt", "taskset", "unbuffer", "caffeinate", "busybox", "toybox", "-exec", "-execdir", "-ok", "-okdir",
]);

/** Most text one command line's parse reads; a line that needs more cannot be checked. */
const SHELL_PARSE_BUDGET = 2_000_000;

/** How deep scripts handed to other shells are searched; deeper ones cannot be checked. */
const SHELL_PARSE_DEPTH = 8;

/** Spends parse budget on this much text; false once the budget is gone. */
type Spend = (characters: number) => boolean;

function programName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** The line from each word from `from` on that is neither an option nor another wrapper, while the budget lasts. */
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

/** A command with its program named by file name only: `/bin/rm -rf x` runs `rm -rf x`. */
function byProgramName(command: string): string {
  const space = command.search(/\s/);
  return space === -1 ? programName(command) : `${programName(command.slice(0, space))}${command.slice(space)}`;
}

/**
 * Whether the program a command runs is named through something only the
 * shell resolves: a variable (`$x`, `${x}`), a substitution (`$(…)`, backticks)
 * or a pattern (`/bin/r?`, `{rm,}`). `[` and `[[` are the test command.
 */
function namesProgramDynamically(command: string): boolean {
  const program = /^\S*/.exec(command)?.[0] ?? "";
  return program !== "[" && program !== "[[" && /[$`*?[{]/.test(program);
}

/** `NAME=value` where the value is literal text, possibly quoted, not something the shell computes. */
const LITERAL_ASSIGNMENT = /(?<![^\s;&|(){}`'"])([A-Za-z_][A-Za-z0-9_]*)=((?:[^\s;&|()<>'"`$\\]|'[^']*'|"[^"$`\\]*")+)(?![^\s;&|()<>'"`])/g;

/** `for NAME in words`, up to the end of the line or the next `;`. */
const FOR_LOOP = /\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([^;\n]*)/g;

/** The literal values a command line gives each of its variables (see assignedValues). */
export type AssignedValues = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The literal values a command line gives each variable anywhere in it,
 * including in scripts it hands to other shells: `x=rm`, `export x='rm'`,
 * `x=rm $x` and `for x in ls rm`. A value the shell computes (`x=$(…)`) is left out.
 */
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

/** `$x` and `${x}`, and `${x:-word}`, `${x:=word}` and `${x:+word}`, whose word may be what they expand to. */
const VARIABLE_REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?::?[-=+]([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** Most commands one variable-named program resolves to; further combinations of values are not tried. */
const RESOLVED_COMMANDS_LIMIT = 32;

/**
 * The command with each variable in its program name replaced by every value
 * the line gives it, or the word a `${x:-word}` names: after `x=rm`, `$x -rf dir`
 * may run `rm -rf dir`. Variables nothing on the line sets stay as they are.
 */
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

/**
 * The scripts a command hands to another shell (`bash -c '…'`,
 * `bash --noprofile -o pipefail -c '…'`, `sudo -u x sh -lc '…'`,
 * `fish --command='…'`, `eval '…'`), and the text on a line whose shell may
 * read its script from input or a file (`echo 'rm x' | sh`, `sh <<< 'rm x'`),
 * so a rule for the commands inside applies to them too. Any word may start
 * one, so a wrapper in front never hides it, and every option is looked at,
 * so none hides the script. Later ones on the same line are found when the
 * script or command they belong to is searched in turn.
 */
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

/**
 * The command a wrapper runs after its own options and arguments
 * (`sudo -u x rm …`, `env A=1 rm …`, `timeout 5 rm …`, `xargs rm`,
 * `find . -exec rm {} ;`): each word after the wrapper that is neither an
 * option nor another wrapper may start it.
 */
function wrappedCommands(command: string, spend: Spend): string[] {
  const words = shellWords(command);
  const at = words.findIndex((word) => COMMAND_WRAPPERS.has(programName(word)));
  return at === -1 ? [] : commandsFrom(words, at + 1, spend);
}

/**
 * The commands a shell command line runs, roughly as the engine's parser finds
 * them: the line, each part between separators (also without the keywords in
 * front, as in `then rm x`, and with the program named by file name), each
 * command substitution, each script handed to another shell and each command
 * a wrapper such as `sudo` runs, searched again in turn. A rough split only
 * adds candidates, so a pattern can block more than the line runs, never less.
 *
 * A program named through a variable is also searched with each value
 * `assigned` gives it: by default the line's own assignments, or those of the
 * whole line the command belongs to.
 *
 * `unchecked` says the line runs something no pattern can be checked against:
 * a program named through an expansion (`$x -rf dir`), even one resolved
 * from the line, since its variable may hold something else when it runs,
 * scripts nested deeper than are searched, or more text than one parse reads.
 * A script that only exists when the line runs (`curl … | sh`) is checked as written.
 */
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
    // Keywords and assignments in front, and the program's folder, do not change what runs.
    const add = (candidate: string) => {
      const command = withoutShellKeywords(candidate);
      const stripped = withoutAssignments(command);
      for (const entry of [candidate, withoutAssignments(candidate), command, stripped, byProgramName(stripped)]) found.add(entry);
      if (!namesProgramDynamically(stripped)) return;
      unchecked = true;
      for (const resolved of resolvedCommands(stripped, assigned)) visit(resolved, depth + 1);
    };
    add(line);
    // Quotes do not change what runs: `"rm" -rf x` runs rm.
    const unquoted = shellWords(line).join(" ");
    if (unquoted) add(unquoted);
    for (const payload of interpreterPayloads(line, spend)) visit(payload, depth + 1);
    for (const wrapped of wrappedCommands(line, spend)) visit(wrapped, depth + 1);
    for (const inner of shellSubstitutions(line)) visit(inner, depth + 1);
    // Braces split too, so the commands in a function body or group (`f() { rm x; }`) are found.
    for (const part of line.split(/&&|\|\||[;|&\n{}]/)) visit(part, depth + 1);
  };
  visit(command, 0);
  return { commands: [...found].filter(Boolean), unchecked };
}

/** The commands a shell command line runs (see parseShellCommands). */
export function shellCommands(command: string): string[] {
  return parseShellCommands(command).commands;
}
