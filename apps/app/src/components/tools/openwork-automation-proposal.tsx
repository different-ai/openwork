"use client"

import { useState } from "react"
import { AlertTriangle, CalendarClock, Check, ChevronRight } from "lucide-react"
import type { DynamicToolUIPart, UIMessage } from "ai"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import { useQuery } from "@tanstack/react-query"

import { automationProposalSchema, type AutomationProposal } from "@openwork/types/automations"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { featureAnalytics } from "@/app/lib/analytics"
import { Button } from "@/components/ui/button"
import { Tool } from "@/components/ui/tool"
import { codeModeToolCalls } from "@/lib/code-mode-tools"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { AUTOMATION_CLOUD_DEFAULT_MODEL, type AutomationExecutionTarget } from "@openwork/types/automations"
import { isDesktopRuntime } from "@/app/lib/runtime-env"
import {
  automationCreationPlacement,
  useAutomationDeploymentEnabled,
  useDesktopAutomationsEnabled,
} from "@/react-app/domains/automations/automation-availability"
import {
  automationCanUseChoices,
  automationPlacementOf,
  initialCanUse,
  type AutomationCanUse,
} from "@/react-app/domains/automations/automation-editor"
import { automationCloudOptions, automationPlacementChoices, resolveAutomationPlacement } from "@/react-app/domains/automations/automation-placement"
import { formatAutomationSchedule } from "@/react-app/domains/automations/automation-format"
import {
  automationModelOptions,
  automationProviderCatalog,
  describeAutomationModel,
  resolveProposalModel,
} from "@/react-app/domains/automations/automation-model-options"
import { automationsRoute } from "@/react-app/shell/workspace-routes"
import { useWorkspaceMaybe } from "@/react-app/shell/workspace-provider"
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider"
import { getConnectedProviderItems, useProviderListQuery } from "@/react-app/infra/provider-list-query"

function contentText(output: unknown[]): string | null {
  const text = output.flatMap((item) => {
    if (typeof item !== "object" || item === null || !("text" in item)) return []
    return typeof item.text === "string" ? [item.text] : []
  })
  return text.length > 0 ? text.join("\n") : null
}

