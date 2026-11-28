"use client";

import { markFeatureUsed } from "../../../_lib/feature-usage";
import { CloudCodingApprovalView } from "./cloud-coding-approval-view";
import { CloudCodingApprovalUnavailable, useCloudCodingApproval, useCloudCodingDecision } from "./cloud-coding-data";

export function CloudCodingApprovalScreen({ orgId, approvalId }: { orgId: string; approvalId: string }) {
  const approval = useCloudCodingApproval(orgId, approvalId);
  const decision = useCloudCodingDecision(orgId, approvalId);
  const unavailable = approval.error instanceof CloudCodingApprovalUnavailable || decision.error instanceof CloudCodingApprovalUnavailable;
  return <CloudCodingApprovalView
    approval={approval.data}
    unavailable={unavailable}
    loadError={approval.isError && !unavailable ? "Couldn't load this request. Try again." : undefined}
    decisionError={decision.isError && !unavailable && approval.data?.status === "pending" ? "Couldn't save your decision. Try again." : undefined}
    decisionPending={decision.isPending}
    onRetry={() => { void approval.refetch(); }}
    onDecision={(value) => {
      if (decision.isPending || approval.data?.status !== "pending") return;
      markFeatureUsed("cloudCoding");
      decision.mutate(value);
    }}
  />;
}
