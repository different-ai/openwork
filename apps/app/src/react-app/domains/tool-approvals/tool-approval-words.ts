import type { ToolApproval } from "@openwork/types/den/tool-permissions";

import { t } from "@/i18n";

export type ToolApprovalSurface = "chat" | "automation";

export function approvalsForSurface(items: readonly ToolApproval[], surface: ToolApprovalSurface): ToolApproval[] {
  return items.filter((item) => item.status === "pending" && item.context.kind === surface);
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
