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

export type AutomationApprovalResult = { kind: "denied" | "skipped" | "failed" } | { kind: "started"; runId: string };

export function automationApprovalResultWords(result: AutomationApprovalResult, context: ToolApproval["context"]) {
  switch (result.kind) {
    case "denied": return { line: t("tool_approvals.automation_denied") };
    case "skipped": return { line: t("tool_approvals.automation_next_run") };
    case "failed": return { line: t("tool_approvals.run_failed", { name: automationApprovalName(context) }) };
    case "started": return { line: t("tool_approvals.automation_started"), open: { label: t("tool_approvals.open_run"), runId: result.runId } };
  }
}

export function automationApprovalName(context: ToolApproval["context"]): string {
  return context.label?.trim() || t("tool_approvals.automation_fallback");
}

export function approvalWords(approval: ToolApproval): { title: string; line: string } {
  const automation = approval.context.kind === "automation";
  return {
    title: t("tool_approvals.title", {
      who: automation ? automationApprovalName(approval.context) : "OpenWork",
      tool: approval.toolTitle || t("tool_approvals.tool_fallback"),
      connection: approval.connectionName || t("tool_approvals.connection_fallback"),
    }),
    line: automation ? t("tool_approvals.automation_line") : t("tool_approvals.chat_line"),
  };
}
