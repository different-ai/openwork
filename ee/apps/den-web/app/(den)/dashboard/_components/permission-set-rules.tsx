"use client";

import { useId, useState } from "react";
import { ArrowDown, ArrowUp, LockKeyhole, Plus, X } from "lucide-react";
import { matchingPolicyRule } from "@openwork/types/den/policy-rules";
import { POLICY_RULE_RESOURCE_MAX_LENGTH, POLICY_RULES_MAX } from "@openwork/types/den/desktop-policies";
import { DenButton } from "../../_components/ui/button";
import { DenNotice } from "../../_components/ui/notice";
import { DenSegmented } from "../../_components/ui/segmented";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { useDenToast } from "./den-toast";
import {
  PERMISSION_RULE_ACTIONS,
  usePermissionSetRules,
  useUpdatePermissionSetRules,
  type PermissionRule,
  type PermissionRuleAction,
  type PermissionRuleListChange,
  type PermissionSetDetail,
} from "./permissions-data";
import { PermissionAreaSection, PermissionRowsSkeleton } from "./permissions-ui";

type RuleGroup = { action: PermissionRuleAction; title: string; noun: [string, string]; placeholder: string; tryLabel: string; tryPlaceholder: string };

// One group per OpenCode permission action.
const RULE_GROUPS: readonly RuleGroup[] = [
  { action: "shell", title: "Run computer commands", noun: ["command", "commands"], placeholder: "git *", tryLabel: "Try a command", tryPlaceholder: "git push origin main" },
  { action: "webfetch", title: "Browse websites", noun: ["website", "websites"], placeholder: "https://*.example.com/*", tryLabel: "Try a website", tryPlaceholder: "https://portal.example.com/reports" },
  { action: "skill", title: "Use local skills", noun: ["local skill", "local skills"], placeholder: "*", tryLabel: "Try a skill", tryPlaceholder: "meeting-notes" },
  { action: "mcp", title: "Use local MCP servers", noun: ["local MCP server", "local MCP servers"], placeholder: "*", tryLabel: "Try a server", tryPlaceholder: "issue-tracker" },
];

const EFFECTS = [{ value: "allow", label: "Allow" }, { value: "deny", label: "Block" }] as const;

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

function listFor(rules: readonly PermissionRule[], action: PermissionRuleAction) {
  return rules.filter((rule) => rule.action === action && rule.resource.trim())
    .map((rule) => ({ resource: rule.resource.trim(), effect: rule.effect }));
}

/** What one action's rules do, as state (DESIGN.md P1). */
function ruleSummary(rules: readonly PermissionRule[]): string {
  const kept = rules.filter((rule) => rule.resource.trim());
  if (kept.length === 0) return "Everything allowed";
  const catchAll = kept.map((rule) => rule.resource.trim()).lastIndexOf("*");
  const after = kept.slice(catchAll + 1);
  if (catchAll >= 0 && kept[catchAll]?.effect === "deny") {
    const allowed = after.filter((rule) => rule.effect === "allow").length;
    return allowed ? `Only ${plural(allowed, "pattern")} allowed` : "Everything blocked";
  }
  const blocked = after.filter((rule) => rule.effect === "deny").length;
  return blocked ? `${plural(blocked, "pattern")} blocked` : "Everything allowed";
}

export function PermissionSetRules({ orgId, set, readOnlyReason }: { orgId: string; set: PermissionSetDetail; readOnlyReason: string | null }) {
  const query = usePermissionSetRules(orgId, set.id, true);
  // Lives above the editor, which remounts after each save, so Undo and errors survive it.
  const update = useUpdatePermissionSetRules(orgId, set.id);
  if (query.isError) {
    return (
      <div className="flex flex-col items-start gap-2">
        <DenNotice tone="error" className="w-full" message={query.error instanceof Error ? query.error.message : "Couldn't load these rules."} />
        <DenButton variant="secondary" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>Try again</DenButton>
      </div>
    );
  }
  if (!query.data) return <PermissionRowsSkeleton rows={4} label="Loading rules" />;
  // Remount when the saved rules change so the draft starts from them.
  return <PermissionSetRulesEditor key={JSON.stringify(query.data)} saved={query.data} update={update} readOnlyReason={readOnlyReason} />;
}

