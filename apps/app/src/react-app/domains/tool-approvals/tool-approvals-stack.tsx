import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ToolApproval, ToolApprovalDecision } from "@openwork/types/den/tool-permissions";
import { toast } from "sonner";

import { DenApiError, type DenClient } from "@/app/lib/den";
import { ToolApprovalCard } from "@/react-app/design-system/tool-approval-card";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

import { approvalsForSurface, approvalWords } from "./tool-approval-words";

export type ToolApprovalsScope = {
  client: DenClient;
  denBaseUrl: string;
  organizationId: string;
  principal: string;
};

export function approvalsKey(scope: ToolApprovalsScope | null) {
  return [scope?.denBaseUrl, "tool-approvals", scope?.organizationId, scope?.principal] as const;
}

export function useToolApprovals(scope: ToolApprovalsScope | null, options: { poll?: boolean; completedAt?: number } = {}) {
  const { poll = true, completedAt } = options;
  return useQuery({
    queryKey: approvalsKey(scope),
    queryFn: scope ? () => scope.client.listToolApprovals(scope.organizationId) : undefined,
    enabled: scope !== null,
    refetchOnMount: poll ? true : (query) => completedAt !== undefined && query.state.dataUpdatedAt < completedAt ? "always" : false,
    refetchInterval: scope && poll ? 10_000 : false,
    refetchIntervalInBackground: false,
  });
}

export function ApprovalRefresh({ scope, completedAt }: { scope: ToolApprovalsScope; completedAt: number }) {
  useToolApprovals(scope, { poll: false, completedAt });
  return null;
}

export function useApprovalDecision(scope: ToolApprovalsScope, approval: ToolApproval, onDecided: (choice: ToolApprovalDecision) => void | Promise<void>) {
  const queryClient = useQueryClient();
  const queryKey = approvalsKey(scope);
  return useMutation({
    mutationFn: (choice: ToolApprovalDecision) => scope.client.decideToolApproval(scope.organizationId, approval.id, { decision: choice }),
    onSuccess: (updated, choice) => {
      queryClient.setQueryData<Awaited<ReturnType<DenClient["listToolApprovals"]>>>(queryKey, (list) => list && ({ items: list.items.filter((item) => item.id !== updated.id) }));
      void queryClient.invalidateQueries({ queryKey });
      return onDecided(choice);
    },
    onError: (error) => {
      if (error instanceof DenApiError && error.status === 409 && error.code === "tool_approval_decided") {
        void queryClient.invalidateQueries({ queryKey });
        return;
      }
      toast.error(t("tool_approvals.decision_failed"));
    },
  });
}

function PendingChatApproval({ scope, approval }: { scope: ToolApprovalsScope; approval: ToolApproval }) {
  const decision = useApprovalDecision(scope, approval, (choice) => {
    if (choice === "allow_once") toast.success(t("tool_approvals.chat_allowed"), { duration: 4_000 });
  });

  return <ToolApprovalCard {...approvalWords(approval)} data-tool-approval={approval.toolName}
    decisions={["deny", "allow_once"]} busy={decision.isPending} onDecide={(choice) => {
      if (choice !== "always_allow") decision.mutate(choice);
    }} />;
}

export function ApprovalLoadError({ onRetry }: { onRetry: () => void }) {
  return <div className="flex items-center gap-2">
    <p role="status" className="text-xs text-dls-secondary">{t("tool_approvals.load_failed")}</p>
    <Button type="button" size="sm" variant="ghost" onClick={onRetry}>{t("tool_approvals.retry")}</Button>
  </div>;
}

export function ToolApprovalsStack({ scope, surface, completedAt }: {
  scope: ToolApprovalsScope | null;
  surface: "chat";
  completedAt?: number;
}) {
  const query = useToolApprovals(scope);
  if (!scope) return null;
  const approvals = approvalsForSurface(query.data?.items ?? [], surface);
  return <>
    {Boolean(completedAt) && completedAt !== undefined && <ApprovalRefresh key={completedAt} scope={scope} completedAt={completedAt} />}
    {(approvals.length > 0 || query.isError) && <div data-tool-approvals className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-3 py-2">
      {query.isError && <ApprovalLoadError onRetry={() => void query.refetch()} />}
      {approvals.map((approval) => <PendingChatApproval key={approval.id} scope={scope} approval={approval} />)}
    </div>}
  </>;
}
