import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { ToolApproval, ToolApprovalDecision, ToolApprovalList } from "@openwork/types/den/tool-permissions";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ToolApprovalCard } from "@/react-app/design-system/tool-approval-card";

import { approvalRestartOptions, approvalRows, approvalRunGroup, automationApprovalResultWords, automationApprovalTarget, approvalsForPlacement, approvalWords, recordRunApproval, type AutomationApprovalResult, type RunApprovalPlacement } from "./tool-approval-words";
import { approvalsKey, useApprovalDecision, useToolApprovals, type ToolApprovalsScope } from "./tool-approvals-stack";

const EMPTY_APPROVALS: readonly ToolApproval[] = [];

type ClaimRestart = (scope: ToolApprovalsScope, approval: ToolApproval, choice: ToolApprovalDecision) => { start: boolean; waiting: boolean };

export function useAutomationApprovals(scope: ToolApprovalsScope | null) {
  const queryClient = useQueryClient();
  const ledger = useRef(new Map<string, { allowed: boolean; claimed: boolean; decisions: Set<string> }>());
  const query = useToolApprovals(scope);
  const items = query.data?.items ?? EMPTY_APPROVALS;
  const pending = items.flatMap((item) => {
    const target = automationApprovalTarget(item);
    return target ? [target] : [];
  });
  const claimRestart: ClaimRestart = (scope, approval, choice) => {
    const queryKey = approvalsKey(scope);
    const group = approvalRunGroup(approval);
    const key = JSON.stringify([queryKey, group]);
    const previous = ledger.current.get(key) ?? { allowed: false, claimed: false, decisions: new Set<string>() };
    previous.decisions.add(approval.id);
    const pending = queryClient.getQueryData<ToolApprovalList>(queryKey)?.items ?? EMPTY_APPROVALS;
    const waiting = pending.some((item) => item.context.kind === "automation" && item.status === "pending"
      && approvalRunGroup(item) === group && !previous.decisions.has(item.id));
    const next = recordRunApproval(previous, choice === "allow_once", waiting);
    ledger.current.set(key, { ...next, decisions: previous.decisions });
    return { start: next.start, waiting };
  };
  return { items, pending, claimRestart, isError: query.isError, refetch: query.refetch };
}

type DecidedRow = { approval: ToolApproval; result: AutomationApprovalResult; denied: boolean; takeFocus: boolean };

function RunApproval({ scope, approval, row, onDecided, onOpenRun }: {
  scope: ToolApprovalsScope;
  approval: ToolApproval;
  row?: DecidedRow;
  onDecided: (choice: ToolApprovalDecision, takeFocus: boolean) => Promise<void>;
  onOpenRun: (runId: string) => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  const focusedLine = useRef(false);
  const decision = useApprovalDecision(scope, approval, (choice) => {
    const active = card.current?.ownerDocument.activeElement;
    const takeFocus = Boolean(active && (card.current?.contains(active) || (hadFocus.current && active === active.ownerDocument.body)));
    return onDecided(choice, takeFocus);
  });
  const words = row ? automationApprovalResultWords(row.result, approval.context, row.denied) : null;
  const open = words?.open;

  return <div className="grid min-w-0 grid-cols-1">
    <div ref={card} className="col-start-1 row-start-1 min-w-0">
      <ToolApprovalCard {...approvalWords(approval)} variant={row ? "placeholder" : "inline"}
        data-tool-approval={row ? undefined : approval.toolName}
        decisions={["deny", "allow_once"]} busy={decision.isPending} onDecide={(choice) => {
          if (choice === "always_allow") return;
          hadFocus.current = card.current?.contains(card.current.ownerDocument.activeElement) ?? false;
          decision.mutate(choice);
        }} />
    </div>
    {row && words && <div className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-start gap-x-2 border-t border-dls-border py-3 text-sm text-dls-secondary"
      tabIndex={-1} ref={(node) => {
        if (!node || !row.takeFocus || focusedLine.current) return;
        const active = node.ownerDocument.activeElement;
        if (active !== node.ownerDocument.body && !card.current?.contains(active)) return;
        focusedLine.current = true;
        node.focus({ preventScroll: true });
      }}>
      <span className="wrap-anywhere">{words.line}</span>
      {open && <Button size="xs" variant="link" className="h-auto p-0 text-sm" onClick={() => onOpenRun(open.runId)}>{open.label}</Button>}
    </div>}
  </div>;
}

export function RunApprovalSlot({ scope, items, placement, automationId, claimRestart, onOpenRun }: {
  scope: ToolApprovalsScope;
  items: readonly ToolApproval[];
  placement: RunApprovalPlacement;
  automationId: string;
  claimRestart: ClaimRestart;
  onOpenRun: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const pending = approvalsForPlacement(items, automationId, placement);
  const [decided, setDecided] = useState<DecidedRow[]>([]);
  const [announced, setAnnounced] = useState<DecidedRow | null>(null);
  const rows = approvalRows(pending, decided);

  async function onDecided(approval: ToolApproval, choice: ToolApprovalDecision, takeFocus: boolean) {
    const { start, waiting } = claimRestart(scope, approval, choice);
    const denied = choice === "deny";
    const row: DecidedRow = { approval, denied, takeFocus, result: { kind: denied ? "denied" : waiting ? "waiting" : "allowed" } };
    setDecided((previous) => [...previous.map<DecidedRow>((item) => start && item.result.kind === "waiting" && approvalRunGroup(item.approval) === approvalRunGroup(approval)
      ? { ...item, result: { kind: "allowed" } } : item), row]);
    setAnnounced(row);
    if (!start) return;
    let result: AutomationApprovalResult;
    try {
      const options = await approvalRestartOptions(placement, approval.runId, async (runId) =>
        (await scope.client.getAutomationRun(scope.organizationId, runId)).run.executionTarget);
      const run = await scope.client.runAutomationNow(scope.organizationId, automationId, options);
      void queryClient.invalidateQueries({ queryKey: ["den", "automations", scope.organizationId] });
      result = run.status === "skipped" ? { kind: "skipped" } : { kind: "started", runId: run.id };
    } catch {
      result = { kind: "failed" };
    }
    setDecided((previous) => previous.map((item) => item.approval.id === approval.id ? { ...item, result } : item));
    setAnnounced({ ...row, result });
  }

  return <>
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announced && <span key={`${announced.approval.id}:${announced.result.kind}`}>
        {automationApprovalResultWords(announced.result, announced.approval.context, announced.denied).line}
      </span>}
    </div>
    {rows.length > 0 && <div data-tool-approvals className="space-y-2">
      {!("runId" in placement) && <p className={pending.length ? "text-sm text-muted-foreground" : "invisible text-sm text-muted-foreground"}>
        {t("tool_approvals.automation_earlier_run")}
      </p>}
      {rows.map(({ approval }) => <RunApproval key={approval.id} scope={scope} approval={approval}
        row={decided.find((item) => item.approval.id === approval.id)} onOpenRun={onOpenRun}
        onDecided={(choice, takeFocus) => onDecided(approval, choice, takeFocus)} />)}
    </div>}
  </>;
}
