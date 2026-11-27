import type { ToolApproval } from "@openwork/types/den/tool-permissions";

import { t } from "@/i18n";

export type ToolApprovalSurface = "chat" | "automation";

export function approvalsForSurface(items: readonly ToolApproval[], surface: ToolApprovalSurface): ToolApproval[] {
  return items.filter((item) => item.status === "pending" && item.context.kind === surface);
}

export function automationApprovalTarget(approval: ToolApproval) {
  if (approval.status !== "pending" || approval.context.kind !== "automation" || !approval.context.id) return null;
  return { automationId: approval.context.id, runId: approval.runId, toolName: approval.toolName, connectionName: approval.connectionName };
}

export function approvalsForRun(items: readonly ToolApproval[], automationId: string, runId: string): ToolApproval[] {
  return items.filter((item) => {
    const target = automationApprovalTarget(item);
    return target?.automationId === automationId && target.runId === runId;
  });
}

export type RunApprovalPlacement = { runId: string; executionTarget: "cloud" | "desktop" } | { knownRunIds: readonly string[] };

export function approvalsForPlacement(items: readonly ToolApproval[], automationId: string, placement: RunApprovalPlacement) {
  if ("runId" in placement) return approvalsForRun(items, automationId, placement.runId);
  return items.filter((item) => {
    const target = automationApprovalTarget(item);
    return target?.automationId === automationId && (target.runId === null || !placement.knownRunIds.includes(target.runId));
  });
}

export function approvalRunGroup(approval: ToolApproval) {
  return JSON.stringify([approval.context.id, approval.runId ?? approval.id, approval.runId === null]);
}

export function recordRunApproval(previous: { allowed: boolean; claimed: boolean }, allow: boolean, hasPending: boolean) {
  const allowed = previous.allowed || allow;
  const start = allowed && !hasPending && !previous.claimed;
  return { allowed, claimed: previous.claimed || start, start };
}

export function approvalRows<T extends { approval: ToolApproval }>(pending: readonly ToolApproval[], decided: readonly T[]) {
  return [...decided, ...pending.filter((approval) => !decided.some((row) => row.approval.id === approval.id)).map((approval) => ({ approval }))]
    .sort((a, b) => Date.parse(b.approval.createdAt) - Date.parse(a.approval.createdAt) || a.approval.id.localeCompare(b.approval.id));
}

export type AutomationApprovalResult = { kind: "denied" | "skipped" | "failed" | "waiting" | "allowed" } | { kind: "started"; runId: string };

export async function approvalRestartOptions(placement: RunApprovalPlacement, runId: string | null, loadTarget: (runId: string) => Promise<"cloud" | "desktop">) {
  if ("runId" in placement) return { executionTarget: placement.executionTarget };
  return runId ? { executionTarget: await loadTarget(runId) } : {};
}

export function automationApprovalResultWords(result: AutomationApprovalResult, context: ToolApproval["context"], denied = false) {
  switch (result.kind) {
    case "denied": return { line: t("tool_approvals.automation_denied") };
    case "waiting": return { line: t("tool_approvals.automation_waiting") };
    case "allowed": return { line: t("tool_approvals.automation_allowed") };
    case "skipped": return { line: t(denied ? "tool_approvals.automation_next_run_after_deny" : "tool_approvals.automation_next_run") };
    case "failed": {
      const line = t("tool_approvals.run_failed", { name: automationApprovalName(context) });
      return { line: denied ? `${t("tool_approvals.automation_denied")} ${line}` : line };
    }
    case "started": return { line: t(denied ? "tool_approvals.automation_started_after_deny" : "tool_approvals.automation_started"), open: { label: t("tool_approvals.open_run"), runId: result.runId } };
  }
}

export function automationApprovalName(context: ToolApproval["context"]): string {
  return context.label?.trim() || t("tool_approvals.automation_fallback");
}

export function approvalWords(approval: ToolApproval): { title: string; line?: string } {
  const tool = approval.toolTitle.trim() || t("tool_approvals.tool_fallback");
  const connection = approval.connectionName.trim() || t("tool_approvals.connection_fallback");
  if (approval.context.kind === "chat") return { title: t("tool_approvals.chat_request", { tool, connection }) };
  const automation = approval.context.kind === "automation";
  return {
    title: t("tool_approvals.title", {
      who: automation ? automationApprovalName(approval.context) : "OpenWork",
      tool: approval.toolTitle || t("tool_approvals.tool_fallback"),
      connection: approval.connectionName || t("tool_approvals.connection_fallback"),
    }),
    line: automation ? t("tool_approvals.automation_line") : undefined,
  };
}
