import { z } from "zod";

/**
 * Agent permissions: what agents may do on members' computers. An
 * organization's admins set them for everyone and override them per team in
 * Den; each member's desktop app applies them to every agent turn, on both
 * engines, and to its built-in browser.
 *
 * A permission is one family of agent actions (commands, file edits,
 * websites, web search, local skills, local MCP servers) with
 *
 *   - a decision: Allow, Ask first or Block (a picklist), or on/off for the
 *     families that cannot ask (a checkbox);
 *   - optional "Always allowed" and "Always blocked" lists of patterns.
 *
 * A member's permissions resolve to OpenCode permission rules
 * `{ action, resource, effect }`, checked in order with the last matching
 * rule deciding, exactly as OpenCode does. Blocked patterns come last, so a
 * block always wins.
 *
 * To add a permission: add a definition below, give it an engine action in
 * apps/server/src/agent-permission-engine.ts, and enforce it wherever that
 * action can happen.
 */

export const AGENT_PERMISSION_DECISIONS = ["allow", "ask", "deny"] as const;
export type AgentPermissionDecision = (typeof AGENT_PERMISSION_DECISIONS)[number];

/** OpenCode permission actions, plus `mcp` for local MCP servers, which OpenWork enforces itself. */
export const AGENT_PERMISSION_ACTIONS = ["shell", "edit", "webfetch", "websearch", "skill", "mcp"] as const;
export type AgentPermissionAction = (typeof AGENT_PERMISSION_ACTIONS)[number];

export type AgentPermissionPatternKind = "command" | "website" | "name";

export type AgentPermissionSection = "commands" | "files" | "web" | "extensions";

export const agentPermissionSections: readonly { id: AgentPermissionSection; label: string }[] = [
  { id: "commands", label: "Commands" },
  { id: "files", label: "Files" },
  { id: "web", label: "Web" },
  { id: "extensions", label: "Local extensions" },
];

type AgentPermissionDefinitionEntry = {
  key: string;
  section: AgentPermissionSection;
  /** What the agent does, as the row's label. */
  label: string;
  /** One sentence, shown as the row's tooltip. */
  description: string;
  action: AgentPermissionAction;
  /** `choice` is a picklist of decisions; `toggle` is on (allow) or off (deny). */
  control: "choice" | "toggle";
  /** The patterns its lists hold, or null when it has no lists. */
  patterns: AgentPermissionPatternKind | null;
  /** What one pattern names, for "Always block a command". */
  patternNoun: string | null;
};

export const agentPermissionDefinitions = [
  {
    key: "commands",
    section: "commands",
    label: "Run commands",
    description: "Commands the agent runs in a terminal on the member's computer.",
    action: "shell",
    control: "choice",
    patterns: "command",
    patternNoun: "command",
  },
  {
    key: "fileEdits",
    section: "files",
    label: "Edit files",
    description: "Creating, changing and deleting files in the member's workspace.",
    action: "edit",
    control: "choice",
    patterns: null,
    patternNoun: null,
  },
  {
    key: "websites",
    section: "web",
    label: "Open websites",
    description: "Pages the agent fetches, and pages the desktop app's built-in browser opens.",
    action: "webfetch",
    control: "choice",
    patterns: "website",
    patternNoun: "website",
  },
  {
    key: "webSearch",
    section: "web",
    label: "Search the web",
    description: "Web searches the agent runs.",
    action: "websearch",
    control: "toggle",
    patterns: null,
    patternNoun: null,
  },
  {
    key: "localSkills",
    section: "extensions",
    label: "Use local skills",
    description: "Skills installed on the member's computer. Skills shared by the organization are not affected.",
    action: "skill",
    control: "toggle",
    patterns: "name",
    patternNoun: "skill",
  },
  {
    key: "localMcpServers",
    section: "extensions",
    label: "Use local MCP servers",
    description: "MCP servers added on the member's computer. Organization connections are not affected.",
    action: "mcp",
    control: "toggle",
    patterns: "name",
    patternNoun: "server",
  },
] as const satisfies readonly AgentPermissionDefinitionEntry[];

