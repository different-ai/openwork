"use client"

import { AlertTriangle, Clock3, ShieldCheck } from "lucide-react"
import type { DynamicToolUIPart } from "ai"
import { useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { Tool } from "@/components/ui/tool"
import { parseRecord } from "@/lib/capability-call"
import { t } from "@/i18n"
import { scheduledTasksRoute } from "@/react-app/shell/workspace-routes"

type ScheduledTaskProposalReceipt = {
  taskId: string
  revisionId: string
  workspaceId: string
  name: string
  prompt: string
  state: "draft"
  enabled: false
  reviewed: false
  limitation: string
  route: string
}

function proposalInput(part: DynamicToolUIPart) {
  const input = parseRecord(part.input)
  return input?.id === "scheduled-task.propose-draft"
}

export function isScheduledTaskProposalPart(part: DynamicToolUIPart) {
  return part.toolName === "openwork_execute" && proposalInput(part)
}

function parseProposalReceipt(output: unknown): ScheduledTaskProposalReceipt | null {
  const envelope = parseRecord(output)
  const result = parseRecord(envelope?.result)
  if (
    envelope?.ok !== true
    || envelope.id !== "scheduled-task.propose-draft"
    || !result
    || typeof result.taskId !== "string"
    || typeof result.revisionId !== "string"
    || typeof result.workspaceId !== "string"
    || typeof result.name !== "string"
    || typeof result.prompt !== "string"
    || result.state !== "draft"
    || result.enabled !== false
    || result.reviewed !== false
    || typeof result.limitation !== "string"
    || typeof result.route !== "string"
  ) {
    return null
  }
  return {
    taskId: result.taskId,
    revisionId: result.revisionId,
    workspaceId: result.workspaceId,
    name: result.name,
    prompt: result.prompt,
    state: "draft",
    enabled: false,
    reviewed: false,
    limitation: result.limitation,
    route: result.route,
  }
}

export function OpenWorkScheduledTaskProposalTool({ part }: { part: DynamicToolUIPart }) {
  const navigate = useNavigate()

  if (part.state !== "output-available") {
    return <Tool toolPart={part} title={t("scheduled_tasks.proposal_in_progress")} />
  }

  const receipt = parseProposalReceipt(part.output)
  if (!receipt) return <Tool toolPart={part} title={t("scheduled_tasks.proposal_complete")} />

  const openDraft = () => {
    const fallback = scheduledTasksRoute(receipt.workspaceId, receipt.taskId)
    navigate(receipt.route.startsWith("/scheduled-tasks/") ? receipt.route : fallback)
  }

  return (
    <div
      className="not-prose w-full max-w-2xl overflow-hidden rounded-2xl border border-dls-border bg-dls-surface/95 shadow-sm"
      data-openwork-scheduled-task-proposal-card
      data-scheduled-task-id={receipt.taskId}
    >
      <div className="flex items-start gap-3 border-b border-dls-border px-4 py-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-amber-6/35 bg-amber-3/30 text-amber-11">
          <Clock3 className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-dls-primary">{t("scheduled_tasks.proposal_title")}</h3>
          <p className="mt-0.5 text-xs text-dls-secondary">
            {t("scheduled_tasks.proposal_copy")}
          </p>
        </div>
      </div>
      <div className="space-y-3 px-4 py-4">
        <div>
          <p className="text-sm font-medium text-dls-primary">{receipt.name}</p>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs leading-5 text-dls-secondary">{receipt.prompt}</p>
        </div>
        <div className="grid gap-2 rounded-xl bg-dls-hover/50 p-3 text-xs sm:grid-cols-3">
          <span className="flex items-center gap-1.5"><AlertTriangle className="size-3.5 text-amber-11" />{t("scheduled_tasks.disabled")}</span>
          <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5" />{t("scheduled_tasks.review_required")}</span>
          <span>{t("scheduled_tasks.limit_copy")}</span>
        </div>
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-open-scheduled-task-proposal={receipt.taskId}
            aria-label={`${t("scheduled_tasks.review_draft")} ${receipt.name}`}
            onClick={openDraft}
          >
            {t("scheduled_tasks.review_draft")}
          </Button>
        </div>
      </div>
    </div>
  )
}
