/**
 * Team rules are OpenCode permission rules: `{ action, resource, effect }`,
 * checked in order, and the last rule whose action and resource match decides.
 * The v2 engine evaluates `shell`, `skill` and `webfetch` rules natively;
 * OpenWork applies `webfetch` rules to its built-in browser and `mcp` rules to
 * local MCP servers, matching the same way.
 *
 *   { action: "shell", resource: "*", effect: "deny" }
 *   { action: "shell", resource: "git *", effect: "allow" }   // only git
 *
 * Rules belong to permission sets. A member's rules are their Member set's,
 * then the Admin set's for admins, then each of their teams' sets', as later
 * OpenCode config documents follow earlier ones.
 *
 * This module has no dependencies so the engine plugin, the desktop browser and
 * Den can evaluate rules exactly alike, without a round trip per check.
 */

export const POLICY_RULE_ACTIONS = ["shell", "webfetch", "skill", "mcp"] as const;
export type PolicyRuleAction = (typeof POLICY_RULE_ACTIONS)[number];
export type PolicyRule = { action: PolicyRuleAction; resource: string; effect: "allow" | "deny" };
/** A rule as delivered to a member, labelled with the policy it comes from. */
export type SourcedPolicyRule = PolicyRule & { source: string };

/**
 * OpenCode's Wildcard.match: `*` matches any text and `?` one character,
 * case-sensitively, with `\` read as `/`; a pattern ending in ` *` also matches
 * the command alone (`git *` matches `git`). Implemented without a regular
 * expression so a long command cannot backtrack catastrophically.
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

/** The last rule for this action whose resource matches, like OpenCode's permission evaluation. */
export function matchingPolicyRule<T extends PolicyRule>(rules: readonly T[] | undefined, action: PolicyRuleAction, resource: string): T | undefined {
  for (let index = (rules?.length ?? 0) - 1; index >= 0; index--) {
    const rule = rules?.[index];
    if (rule && rule.action === action && wildcardMatch(resource, rule.resource)) return rule;
  }
  return undefined;
}

/** The first resource a deny rule decides, with that rule; null when every resource is allowed. */
export function policyRuleDenial<T extends PolicyRule>(rules: readonly T[] | undefined, action: PolicyRuleAction, resources: readonly string[]): { rule: T; resource: string } | null {
  for (const resource of resources) {
    const rule = matchingPolicyRule(rules, action, resource);
    if (rule?.effect === "deny") return { rule, resource };
  }
  return null;
}

const DENIED_SUBJECT: Record<PolicyRuleAction, (resource: string) => string> = {
  shell: (resource) => `The command \`${resource}\``,
  webfetch: (resource) => `The website ${resource}`,
  skill: (resource) => `The local skill "${resource}"`,
  mcp: (resource) => `The local MCP server "${resource}"`,
};

/** The sentence an agent or member sees when a rule blocks something. */
export function policyRuleDenialMessage(denial: { rule: SourcedPolicyRule; resource: string }): string {
  return `${DENIED_SUBJECT[denial.rule.action](denial.resource)} is blocked by your organization's "${denial.rule.source}" (rule: ${denial.rule.resource}).`;
}