export type AgentPermissionKey = (typeof agentPermissionDefinitions)[number]["key"];
export type AgentPermissionDefinition = AgentPermissionDefinitionEntry & { key: AgentPermissionKey };

export const agentPermissionKeys: readonly AgentPermissionKey[] = agentPermissionDefinitions.map((definition) => definition.key);

export function agentPermissionDefinition(key: AgentPermissionKey): AgentPermissionDefinition {
  const definition = agentPermissionDefinitions.find((entry) => entry.key === key);
  if (!definition) throw new Error(`Unknown agent permission: ${key}`);
  return definition;
}

export const agentPermissionDecisionLabels: Record<AgentPermissionDecision, string> = {
  allow: "Allow",
  ask: "Ask first",
  deny: "Block",
};

/** The decision each control offers: a toggle cannot ask. */
export function agentPermissionDecisionsFor(definition: Pick<AgentPermissionDefinition, "control">): readonly AgentPermissionDecision[] {
  return definition.control === "toggle" ? ["allow", "deny"] : AGENT_PERMISSION_DECISIONS;
}

/** With nothing set, every permission allows: the member's own settings apply. */
export const AGENT_PERMISSION_DEFAULT_DECISION: AgentPermissionDecision = "allow";

export const AGENT_PERMISSION_LIST_MAX = 100;
const PATTERN_MAX_LENGTH: Record<AgentPermissionPatternKind, number> = { command: 300, website: 300, name: 128 };

export const agentPermissionPatternPlaceholders: Record<AgentPermissionPatternKind, string> = {
  command: "npm test *",
  website: "docs.example.com",
  name: "team-*",
};

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

type WebsitePattern =
  | { kind: "any" }
  | { kind: "site"; scheme: "http" | "https" | null; host: string; subdomains: boolean; port: string | null; path: string };

const NAME_PATTERN = /^[A-Za-z0-9*?._-]+$/;

/** The pattern's scheme, null when it names none, or undefined when it is not a website's. */
function websiteScheme(value: string | undefined): "http" | "https" | null | undefined {
  if (value === undefined) return null;
  const scheme = value.toLowerCase();
  return scheme === "http" || scheme === "https" ? scheme : undefined;
}

/** `example.com.` is the same site as `example.com`. */
function withoutTrailingDot(host: string): string {
  return host.endsWith(".") ? host.slice(0, -1) : host;
}