function PermissionSetRulesEditor({ saved, update, readOnlyReason }: {
  saved: PermissionRule[];
  update: ReturnType<typeof useUpdatePermissionSetRules>;
  readOnlyReason: string | null;
}) {
  const [draft, setDraft] = useState<PermissionRule[]>(saved);
  const toast = useDenToast();
  const changed: PermissionRuleListChange[] = PERMISSION_RULE_ACTIONS.flatMap((action) => {
    const next = listFor(draft, action);
    return JSON.stringify(next) === JSON.stringify(listFor(saved, action)) ? [] : [{ action, rules: next }];
  });
  const tooMany = draft.filter((rule) => rule.resource.trim()).length > POLICY_RULES_MAX;

  function change(action: PermissionRuleAction, rules: PermissionRule[]) {
    update.reset();
    setDraft([...draft.filter((rule) => rule.action !== action), ...rules]);
  }

  async function save(toSave: PermissionRuleListChange[], undo: PermissionRuleListChange[] | null) {
    await update.mutateAsync(toSave);
    const count = plural(toSave.length, "rule list");
    toast({
      title: undo ? `Saved ${count}` : `Undid ${count}`,
      action: undo
        ? {
            label: "Undo",
            onClick: async () => {
              try {
                await save(undo, null);
              } catch {
                return;
              }
            },
          }
        : undefined,
    });
  }

  return (
    <div className="flex flex-col gap-6" data-testid="permission-rules">
      {readOnlyReason ? <DenNotice tone="neutral" icon={LockKeyhole} message={<span id="permission-rules-read-only">{readOnlyReason}</span>} /> : null}
      {RULE_GROUPS.map((group) => (
        <RuleGroupEditor
          key={group.action}
          group={group}
          rules={draft.filter((rule) => rule.action === group.action)}
          unsaved={changed.some((entry) => entry.action === group.action)}
          readOnly={readOnlyReason !== null}
          onChange={(rules) => change(group.action, rules)}
        />
      ))}
      <details className="text-[12px] leading-5 text-gray-500">
        <summary className="cursor-pointer text-gray-600">How rules work</summary>
        <p className="mt-1">These are OpenCode permission rules. Each list is checked from top to bottom and the last rule that matches decides; anything no rule matches is allowed. Use * for any text and ? for one character. Member permissions come first, then Admin permissions for admins, then each team&apos;s.</p>
      </details>
      {update.error ? <DenNotice tone="error" message={update.error.message} /> : null}
      {tooMany ? <DenNotice tone="error" message={`Use up to ${POLICY_RULES_MAX} rules in each list.`} /> : null}
      {changed.length > 0 ? (
        <DenStickyActionBar testId="permission-rules-save-bar" summary={<span>{plural(changed.length, "unsaved change")}</span>}>
          <DenButton variant="secondary" disabled={update.isPending} onClick={() => { update.reset(); setDraft(saved); }}>Discard</DenButton>
          <DenButton
            loading={update.isPending}
            disabled={tooMany}
            onClick={() => void save(changed, changed.map(({ action }) => ({ action, rules: listFor(saved, action) }))).catch(() => undefined)}
          >
            Save changes
          </DenButton>
        </DenStickyActionBar>
      ) : null}
    </div>
  );
}

