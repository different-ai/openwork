import { timeoutManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { CloudCodingPushApproval, CloudCodingPushDecisionInput } from "@openwork/types/den/cloud-coding";

import { markFeatureUsed, type DenClient } from "@/app/lib/den";
import { openDesktopUrlWithStatus } from "@/app/lib/desktop";
import { ApprovalLoadError } from "@/react-app/design-system/composer-approval-panel";
import { PushApprovalPanel } from "./push-approval-panel";

type Choice = CloudCodingPushDecisionInput["decision"];
export type CloudCodingApprovalScope = {
  client: Pick<DenClient, "listCloudCodingApprovals" | "getCloudCodingApproval" | "decideCloudCodingApproval">;
  denBaseUrl: string;
  organizationId: string;
  principal: string;
};

function pendingKey(scope: CloudCodingApprovalScope) {
  return [scope.denBaseUrl, "cloud-coding-approvals", scope.organizationId, scope.principal] as const;
}

function usePendingApprovals(scope: CloudCodingApprovalScope, active: boolean, completedAt?: number) {
  return useQuery({
    queryKey: pendingKey(scope),
    queryFn: () => scope.client.listCloudCodingApprovals(scope.organizationId),
    enabled: active,
    retry: false,
    refetchInterval: completedAt === undefined ? 5_000 : false,
    refetchIntervalInBackground: false,
    refetchOnMount: completedAt === undefined ? true : (query) => query.state.dataUpdatedAt < completedAt ? "always" : false,
  });
}

function RefreshPending({ scope, completedAt }: { scope: CloudCodingApprovalScope; completedAt: number }) {
  usePendingApprovals(scope, true, completedAt);
  return null;
}

const PUSH_TIMEOUT = 5 * 60_000;
const PUSH_INTERVAL = 3_000;

function waitForPush(get: () => Promise<CloudCodingPushApproval>, signal: AbortSignal, remaining: number) {
  return new Promise<CloudCodingPushApproval | null>((resolve) => {
    let next: ReturnType<typeof timeoutManager.setTimeout> | undefined;
    let settled = false;
    const finish = (approval: CloudCodingPushApproval | null) => {
      settled = true;
      timeoutManager.clearTimeout(deadline);
      if (next !== undefined) timeoutManager.clearTimeout(next);
      signal.removeEventListener("abort", abort);
      resolve(approval);
    };
    const abort = () => finish(null);
    const deadline = timeoutManager.setTimeout(abort, Math.max(0, remaining));
    const poll = async () => {
      const approval = await get().catch(() => null);
      if (settled) return;
      if (approval && (approval.pullRequest || ["expired", "superseded", "denied"].includes(approval.status))) {
        finish(approval);
        return;
      }
      next = timeoutManager.setTimeout(poll, PUSH_INTERVAL);
    };
    if (signal.aborted || remaining <= 0) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      next = timeoutManager.setTimeout(poll, PUSH_INTERVAL);
    }
  });
}

export function useCloudCodingApprovals(scope: CloudCodingApprovalScope, active: boolean, trackUse = markFeatureUsed) {
  const pending = usePendingApprovals(scope, active);
  const queryClient = useQueryClient();
  const sending = useRef(false);
  const [dismissed, setDismissed] = useState(false);
  const [handledIds, setHandledIds] = useState<ReadonlySet<string>>(new Set());
  const decision = useMutation({
    mutationFn: async ({ approval, choice }: { approval: CloudCodingPushApproval; choice: Choice }) => {
      trackUse("cloudCoding");
      const updated = await scope.client.decideCloudCodingApproval(scope.organizationId, approval.id, choice);
      return { approval: updated, choice, deadline: Date.now() + PUSH_TIMEOUT };
    },
    onSuccess: (result, { approval }) => {
      setHandledIds(previous => new Set([...previous, approval.id]));
      setDismissed(false);
      queryClient.setQueryData<CloudCodingPushApproval[]>(pendingKey(scope), (list) => list?.filter(item => item.id !== result.approval.id));
      void queryClient.invalidateQueries({ queryKey: pendingKey(scope) });
    },
    onSettled: () => { sending.current = false; },
  });
  const result = dismissed ? undefined : decision.data;
  const pushing = result?.choice === "allow_once" && !result.approval.pullRequest
    && (result.approval.status === "approved" || result.approval.status === "pushed");
  const outcome = useQuery({
    queryKey: [...pendingKey(scope), "push", result?.approval.id],
    queryFn: ({ signal }) => result ? waitForPush(() => scope.client.getCloudCodingApproval(scope.organizationId, result.approval.id), signal, result.deadline - Date.now()) : null,
    enabled: active && pushing,
    staleTime: Infinity,
    retry: false,
  });
  const waiting = (pending.data ?? []).filter(item => item.status === "pending" && !handledIds.has(item.id))
    .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  const approval = decision.isPending || decision.isError ? decision.variables?.approval : waiting[0];
  const replacedDenial = result?.choice === "deny" && waiting.length > 0;
  if (replacedDenial) setDismissed(true);
  const showResult = result && !replacedDenial;
  const visible = showResult ? outcome.data ?? result.approval : approval;
  const phase = !showResult ? "pending"
    : result.choice === "deny" ? "denied"
    : visible?.pullRequest ? "opened"
    : pushing && !outcome.isSuccess ? "pushing" : "unfinished";
  const decide = (choice: Choice) => {
    if (!active || !approval || sending.current) return;
    sending.current = true;
    decision.mutate({ approval, choice });
  };
  return {
    approval: active ? visible : undefined,
    phase,
    count: approval && !waiting.some(item => item.id === approval.id) ? waiting.length + 1 : waiting.length,
    busy: decision.isPending,
    retryDecision: decision.isError ? decision.variables?.choice : undefined,
    loadFailed: active && pending.isError,
    retryLoad: () => void pending.refetch(),
    decide,
    dismiss: () => setDismissed(true),
  } as const;
}

type DockProps = {
  scope: CloudCodingApprovalScope;
  active: boolean;
  completedAt: number;
};

export function CloudCodingApprovalDock({ scope, ...props }: Omit<DockProps, "scope"> & { scope: CloudCodingApprovalScope | null }) {
  return scope ? <ScopedApprovalDock key={JSON.stringify(pendingKey(scope))} scope={scope} {...props} /> : null;
}

function ScopedApprovalDock({ scope, active, completedAt }: DockProps) {
  const { approval, loadFailed, retryLoad, ...panel } = useCloudCodingApprovals(scope, active);
  return <>
    {active && completedAt > 0 && <RefreshPending key={completedAt} scope={scope} completedAt={completedAt} />}
    {approval ? <PushApprovalPanel key={approval.id} {...panel} approval={approval} onOpenPullRequest={openDesktopUrlWithStatus} />
      : loadFailed ? <div className="border-b border-dls-border px-4 py-3"><ApprovalLoadError onRetry={retryLoad} /></div> : null}
  </>;
}
