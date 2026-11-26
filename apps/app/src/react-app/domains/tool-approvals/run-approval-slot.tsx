import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ToolApproval } from "@openwork/types/den/tool-permissions";

import { Button } from "@/components/ui/button";
import { ToolApprovalCard } from "@/react-app/design-system/tool-approval-card";

import { automationApprovalResultWords, automationApprovalTarget, approvalsForRun, approvalWords, type AutomationApprovalResult } from "./tool-approval-words";
import { useApprovalDecision, useToolApprovals, type ToolApprovalsScope } from "./tool-approvals-stack";

const EMPTY_APPROVALS: readonly ToolApproval[] = [];

export function useAutomationApprovals(scope: ToolApprovalsScope | null) {
  const query = useToolApprovals(scope);
  const items = query.data?.items ?? EMPTY_APPROVALS;
  const pending = items.flatMap((item) => {
    const target = automationApprovalTarget(item);
    return target ? [target] : [];
  });
  return { items, pending, isError: query.isError, refetch: query.refetch };
}

function RunApproval({ scope, approval, pending, automationId, onOpenRun }: {
  scope: ToolApprovalsScope;
  approval: ToolApproval;
  pending: boolean;
  automationId: string;
  onOpenRun: (runId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<AutomationApprovalResult | null>(null);
  const decision = useApprovalDecision(scope, approval, async (choice) => {
    if (choice === "deny") {
      setResult({ kind: "denied" });
      return;
    }
    try {
      const run = await scope.client.runAutomationNow(scope.organizationId, automationId);
      void queryClient.invalidateQueries({ queryKey: ["den", "automations", scope.organizationId] });
      setResult(run.status === "skipped" ? { kind: "skipped" } : { kind: "started", runId: run.id });
    } catch {
      setResult({ kind: "failed" });
    }
  });
  const words = result ? automationApprovalResultWords(result, approval.context) : null;
  const open = words?.open;
  const visible = !words && (pending || decision.isPending);

  return <div className="grid min-w-0 grid-cols-1">
    <div className="col-start-1 row-start-1 min-w-0">
      <ToolApprovalCard {...approvalWords(approval)} variant={visible ? "inline" : "placeholder"}
        data-tool-approval={visible ? approval.toolName : undefined}
        decisions={["deny", "allow_once"]} busy={decision.isPending} onDecide={(choice) => {
          if (choice !== "always_allow") decision.mutate(choice);
        }} />
    </div>
    {words && <div className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-start gap-x-2 border-t border-dls-border py-3 text-sm text-dls-secondary" role="status">
      <span className="wrap-anywhere">{words.line}</span>
      {open && <Button size="xs" variant="link" className="h-auto p-0 text-sm" onClick={() => onOpenRun(open.runId)}>{open.label}</Button>}
    </div>}
  </div>;
}

export function RunApprovalSlot({ scope, items, runId, automationId, onOpenRun }: {
  scope: ToolApprovalsScope;
  items: readonly ToolApproval[];
  runId: string;
  automationId: string;
  onOpenRun: (runId: string) => void;
}) {
  const pending = approvalsForRun(items, automationId, runId);
  const [shown, setShown] = useState(pending);
  const added = pending.filter((approval) => !shown.some((item) => item.id === approval.id));
  if (added.length) setShown([...shown, ...added]);
  if (!shown.length) return null;
  return <div data-tool-approvals className="space-y-2">
    {shown.map((approval) => <RunApproval key={approval.id} scope={scope} approval={approval} automationId={automationId}
      pending={pending.some((item) => item.id === approval.id)} onOpenRun={onOpenRun} />)}
  </div>;
}