function RuleGroupEditor({ group, rules, unsaved, readOnly, onChange }: {
  group: RuleGroup;
  rules: PermissionRule[];
  unsaved: boolean;
  readOnly: boolean;
  onChange: (rules: PermissionRule[]) => void;
}) {
  const id = useId();
  const [trial, setTrial] = useState("");
  const kept = rules.filter((rule) => rule.resource.trim());
  const decision = trial.trim() ? matchingPolicyRule(kept, group.action, trial.trim()) : undefined;
  const update = (index: number, next: Partial<PermissionRule>) => onChange(rules.map((rule, position) => position === index ? { ...rule, ...next } : rule));
  const move = (index: number, offset: number) => {
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    if (rule) next.splice(index + offset, 0, rule);
    onChange(next);
  };
  const add = (effect: PermissionRule["effect"]) => onChange([...rules, { action: group.action, resource: "", effect }]);
  return (
    <PermissionAreaSection label={group.title} meta={unsaved ? `${ruleSummary(rules)} · Not saved` : ruleSummary(rules)} testId={`permission-rules-${group.action}`}>
      {rules.map((rule, index) => (
        <div key={index} className="flex min-h-11 flex-wrap items-center gap-2 py-1.5" data-testid="permission-rule-row" data-effect={rule.effect}>
          <span aria-hidden="true" className="w-5 text-right font-mono text-[12px] text-gray-400">{index + 1}</span>
          <input
            aria-label={`${group.title}: pattern ${index + 1}`}
            data-testid={`permission-rule-${group.action}-${index}`}
            value={rule.resource}
            placeholder={group.placeholder}
            maxLength={POLICY_RULE_RESOURCE_MAX_LENGTH}
            spellCheck={false}
            disabled={readOnly}
            aria-describedby={readOnly ? "permission-rules-read-only" : undefined}
            onChange={(event) => update(index, { resource: event.target.value })}
            className="min-w-0 flex-1 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 font-mono text-[13px] text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gray-400 disabled:bg-gray-50 disabled:text-gray-500"
          />
          <DenSegmented aria-label={`${group.title}: effect of rule ${index + 1}`} options={EFFECTS.map((effect) => ({ ...effect, disabled: readOnly }))} value={rule.effect} onChange={(effect) => update(index, { effect })} />
          {readOnly ? null : (
            <span className="flex items-center">
              <DenButton variant="ghost" size="xs" aria-label={`Move rule ${index + 1} up`} disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp aria-hidden="true" className="size-3.5" /></DenButton>
              <DenButton variant="ghost" size="xs" aria-label={`Move rule ${index + 1} down`} disabled={index === rules.length - 1} onClick={() => move(index, 1)}><ArrowDown aria-hidden="true" className="size-3.5" /></DenButton>
              <DenButton variant="ghost" size="xs" aria-label={`Remove rule ${index + 1}`} onClick={() => onChange(rules.filter((_, position) => position !== index))}><X aria-hidden="true" className="size-3.5" /></DenButton>
            </span>
          )}
        </div>
      ))}
      {rules.length === 0 ? <div className="flex min-h-11 items-center py-1.5 text-[13px] text-gray-500">No rules. Every {group.noun[0]} is allowed.</div> : null}
      <div className="flex min-h-11 flex-wrap items-center gap-2 py-1.5">
        {readOnly ? null : (
          <>
            <DenButton variant="secondary" size="sm" icon={Plus} data-testid={`permission-rule-block-${group.action}`} onClick={() => add("deny")}>Block a pattern</DenButton>
            <DenButton variant="secondary" size="sm" icon={Plus} data-testid={`permission-rule-allow-${group.action}`} onClick={() => add("allow")}>Allow a pattern</DenButton>
          </>
        )}
        <span className="flex-1" />
        <label htmlFor={`${id}-try`} className="text-[12px] text-gray-500">{group.tryLabel}</label>
        <input
          id={`${id}-try`}
          data-testid={`permission-rule-try-${group.action}`}
          value={trial}
          placeholder={group.tryPlaceholder}
          spellCheck={false}
          onChange={(event) => setTrial(event.target.value)}
          className="w-56 min-w-0 rounded-md border border-gray-200 bg-white px-2.5 py-1.5 font-mono text-[13px] text-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gray-400"
        />
        {trial.trim() ? (
          <output htmlFor={`${id}-try`} aria-live="polite" data-testid={`permission-rule-result-${group.action}`} className="text-[12px] text-gray-700">
            {decision?.effect === "deny" ? <>Blocked by rule {rules.indexOf(decision) + 1} · <code className="font-mono">{decision.resource}</code></> : "Allowed"}
          </output>
        ) : null}
      </div>
    </PermissionAreaSection>
  );
}