function parseOutputValue(output: unknown): unknown {
  const text = Array.isArray(output) ? contentText(output) : output
  if (typeof text !== "string") return text
  try {
    return JSON.parse(text)
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

export function automationProposalCalls(part: DynamicToolUIPart): DynamicToolUIPart[] {
  return (codeModeToolCalls(part) ?? []).filter(isAutomationProposalToolPart)
}

export function automationProposalsInParts(parts: UIMessage["parts"]): DynamicToolUIPart[] {
  return parts.flatMap((part) => {
    if (part.type !== "dynamic-tool") return []
    if (isAutomationProposalToolPart(part)) return [part]
    return automationProposalCalls(part)
  })
}

export function OpenWorkAutomationProposalTool({ part }: { part: DynamicToolUIPart }) {
  const navigate = useNavigate()
  const denAuth = useDenAuth()
  const automationsEnabled = useAutomationDeploymentEnabled()
  const desktopAllowed = useDesktopAutomationsEnabled()
  const workspaceContext = useWorkspaceMaybe()
  const [created, setCreated] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<AutomationCanUse | null>(null)

  const proposal = part.state === "output-available" ? parseAutomationProposal(part.output) : null
  const settings = readDenSettings()
  const token = settings.authToken?.trim() ?? ""
  const organizationId = settings.activeOrgId?.trim() ?? ""
  const signedIn = denAuth.isSignedIn && Boolean(token) && Boolean(organizationId)
  const featuresQuery = useQuery({
    queryKey: ["den", "org-features", organizationId || null],
    queryFn: () => createDenClient({ baseUrl: settings.baseUrl, token }).getOrgFeatures(organizationId),
    enabled: signedIn && automationsEnabled && Boolean(proposal),
    staleTime: 30_000,
    retry: false,
  })
  const simplerReview = signedIn && automationsEnabled && !featuresQuery.isError && featuresQuery.data?.automationSimpleReview === true
  // Offer the same places the Automations page does: this desktop and, when Den
  // says Cloud can run agent Automations for this member, the cloud. An older
  // Den answers null and the runtime's fixed placement stays.
  const targetsQuery = useQuery({
    queryKey: ["den", "automations", organizationId, "execution-targets"],
    queryFn: () => createDenClient({ baseUrl: settings.baseUrl, token }).listAutomationRunners(organizationId),
    enabled: automationsEnabled && signedIn && !created,
    retry: false,
  })
  const placementChoices = automationPlacementChoices({ targets: targetsQuery.data, desktopRuntime: isDesktopRuntime(), desktopAllowed })
  // Meetings-based schedules only run in the cloud, so they start there.
  const suggested: AutomationExecutionTarget = proposal?.schedule.kind === "calendar"
    ? "cloud"
    : proposal?.executionTarget ?? automationCreationPlacement()
  // The same three choices as the Automations editor: this computer, the
  // person's cloud computer, or the headless cloud that reaches only connected
  // accounts. Without an answer from Den, keep the runtime's own placement.
  const canUseChoices = automationCanUseChoices(placementChoices, automationCloudOptions(targetsQuery.data))
  const suggestedCanUse = initialCanUse(resolveAutomationPlacement(suggested, placementChoices), proposal?.model, canUseChoices)
  const canUse = canUseChoices.length === 0
    ? null
    : picked && canUseChoices.includes(picked) ? picked : canUseChoices.includes(suggestedCanUse) ? suggestedCanUse : canUseChoices[0]
  const placement = canUse ? automationPlacementOf(canUse) : automationCreationPlacement()
  // The headless cloud runs on the organization's one cloud model: nothing to resolve.
  const usesCloudDefault = canUse === "accounts"
  const providersQuery = useQuery({
    queryKey: ["den", "automations", organizationId, "models"],
    queryFn: () => createDenClient({ baseUrl: settings.baseUrl, token }).listOrgLlmProviders(organizationId),
    enabled: automationsEnabled && signedIn && !created,
  })
  const runtimeProviders = useProviderListQuery({
    client: workspaceContext?.client ?? null,
    baseUrl: workspaceContext?.opencodeBaseUrl,
    directory: workspaceContext?.selectedWorkspaceRoot,
    enabled: automationsEnabled && signedIn && !created && placement === "desktop",
  })
  const zenModelRestricted = useDesktopRestriction("allowZenModel")
  const providers = providersQuery.data ?? []
  const availability = {
    includeFreeStarter: placement === "desktop" && !zenModelRestricted,
    catalog: placement === "desktop" && runtimeProviders.data !== undefined
      ? automationProviderCatalog(getConnectedProviderItems(runtimeProviders.data))
      : undefined,
  }
  const modelLookupFailed = providersQuery.isError || (placement === "desktop" && runtimeProviders.isError)
  const modelLookupPending = providersQuery.data === undefined
    || (placement === "desktop" && runtimeProviders.data === undefined)
  const resolved = !proposal
    ? null
    : usesCloudDefault
      ? { model: { ...AUTOMATION_CLOUD_DEFAULT_MODEL, variant: null }, resolution: "default" as const }
      : modelLookupFailed || modelLookupPending
        ? null
        : resolveProposalModel(proposal.model, providers, availability)
  const modelLabel = usesCloudDefault
    ? AUTOMATION_CLOUD_DEFAULT_MODEL.modelName
    : resolved
      ? describeAutomationModel(resolved.model, automationModelOptions(providers, availability))
      : null

  if (!proposal) {
    return <Tool toolPart={part} title="Proposed an Automation" />
  }

  // Pin the workspace of the pane this card renders in — renderer-owned state.
  // The proposal's own workspaceId is agent-supplied and deliberately ignored:
  // a manipulated agent must not be able to retarget the Automation.
  const pinnedWorkspaceId = workspaceContext?.workspaceId?.trim() || null

  const blocker = !automationsEnabled
    ? "Automations are disabled for this deployment."
    : !signedIn
      ? "Sign in to OpenWork Cloud to create this Automation."
      : modelLookupFailed && !usesCloudDefault
        ? "Model availability could not be checked. Try again before creating this Automation."
        : proposal.schedule.kind === "calendar" && placement !== "cloud"
          ? "Automations that run around meetings run in OpenWork Cloud, which isn't available for your account yet."
          : null

  const create = async () => {
    if (!automationsEnabled || targetsQuery.isLoading || blocker || !resolved || resolved.resolution === "unavailable") return
    setBusy(true)
    try {
      const client = createDenClient({ baseUrl: settings.baseUrl, token })
      const model = resolved.model
      const detail = placement === "cloud"
        ? await client.createCloudAutomation(organizationId, {
            name: proposal.name,
            schedule: proposal.schedule,
            action: { kind: "agent", instructions: proposal.instructions, model },
          })
        : await client.createAutomation(organizationId, {
            name: proposal.name,
            instructions: proposal.instructions,
            schedule: proposal.schedule,
            model,
            // Pin the proposal's originating workspace, falling back to the pane
            // this card renders in, so the Automation keeps running there instead
            // of following whichever workspace is active at run time.
            ...(pinnedWorkspaceId ? { workspaceId: pinnedWorkspaceId } : {}),
          })
      featureAnalytics.automationCreated(placement)
      setCreated(detail.automation.id)
      toast.success("Automation created and active")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the Automation")
    } finally {
      setBusy(false)
    }
  }

  const openCreated = () => navigate(`${automationsRoute()}?${new URLSearchParams({ automation: created ?? "" })}`)
  const createDisabled = busy || targetsQuery.isLoading || blocker !== null || !resolved || resolved.resolution === "unavailable"
  const placementLabel = (choice: AutomationCanUse) => choice === "computer" ? "This computer" : choice === "cloud-computer" ? "Your cloud computer" : "Cloud (connected accounts only)"
  const placementPicker = !created && canUseChoices.length > 1 ? (
    <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Where it runs" data-automation-placement-choice={placement} data-automation-can-use={canUse ?? undefined}>
      {canUseChoices.map((choice) => (
        <Button key={choice} type="button" size="sm" variant={canUse === choice ? "secondary" : "ghost"}
          role="radio" aria-checked={canUse === choice} disabled={busy || (choice === "computer" && proposal.schedule.kind === "calendar")}
          data-automation-placement={choice} onClick={() => setPicked(choice)}>
          {simplerReview ? placementLabel(choice) : choice === "computer" ? "This computer" : choice === "cloud-computer" ? "Cloud computer" : "Cloud, connected accounts only"}
        </Button>
      ))}
    </div>
  ) : null

  if (simplerReview) {
    const reason = blocker ?? (resolved?.resolution === "unavailable" ? "This model can't run Automations. Ask for a different model before turning this on." : null)
    const where = targetsQuery.isLoading ? "Checking where this can run…" : canUse === "accounts"
      ? "In the cloud, using only your connected accounts."
      : placement === "cloud" ? "On your cloud computer, even when this computer is off."
        : "On this computer. OpenWork needs to be open and connected at the scheduled time."
    return (
      <div className="not-prose w-full max-w-2xl space-y-3 rounded-2xl border border-dls-border bg-dls-surface px-4 py-3"
        data-openwork-automation-proposal data-automation-created={created ?? undefined} data-automation-model-resolution={resolved?.resolution}>
        <div className="flex items-start gap-2.5">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-dls-secondary" aria-hidden="true" />
          <h3 className="min-w-0 flex-1 break-words text-sm font-medium text-dls-primary">{proposal.name}</h3>
          <span className="shrink-0 text-xs text-dls-secondary">{created ? "On" : reason ? "Can't turn on yet" : "Draft"}</span>
        </div>
        <div className="space-y-1 text-sm text-dls-secondary">
          <p className="text-dls-primary">{formatAutomationSchedule(proposal.schedule)}</p>
          <p>{where}</p>
          <p className="whitespace-pre-wrap break-words pt-1">{proposal.instructions}</p>
        </div>
        {placementPicker || modelLabel || (pinnedWorkspaceId && placement === "desktop") ? (
          <details className="group/review">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded text-sm text-dls-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 group-open/review:rotate-90" aria-hidden="true" />Details
            </summary>
            <div className="space-y-2 pt-2 text-xs text-dls-secondary">
              {placementPicker}
              {modelLabel ? <p>Model: {modelLabel}</p> : null}
              {pinnedWorkspaceId && placement === "desktop" ? <p data-automation-pinned-workspace={pinnedWorkspaceId}>Uses this workspace</p> : null}
            </div>
          </details>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-dls-border pt-3">
          {!created && reason ? <p role="status" className="min-w-0 flex-1 text-xs text-dls-secondary">{reason}</p> : null}
          {created ? (
            <Button type="button" variant="outline" size="sm" className="ml-auto" data-open-automation={created} onClick={openCreated}>Open Automation</Button>
          ) : (
            <Button type="button" size="sm" className="ml-auto" disabled={createDisabled} data-create-automation onClick={() => void create()}>
              {busy ? "Turning on…" : "Create and turn on"}
            </Button>
          )}
        </div>
      </div>
    )
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
              ? placement === "cloud"
                ? "It runs on the schedule below in OpenWork Cloud."
                : "It runs on the schedule below while this desktop is connected."
              : "Nothing was created yet. Review it, then create it if it looks right."}
          </p>
        </div>
      </div>

      <div className="space-y-3 px-4 py-3">
        <div>
          <p className="truncate text-sm font-medium text-dls-primary" title={proposal.name}>{proposal.name}</p>
          <p className="text-xs text-dls-secondary">{formatAutomationSchedule(proposal.schedule)}</p>
          {modelLabel ? <p className="text-xs text-dls-secondary">Runs with {modelLabel}</p> : null}
          {pinnedWorkspaceId && placement === "desktop" ? <p className="text-xs text-dls-secondary" data-automation-pinned-workspace={pinnedWorkspaceId}>Runs in this workspace</p> : null}
        </div>
        <p className="whitespace-pre-wrap text-sm text-dls-secondary">{proposal.instructions}</p>
        {!created && canUseChoices.length > 1 ? (
          <div className="flex flex-wrap items-center gap-2" role="radiogroup" aria-label="Where it runs" data-automation-placement-choice={placement} data-automation-can-use={canUse ?? undefined}>
            <span className="text-xs text-dls-secondary">Runs on</span>
            {canUseChoices.map((choice) => (
              <Button
                key={choice}
                type="button"
                size="sm"
                variant={canUse === choice ? "secondary" : "ghost"}
                role="radio"
                aria-checked={canUse === choice}
                disabled={busy || (choice === "computer" && proposal.schedule.kind === "calendar")}
                data-automation-placement={choice}
                onClick={() => setPicked(choice)}
              >
                {choice === "computer" ? "This computer" : choice === "cloud-computer" ? "Cloud computer" : "Cloud, connected accounts only"}
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-dls-border px-4 py-3">
        <p className="min-w-0 flex-1 text-xs text-dls-secondary">
          {blocker ?? (placement === "cloud" ? "Automations run headlessly in OpenWork Cloud." : "Automations run on this desktop while it is connected.")}
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
            disabled={busy || targetsQuery.isLoading || blocker !== null || !resolved || resolved.resolution === "unavailable"}
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
      {resolved?.resolution === "unavailable" && !created ? (
        <div className="flex items-center gap-2 border-t border-dls-border px-4 py-2 text-xs text-amber-11">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">
            The proposed model isn't available for Automations. Choose a supported model in a new proposal or in Automations before creating. No replacement model was selected.
          </span>
        </div>
      ) : null}
    </div>
  )
}
