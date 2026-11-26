import { TOOL_PERMISSION_EVERY_TOOL, type SetToolPermissionRule, type ToolPermissionAccess, type ToolPermissionRule, type ToolPermissionSubject } from "@openwork/types/den/tool-permissions";

type Annotations = { readOnlyHint?: boolean; destructiveHint?: boolean };
export type PermissionRule = Pick<ToolPermissionRule, "connectionId" | "toolName" | "rule"> & {
  subject: Pick<ToolPermissionRule["subject"], "kind" | "id">;
};

export const accessLabels = { allow: "Allow", ask: "Ask", block: "Block" } satisfies Record<ToolPermissionAccess, string>;
export const accessChoices: readonly ToolPermissionAccess[] = ["allow", "ask", "block"];

export function toolReads(annotations?: Annotations): boolean {
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
}

export function toolActivityLabel(annotations?: Annotations): string {
  return toolReads(annotations) ? "reads" : "changes things";
}

export function defaultToolAccess(annotations?: Annotations): ToolPermissionAccess {
  return toolReads(annotations) ? "allow" : "ask";
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

export function accessForTool(toolName: string, fallback: ToolPermissionAccess | null, layers: readonly ReadonlyMap<string, ToolPermissionAccess>[]) {
  const applicable = layers.map((rules) => rules.get(TOOL_PERMISSION_EVERY_TOOL) === "block" ? "block" : rules.get(toolName));
  const rule = applicable.includes("block") ? "block" : applicable.includes("ask") ? "ask" : applicable.includes("allow") ? "allow" : null;
  return { rule, access: rule ?? fallback };
}

export function everyoneLabel(result: ReturnType<typeof accessForTool>): string {
  return result.access ? `Everyone: ${accessLabels[result.access]}${result.rule ? "" : " (default)"}` : "Everyone: No rule";
}
