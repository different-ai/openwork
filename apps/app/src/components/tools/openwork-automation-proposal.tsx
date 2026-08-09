"use client"

import { useState } from "react"
import { AlertTriangle, CalendarClock, Check } from "lucide-react"
import type { DynamicToolUIPart } from "ai"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { useQuery } from "@tanstack/react-query"

import { automationProposalSchema, AUTOMATION_FREE_MODEL, type AutomationProposal } from "@openwork/types/automations"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { Button } from "@/components/ui/button"
import { Tool } from "@/components/ui/tool"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { formatAutomationSchedule } from "@/react-app/domains/automations/automation-format"
import {
  automationModelOptions,
  describeAutomationModel,
  resolveProposalModel,
} from "@/react-app/domains/automations/automation-model-options"
import { automationsRoute } from "@/react-app/shell/workspace-routes"

function parseOutputValue(output: unknown): unknown {
  if (typeof output !== "string") return output
  try {
    return JSON.parse(output)
  } catch {
    return null
  }
}

/**
 * Reads an `automation.propose` affordance result out of an openwork_execute
 * tool part. Returns null for every other affordance so the generic capability
 * line keeps rendering them.
 */
export function parseAutomationProposal(output: unknown): AutomationProposal | null {
  const envelope = parseOutputValue(output)
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return null
  const record = envelope as Record<string, unknown>
  if (record.ok !== true || record.id !== "automation.propose") return null
  const result = record.result
  if (result === null || typeof result !== "object" || Array.isArray(result)) return null
  const parsed = automationProposalSchema.safeParse((result as Record<string, unknown>).proposal)
  return parsed.success ? parsed.data : null
}

export function isAutomationProposalToolPart(part: DynamicToolUIPart): boolean {
  return part.toolName === "openwork_execute"
    && part.state === "output-available"
    && parseAutomationProposal(part.output) !== null
}

export function OpenWorkAutomationProposalTool({ part }: { part: DynamicToolUIPart }) {
  const navigate = useNavigate()
  const denAuth = useDenAuth()
  const [created, setCreated] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const proposal = part.state === "output-available" ? parseAutomationProposal(part.output) : null
  const settings = readDenSettings()
  const token = settings.authToken?.trim() ?? ""
  const organizationId = settings.activeOrgId?.trim() ?? ""
  const signedIn = denAuth.isSignedIn && Boolean(token) && Boolean(organizationId)
  const providersQuery = useQuery({
    queryKey: ["den", "automations", organizationId, "models"],
    queryFn: () => createDenClient({ baseUrl: settings.baseUrl, token }).listOrgLlmProviders(organizationId),
    enabled: signedIn && !created,
  })
  const providers = providersQuery.data ?? []
  const resolved = providersQuery.isError || providersQuery.data === undefined || !proposal
    ? null
    : resolveProposalModel(proposal.model, providers)
  const modelLabel = resolved
    ? describeAutomationModel(resolved.model, automationModelOptions(providers))
    : null

  if (!proposal) {
    return <Tool toolPart={part} title="Proposed an Automation" />
  }

  const blocker = !signedIn
    ? "Sign in to OpenWork Cloud to create this Automation."
    : null

  const create = async () => {
    setBusy(true)
    try {
      const client = createDenClient({ baseUrl: settings.baseUrl, token })
      const detail = await client.createAutomation(organizationId, {
        name: proposal.name,
        instructions: proposal.instructions,
        schedule: proposal.schedule,
        model: resolved?.model ?? proposal.model ?? {
          providerId: AUTOMATION_FREE_MODEL.providerId,
          modelId: AUTOMATION_FREE_MODEL.modelId,
        },
      })
      setCreated(detail.automation.id)
      toast.success("Automation created and active")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the Automation")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="not-prose w-full max-w-2xl overflow-hidden rounded-2xl border border-dls-border bg-dls-surface/95 shadow-sm"
      data-openwork-automation-proposal
      data-automation-created={created ?? undefined}
      data-automation-model-resolution={resolved?.resolution}
    >
      <div className="flex items-start gap-3 border-b border-dls-border px-4 py-3">
        <div className={created
          ? "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-green-6/35 bg-green-3/30 text-green-11"
          : "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-dls-border bg-dls-hover text-dls-secondary"
        }>
          {created ? <Check className="size-4" /> : <CalendarClock className="size-4" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-dls-primary">
            {created ? "Automation created and active" : "Suggested Automation"}
          </h3>
          <p className="mt-0.5 text-xs text-dls-secondary">
            {created
              ? "It runs on the schedule below while this desktop is connected."
              : "Nothing was created yet. Review it, then create it if it looks right."}
          </p>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div>
          <p className="truncate text-sm font-medium text-dls-primary" title={proposal.name}>{proposal.name}</p>
          <p className="text-xs text-dls-secondary">{formatAutomationSchedule(proposal.schedule)}</p>
          {modelLabel ? <p className="text-xs text-dls-secondary">Runs with {modelLabel}</p> : null}
        </div>
        <p className="whitespace-pre-wrap text-sm text-dls-secondary">{proposal.instructions}</p>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-dls-border px-4 py-3">
        <p className="min-w-0 flex-1 text-xs text-dls-secondary">
          {blocker ?? "Automations run on this desktop while it is connected."}
        </p>
        {created ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            data-open-automation={created}
            onClick={() => navigate(automationsRoute())}
          >
            Open Automation
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="shrink-0"
            disabled={busy || blocker !== null || (signedIn && providersQuery.isLoading)}
            data-create-automation
            onClick={() => void create()}
          >
            {busy ? "Creating…" : "Create Automation"}
          </Button>
        )}
      </div>

      {blocker && !created ? (
        <div className="flex items-center gap-2 border-t border-dls-border px-4 py-2 text-xs text-amber-11">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{blocker}</span>
        </div>
      ) : null}
      {resolved?.resolution === "fallback" && !created ? (
        <div className="flex items-center gap-2 border-t border-dls-border px-4 py-2 text-xs text-amber-11">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            The proposed model isn't available for Automations, so runs use the free starter model. You can change the model after creating.
          </span>
        </div>
      ) : null}
    </div>
  )
}