function parseWebsitePattern(input: string): WebsitePattern | null {
  const value = input.trim();
  if (value === "*") return { kind: "any" };
  if (!value || /[\s?#@\\]/.test(value)) return null;
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  const scheme = websiteScheme(schemeMatch?.[1]);
  if (scheme === undefined) return null;
  const rest = schemeMatch ? value.slice(schemeMatch[0].length) : value;
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  // A trailing `/*` or `/` adds nothing: paths match as prefixes.
  let path = slash === -1 ? "" : rest.slice(slash);
  if (path.endsWith("/*")) path = path.slice(0, -2);
  while (path.endsWith("/")) path = path.slice(0, -1);
  if (path.includes("*")) return null;
  const subdomains = authority.startsWith("*.");
  const hostAndPort = subdomains ? authority.slice(2) : authority;
  if (!hostAndPort || hostAndPort.includes("*")) return null;
  let parsed: URL;
  try {
    parsed = new URL(`http://${hostAndPort}`);
  } catch {
    return null;
  }
  if (parsed.pathname !== "/" || parsed.username || parsed.password) return null;
  // `:08080` is port 8080, as an address would write it.
  const portNumber = /:(\d{1,5})$/.exec(hostAndPort)?.[1];
  const explicitPort = portNumber === undefined ? null : String(Number(portNumber));
  if (explicitPort !== null && Number(explicitPort) > 65535) return null;
  const defaultPort = scheme === "https" ? "443" : scheme === "http" ? "80" : null;
  return {
    kind: "site",
    scheme,
    host: withoutTrailingDot(parsed.hostname),
    subdomains,
    port: explicitPort === defaultPort ? null : explicitPort,
    path,
  };
}

function formatWebsitePattern(pattern: WebsitePattern): string {
  if (pattern.kind === "any") return "*";
  return `${pattern.scheme ? `${pattern.scheme}://` : ""}${pattern.subdomains ? "*." : ""}${pattern.host}${pattern.port ? `:${pattern.port}` : ""}${pattern.path}`;
}

/** The pattern in its stored form, or null when it is not a valid pattern of that kind. */
export function normalizeAgentPermissionPattern(kind: AgentPermissionPatternKind, input: string): string | null {
  const value = input.trim();
  if (!value || value.length > PATTERN_MAX_LENGTH[kind] || /[\r\n]/.test(value)) return null;
  if (kind === "website") {
    const website = parseWebsitePattern(value);
    return website ? formatWebsitePattern(website) : null;
  }
  if (kind === "name") return NAME_PATTERN.test(value) ? value : null;
  return value;
}

export const agentPermissionPatternErrors: Record<AgentPermissionPatternKind, string> = {
  command: "Enter a command, using * for any text.",
  website: "Enter a site like docs.example.com, *.example.com or example.com/docs.",
  name: "Use letters, numbers, dots, dashes, underscores and *.",
};

/**
 * OpenCode's Wildcard.match: `*` matches any text and `?` one character,
 * case-sensitively, with `\` read as `/`; a pattern ending in ` *` also
 * matches the command alone (`git *` matches `git`). Implemented without a
 * regular expression so a long command cannot backtrack catastrophically.
 */
export function wildcardMatch(value: string, pattern: string): boolean {
  const text = value.replaceAll("\\", "/");
  const glob = pattern.replaceAll("\\", "/");
  if (glob.endsWith(" *") && globMatches(glob.slice(0, -2), text)) return true;
  return globMatches(glob, text);
}

function globMatches(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let star = -1;
  let retry = 0;
  while (valueIndex < value.length) {
    const token = pattern[patternIndex];
    if (token === "?" || (token !== undefined && token !== "*" && token === value[valueIndex])) {
      patternIndex++;
      valueIndex++;
    } else if (token === "*") {
      star = patternIndex++;
      retry = valueIndex;
    } else if (star >= 0) {
      patternIndex = star + 1;
      valueIndex = ++retry;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
}

/**
 * Whether a website pattern covers a URL: the host (and its subdomains for
 * `*.host`), the port and scheme when the pattern names them, and the path
 * as a prefix. Only http and https URLs are websites; `*` covers every URL.
 */
export function websitePatternMatches(url: string, pattern: string): boolean {
  const website = parseWebsitePattern(pattern);
  if (!website) return false;
  if (website.kind === "any") return true;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  if (website.scheme && target.protocol !== `${website.scheme}:`) return false;
  const host = withoutTrailingDot(target.hostname.toLowerCase());
  if (website.subdomains ? !host.endsWith(`.${website.host}`) : host !== website.host) return false;
  if (website.port && (target.port || (target.protocol === "https:" ? "443" : "80")) !== website.port) return false;
  return !website.path || target.pathname === website.path || target.pathname.startsWith(`${website.path}/`);
}

/**
 * OpenCode resources for a website pattern, for engines that match URLs with
 * plain wildcards. `allow` resources cover at least every URL the pattern
 * does and `deny` resources at most, so the engine never blocks a URL the
 * pattern allows; OpenWork's policies plugin then decides with the exact
 * pattern.
 */
export function websitePatternEngineResources(pattern: string, effect: AgentPermissionDecision): string[] {
  const website = parseWebsitePattern(pattern);
  if (!website) return [];
  if (website.kind === "any") return ["*"];
  const host = `${website.subdomains ? "*." : ""}${website.host}`;
  // A pattern without a port matches every port: its allow resources cover
  // addresses that name one, while its deny resources leave them to the plugin.
  const ports = website.port ? [`:${website.port}`] : effect === "deny" ? [""] : ["", ":*"];
  return (website.scheme ? [website.scheme] : ["https", "http"]).flatMap((scheme) => ports.flatMap((port) => {
    const site = `${scheme}://${host}${port}${website.path}`;
    return effect === "deny" ? [site, `${site}/*`] : [`${site}*`];
  }));
}

// ---------------------------------------------------------------------------
// Settings: what an admin saves for everyone or for one team
// ---------------------------------------------------------------------------

export const agentPermissionSettingSchema = z
  .object({
    decision: z.enum(AGENT_PERMISSION_DECISIONS).optional(),
    allow: z.array(z.string().max(500)).max(AGENT_PERMISSION_LIST_MAX).optional(),
    block: z.array(z.string().max(500)).max(AGENT_PERMISSION_LIST_MAX).optional(),
  })
  .strict()
  .meta({ ref: "AgentPermissionSetting" });

export type AgentPermissionSetting = {
  decision?: AgentPermissionDecision;
  allow?: string[];
  block?: string[];
};

const settingsShape = Object.fromEntries(
  agentPermissionKeys.map((key) => [key, agentPermissionSettingSchema.optional()]),
) as { [key in AgentPermissionKey]: z.ZodOptional<typeof agentPermissionSettingSchema> };

/** One policy's settings: a permission left out inherits (for a team) or allows (for everyone). */
export const agentPermissionSettingsSchema = z
  .object(settingsShape)
  .strict()
  .superRefine((settings, context) => {
    for (const definition of agentPermissionDefinitions) {
      const setting = settings[definition.key];
      if (!setting) continue;
      if (setting.decision && !agentPermissionDecisionsFor(definition).includes(setting.decision)) {
        context.addIssue({ code: "custom", path: [definition.key, "decision"], message: `${definition.label} is either allowed or blocked.` });
      }
      for (const list of ["allow", "block"] as const) {
        const patterns = setting[list] ?? [];
        if (patterns.length > 0 && definition.patterns === null) {
          context.addIssue({ code: "custom", path: [definition.key, list], message: `${definition.label} has no ${list === "allow" ? "allowed" : "blocked"} list.` });
          continue;
        }
        patterns.forEach((pattern, index) => {
          if (definition.patterns && normalizeAgentPermissionPattern(definition.patterns, pattern) === null) {
            context.addIssue({ code: "custom", path: [definition.key, list, index], message: agentPermissionPatternErrors[definition.patterns] });
          }
        });
      }
    }
  })
  .meta({ ref: "AgentPermissionSettings" });

export type AgentPermissionSettings = Partial<Record<AgentPermissionKey, AgentPermissionSetting>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentPermissionDecision(value: unknown): value is AgentPermissionDecision {
  return AGENT_PERMISSION_DECISIONS.some((decision) => decision === value);
}

function normalizePatternList(kind: AgentPermissionPatternKind | null, value: unknown): string[] {
  if (kind === null || !Array.isArray(value)) return [];
  const patterns = value.flatMap((entry) => {
    const pattern = typeof entry === "string" ? normalizeAgentPermissionPattern(kind, entry) : null;
    return pattern === null ? [] : [pattern];
  });
  return [...new Set(patterns)].slice(0, AGENT_PERMISSION_LIST_MAX);
}

/** One permission's setting in stored form, or null when it sets nothing. */
export function normalizeAgentPermissionSetting(definition: AgentPermissionDefinition, value: unknown): AgentPermissionSetting | null {
  if (!isRecord(value)) return null;
  const decision = isAgentPermissionDecision(value.decision) && agentPermissionDecisionsFor(definition).includes(value.decision)
    ? value.decision
    : undefined;
  const allow = normalizePatternList(definition.patterns, value.allow);
  const block = normalizePatternList(definition.patterns, value.block);
  if (!decision && allow.length === 0 && block.length === 0) return null;
  return {
    ...(decision ? { decision } : {}),
    ...(allow.length > 0 ? { allow } : {}),
    ...(block.length > 0 ? { block } : {}),
  };
}

/** Settings in stored form: valid patterns only, trimmed and deduplicated, and nothing empty. */
export function normalizeAgentPermissionSettings(value: unknown): AgentPermissionSettings {
  const raw = isRecord(value) ? value : {};
  const settings: AgentPermissionSettings = {};
  for (const definition of agentPermissionDefinitions) {
    const setting = normalizeAgentPermissionSetting(definition, raw[definition.key]);
    if (setting) settings[definition.key] = setting;
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Rules: what a member's apps receive and enforce
// ---------------------------------------------------------------------------

/** One delivered rule, checked strictly where it is enforced (Den sends them in `DenDesktopConfig.agentPermissions`). */
export const agentPermissionRuleSchema = z.object({
  action: z.enum(AGENT_PERMISSION_ACTIONS),
  resource: z.string().min(1).max(500),
  effect: z.enum(AGENT_PERMISSION_DECISIONS),
  /** Who set it: "Everyone" or a team's name. */
  source: z.string().min(1).max(255),
});

export type AgentPermissionRule = z.infer<typeof agentPermissionRuleSchema>;

export const AGENT_PERMISSION_EVERYONE = "Everyone";

export type AgentPermissionPolicySettings = {
  /** "Everyone" or the team's name, shown wherever a rule decides. */
  source: string;
  settings: AgentPermissionSettings;
};

const STRICTNESS: Record<AgentPermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

export function stricterAgentPermissionDecision(left: AgentPermissionDecision, right: AgentPermissionDecision): AgentPermissionDecision {
  return STRICTNESS[right] > STRICTNESS[left] ? right : left;
}

export type ResolvedAgentPermission = {
  definition: AgentPermissionDefinition;
  decision: AgentPermissionDecision;
  /** Who set the decision, or null when nobody did and the permission allows. */
  decisionSource: string | null;
  allow: { pattern: string; source: string }[];
  block: { pattern: string; source: string }[];
};

/**
 * A member's effective permissions. A team's decision replaces everyone's;
 * when several of a member's teams set one, the strictest applies. Lists add
 * up: everyone's patterns, then each team's.
 */
export function resolveAgentPermissions(input: {
  everyone: AgentPermissionPolicySettings | null;
  teams: readonly AgentPermissionPolicySettings[];
}): ResolvedAgentPermission[] {
  const policies = [...(input.everyone ? [input.everyone] : []), ...input.teams];
  return agentPermissionDefinitions.map((definition) => {
    let decision: AgentPermissionDecision | null = null;
    let decisionSource: string | null = null;
    for (const team of input.teams) {
      const teamDecision = team.settings[definition.key]?.decision;
      if (!teamDecision) continue;
      if (decision === null || stricterAgentPermissionDecision(decision, teamDecision) !== decision) {
        decision = teamDecision;
        decisionSource = team.source;
      }
    }
    if (decision === null && input.everyone?.settings[definition.key]?.decision) {
      decision = input.everyone.settings[definition.key]?.decision ?? null;
      decisionSource = input.everyone.source;
    }
    const collect = (list: "allow" | "block") => {
      const seen = new Set<string>();
      return policies.flatMap((policy) => (policy.settings[definition.key]?.[list] ?? []).flatMap((pattern) => {
        if (seen.has(pattern)) return [];
        seen.add(pattern);
        return [{ pattern, source: policy.source }];
      }));
    };
    return {
      definition,
      decision: decision ?? AGENT_PERMISSION_DEFAULT_DECISION,
      decisionSource,
      allow: collect("allow"),
      block: collect("block"),
    };
  });
}

/**
 * OpenCode permission rules for resolved permissions, in order. A decision
 * other than Allow becomes a `*` rule, its allowed patterns follow as
 * exceptions, and blocked patterns come last so they always win. A
 * permission that allows adds no rules: the member's own settings apply.
 */
export function agentPermissionRules(resolved: readonly ResolvedAgentPermission[]): AgentPermissionRule[] {
  return resolved.flatMap(({ definition, decision, decisionSource, allow, block }) => {
    const action = definition.action;
    const restricted = decision !== "allow" && decisionSource !== null;
    return [
      ...(restricted ? [{ action, resource: "*", effect: decision, source: decisionSource }] : []),
      ...(restricted ? allow.map(({ pattern, source }) => ({ action, resource: pattern, effect: "allow" as const, source })) : []),
      ...block.map(({ pattern, source }) => ({ action, resource: pattern, effect: "deny" as const, source })),
    ];
  });
}

export function resolveAgentPermissionRules(input: {
  everyone: AgentPermissionPolicySettings | null;
  teams: readonly AgentPermissionPolicySettings[];
}): AgentPermissionRule[] {
  return agentPermissionRules(resolveAgentPermissions(input));
}

function ruleMatches(rule: AgentPermissionRule, resource: string): boolean {
  return rule.action === "webfetch" ? websitePatternMatches(resource, rule.resource) : wildcardMatch(resource, rule.resource);
}

/** The last rule for this action that matches the resource, as OpenCode evaluates permission rules. */
export function matchingAgentPermissionRule(
  rules: readonly AgentPermissionRule[] | undefined,
  action: AgentPermissionAction,
  resource: string,
): AgentPermissionRule | null {
  for (let index = (rules?.length ?? 0) - 1; index >= 0; index--) {
    const rule = rules?.[index];
    if (rule && rule.action === action && ruleMatches(rule, resource)) return rule;
  }
  return null;
}

export type AgentPermissionDecisionResult = {
  effect: AgentPermissionDecision;
  /** The rule that decided, or null when no rule matched and the action is allowed. */
  rule: AgentPermissionRule | null;
  resource: string;
};

/** The organization's decision for an action on several resources: the strictest of them. */
export function decideAgentPermission(
  rules: readonly AgentPermissionRule[] | undefined,
  action: AgentPermissionAction,
  resources: readonly string[],
): AgentPermissionDecisionResult {
  let result: AgentPermissionDecisionResult | null = null;
  for (const resource of resources.length > 0 ? resources : ["*"]) {
    const rule = matchingAgentPermissionRule(rules, action, resource);
    const effect = rule?.effect ?? "allow";
    if (!result || STRICTNESS[effect] > STRICTNESS[result.effect] || (effect === result.effect && !result.rule && rule)) {
      result = { effect, rule, resource };
    }
  }
  return result ?? { effect: "allow", rule: null, resource: "*" };
}

const BLOCKED_SUBJECT: Record<AgentPermissionAction, (resource: string) => string> = {
  shell: (resource) => resource === "*" ? "running commands" : `the command \`${resource}\``,
  edit: () => "editing files",
  webfetch: (resource) => resource === "*" ? "opening websites" : `opening ${resource}`,
  websearch: () => "searching the web",
  skill: (resource) => resource === "*" ? "local skills" : `the local skill "${resource}"`,
  mcp: (resource) => resource === "*" ? "local MCP servers" : `the local MCP server "${resource}"`,
};

/** The sentence a member or an agent sees when a rule blocks something: what, which rule, and who set it. */
export function agentPermissionDenialMessage(rule: AgentPermissionRule, resource: string): string {
  const by = rule.resource === "*" ? `set for ${rule.source}` : `"${rule.resource}" is blocked for ${rule.source}`;
  return `Your organization's agent permissions block ${BLOCKED_SUBJECT[rule.action](resource)} (${by}).`;
}
