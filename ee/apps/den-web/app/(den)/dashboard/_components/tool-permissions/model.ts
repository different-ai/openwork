import { TOOL_PERMISSION_EVERY_TOOL, type SetToolPermissionRule, type ToolPermissionAccess, type ToolPermissionRule, type ToolPermissionSubject } from "@openwork/types/den/tool-permissions";

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean };
export type PermissionRule = Pick<ToolPermissionRule, "connectionId" | "toolName" | "rule"> & {
  subject: Pick<ToolPermissionRule["subject"], "kind" | "id">;
};

export const accessLabels = { allow: "Allow", ask: "Ask", block: "Block" } satisfies Record<ToolPermissionAccess, string>;
export const accessChoices = ["default", "allow", "ask", "block"] as const;

type AccessMap = ReadonlyMap<string, ToolPermissionAccess>;

export function toolReads(annotations?: Annotations): boolean {
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
}

export function toolActivityLabel(annotations?: Annotations): string {
  return toolReads(annotations) ? "reads" : "changes things";
}

function isSubject(rule: PermissionRule, subject: ToolPermissionSubject) {
  return rule.subject.kind === subject.kind && (subject.kind === "organization" || rule.subject.id === subject.id);
}

export function withPendingRule(rules: readonly PermissionRule[], edit?: SetToolPermissionRule): readonly PermissionRule[] {
  if (!edit) return rules;
  const next = rules.filter((rule) => rule.connectionId !== edit.connectionId || rule.toolName !== edit.toolName || !isSubject(rule, edit.subject));
  if (edit.rule !== null) next.push({ ...edit, rule: edit.rule, subject: { kind: edit.subject.kind, id: edit.subject.kind === "organization" ? null : edit.subject.id } });
  return next;
}

export function rulesForSubject(rules: readonly PermissionRule[], connectionId: string, subject: ToolPermissionSubject) {
  return new Map(rules.filter((rule) => rule.connectionId === connectionId && isSubject(rule, subject)).map(({ toolName, rule }) => [toolName, rule]));
}

const accessPrecedence = ["block", "ask", "allow"] as const;

function ruleForTool(toolName: string, rules: AccessMap) {
  return rules.get(TOOL_PERMISSION_EVERY_TOOL) === "block" ? "block" : rules.get(toolName);
}

export function accessForTool(toolName: string, layers: readonly AccessMap[]) {
  const applicable = layers.map((rules) => ruleForTool(toolName, rules));
  const rule = accessPrecedence.find((access) => applicable.includes(access)) ?? null;
  return { rule, access: rule ?? "allow" };
}

function toolAccessNotice(ownRule: ToolPermissionAccess | undefined, inheritedRule: ToolPermissionAccess | null, source: string) {
  if (ownRule) {
    if (inheritedRule && accessPrecedence.indexOf(inheritedRule) < accessPrecedence.indexOf(ownRule)) {
      return `Applies now: ${accessLabels[inheritedRule]}, from ${source}.`;
    }
    return "This rule applies.";
  }
  if (inheritedRule) return `From ${source}: ${accessLabels[inheritedRule]}.`;
  return "Allowed (no rule).";
}

export function toolRowAccess({ toolName, ownRules, orgRules, memberTeams, everyoneSelected }: {
  toolName: string;
  ownRules: AccessMap;
  orgRules: AccessMap;
  memberTeams: readonly { name: string; rules: AccessMap }[];
  everyoneSelected: boolean;
}) {
  const ownRule = ownRules.get(toolName);
  const inheritedLayers = everyoneSelected ? [] : [{ name: "Everyone", rules: orgRules }, ...memberTeams.map(({ name, rules }) => ({ name: `the team ${name}`, rules }))];
  const inherited = accessForTool(toolName, inheritedLayers.map(({ rules }) => rules));
  const source = inheritedLayers.find(({ rules }) => ruleForTool(toolName, rules) === inherited.rule)?.name ?? "Everyone";
  const ownConnectionBlocks = ownRules.get(TOOL_PERMISSION_EVERY_TOOL) === "block" && inherited.rule !== "block";
  const notice = ownConnectionBlocks
    ? toolAccessNotice(ownRule, "block", "the connection rule")
    : toolAccessNotice(ownRule, inherited.rule, source);

  return {
    pressed: ownRule ?? "default",
    defaultLabel: inherited.rule ? `Default (${accessLabels[inherited.rule]})` : "Allowed (no rule)",
    notice: everyoneSelected ? null : notice,
    lockedByEveryone: !everyoneSelected && orgRules.get(toolName) === "block",
  };
}
