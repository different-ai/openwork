import { timeoutManager, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { CloudCodingPushApproval, CloudCodingPushDecisionInput } from "@openwork/types/den/cloud-coding";

import { DenApiError, markFeatureUsed, type DenClient } from "@/app/lib/den";
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
  const [handledIds, setHandledIds] = useState<ReadonlySet<string>>(new Set());
  const [lastShown, setLastShown] = useState<CloudCodingPushApproval>();
  const [result, setResult] = useState<{ approval: CloudCodingPushApproval; elsewhere: boolean; deadline: number }>();
  const resolveDecision = (approval: CloudCodingPushApproval, elsewhere: boolean) => {
    setHandledIds(previous => new Set([...previous, approval.id]));
    setLastShown(undefined);
    setResult(approval.status === "approved" || approval.status === "pushed" || approval.status === "denied"
      ? { approval, elsewhere, deadline: Date.now() + PUSH_TIMEOUT } : undefined);
  };
  const decision = useMutation({
    mutationFn: async ({ approval, choice }: { approval: CloudCodingPushApproval; choice: Choice }) => {
      trackUse("cloudCoding");
      try {
        return { approval: await scope.client.decideCloudCodingApproval(scope.organizationId, approval.id, choice), elsewhere: false };
      } catch (error) {
        if (!(error instanceof DenApiError) || error.status !== 409 || error.code !== "approval_not_pending") throw error;
        return { approval: await scope.client.getCloudCodingApproval(scope.organizationId, approval.id), elsewhere: true };
      }
    },
    onSuccess: ({ approval, elsewhere }) => {
      resolveDecision(approval, elsewhere);
      queryClient.setQueryData<CloudCodingPushApproval[]>(pendingKey(scope), (list) => list?.filter(item => item.id !== approval.id));
      void queryClient.invalidateQueries({ queryKey: pendingKey(scope) });
    },
    onSettled: () => { sending.current = false; },
  });
  const waiting = (pending.data ?? []).filter(item => item.status === "pending" && !handledIds.has(item.id))
    .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  const missing = active && !decision.isPending && pending.data && lastShown && !waiting.some(item => item.id === lastShown.id) ? lastShown : undefined;
  const external = useQuery({
    queryKey: [...pendingKey(scope), "settled-elsewhere", missing?.id],
    queryFn: () => missing ? scope.client.getCloudCodingApproval(scope.organizationId, missing.id) : null,
    enabled: Boolean(missing),
    staleTime: Infinity,
    retry: false,
  });
  if (missing && external.data && external.data.status !== "pending") resolveDecision(external.data, true);
  else if (missing && (external.isError || external.isSuccess)) setLastShown(undefined);
  const pushing = result && !result.approval.pullRequest
    && (result.approval.status === "approved" || result.approval.status === "pushed");
  const outcome = useQuery({
    queryKey: [...pendingKey(scope), "push", result?.approval.id],
    queryFn: ({ signal }) => result ? waitForPush(() => scope.client.getCloudCodingApproval(scope.organizationId, result.approval.id), signal, result.deadline - Date.now()) : null,
    enabled: active && Boolean(pushing),
    staleTime: Infinity,
    retry: false,
  });
  const approval = decision.isPending ? decision.variables?.approval : missing ?? waiting[0];
  const replacedDenial = result?.approval.status === "denied" && !result.elsewhere && waiting.length > 0;
  if (replacedDenial) setResult(undefined);
  const showResult = replacedDenial ? undefined : result;
  if (active && !showResult && !missing && approval?.id !== lastShown?.id) setLastShown(approval);
  const visible = showResult ? outcome.data ?? showResult.approval : approval;
  const phase = !showResult ? "pending"
    : showResult.approval.status === "denied" ? "denied"
    : visible?.pullRequest ? "opened"
    : pushing && !outcome.isSuccess ? "pushing" : "unfinished";
  const decide = (choice: Choice) => {
    if (!active || !approval || missing || sending.current) return;
    sending.current = true;
    decision.mutate({ approval, choice });
  };
  return {
    approval: active ? visible : undefined,
    phase,
    settledElsewhere: showResult?.elsewhere,
    count: approval && !waiting.some(item => item.id === approval.id) ? waiting.length + 1 : waiting.length,
    busy: decision.isPending || Boolean(missing),
    retryDecision: decision.isError && !missing && decision.variables?.approval.id === approval?.id ? decision.variables?.choice : undefined,
    loadFailed: active && pending.isError,
    retryLoad: () => void pending.refetch(),
    decide,
    dismiss: () => setResult(undefined),
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
