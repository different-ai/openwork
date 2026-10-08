import { useCallback, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { AutomationRun } from "@openwork/types/automations"

import { createDenClient, DenApiError, readDenSettings, type DenClient } from "@/app/lib/den"
import { toast } from "@/components/ui/sonner"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider"
import { AUTOMATION_FREE_MODEL } from "@openwork/types/automations"
import { dispatchAutomationsStateChanged } from "./automation-events"
import { automationModelOptions, type AutomationProviderCatalog } from "./automation-model-options"

/**
 * Den access, queries and actions shared by the Automations page and the
 * Calendar. Both read the same TanStack Query cache, so an action taken in
 * one refreshes the other.
 */

export const ACTIVE_RUN_STATUSES = new Set<AutomationRun["status"]>(["queued", "claimed", "running"])
export const AUTOMATIONS_FAST_POLL_MS = 10_000
export const AUTOMATIONS_SLOW_POLL_MS = 60_000

export function describeAutomationError(error: unknown) {
  if (error instanceof DenApiError) {
    if (error.status === 401 || error.status === 403) return "Sign in to the selected Den organization to access Automations."
    if (error.status === 404) return "This Automation is no longer available."
    return error.message
  }
  return error instanceof Error ? error.message : "Automations could not be loaded."
}

export type AutomationsDenContext = {
  client: DenClient | null
  organizationId: string | null
  /** Signed in with a client and an active organization. */
  ready: boolean
  queryRoot: readonly ["den", "automations", string | null]
}

export function useAutomationsDenContext(): AutomationsDenContext {
  const denAuth = useDenAuth()
  const settings = readDenSettings()
  const organizationId = settings.activeOrgId?.trim() || null
  const token = settings.authToken?.trim() || null
  const client = useMemo(
    () => token ? createDenClient({ baseUrl: settings.baseUrl, token }) : null,
    [settings.baseUrl, token],
  )
  const queryRoot = useMemo(() => ["den", "automations", organizationId] as const, [organizationId])
  return { client, organizationId, ready: denAuth.isSignedIn && Boolean(client && organizationId), queryRoot }
}

export function useAutomationListQuery(context: AutomationsDenContext) {
  return useQuery({
    queryKey: [...context.queryRoot, "list"],
    queryFn: () => context.client!.listAutomations(context.organizationId!, { limit: 100 }),
    enabled: context.ready,
    refetchInterval: AUTOMATIONS_SLOW_POLL_MS,
  })
}

export function useAutomationDetailQuery(context: AutomationsDenContext, automationId: string | null) {
  return useQuery({
    queryKey: [...context.queryRoot, "detail", automationId],
    queryFn: () => context.client!.getAutomation(context.organizationId!, automationId!),
    enabled: context.ready && Boolean(automationId),
  })
}

export function useAutomationRunsQuery(context: AutomationsDenContext, automationId: string | null) {
  return useQuery({
    queryKey: [...context.queryRoot, "runs", automationId],
    queryFn: () => context.client!.listAutomationRuns(context.organizationId!, automationId!, { limit: 100 }),
    enabled: context.ready && Boolean(automationId),
    refetchInterval: (queryState) => queryState.state.data?.items.some((run) => ACTIVE_RUN_STATUSES.has(run.status))
      ? AUTOMATIONS_FAST_POLL_MS
      : AUTOMATIONS_SLOW_POLL_MS,
  })
}

/**
 * Runs one Automation action at a time with the shared busy state, refreshes
 * every Automation query on success, and reports the outcome as a toast.
 */
export function useAutomationActions(context: AutomationsDenContext) {
  const queryClient = useQueryClient()
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: context.queryRoot })
    dispatchAutomationsStateChanged()
  }, [context.queryRoot, queryClient])
  const act = useCallback(async (key: string, action: () => Promise<void>, success: string) => {
    setBusyAction(key)
    try {
      await action()
      await refresh()
      toast.success(success)
      return true
    } catch (error) {
      toast.error(describeAutomationError(error))
      return false
    } finally {
      setBusyAction(null)
    }
  }, [refresh])
  return { busyAction, setBusyAction, refresh, act }
}

/**
 * The models an Automation can use, per placement, the same way the editor offers them: the organization's
 * providers, plus the free Zen starter on desktops where policy and the local runtime allow it.
 */
export function useAutomationModelChoices(context: AutomationsDenContext, providerCatalog?: AutomationProviderCatalog) {
  const zenModelRestricted = useDesktopRestriction("allowZenModel")
  const freeStarterInRuntime = providerCatalog === undefined || Boolean(
    providerCatalog[AUTOMATION_FREE_MODEL.providerId]?.[AUTOMATION_FREE_MODEL.modelId],
  )
  const providersQuery = useQuery({
    queryKey: [...context.queryRoot, "models"],
    queryFn: () => context.client!.listOrgLlmProviders(context.organizationId!),
    enabled: context.ready,
  })
  const desktop = useMemo(
    () => automationModelOptions(providersQuery.data ?? [], { includeFreeStarter: !zenModelRestricted && freeStarterInRuntime }),
    [freeStarterInRuntime, providersQuery.data, zenModelRestricted],
  )
  const cloud = useMemo(() => automationModelOptions(providersQuery.data ?? [], { includeFreeStarter: false }), [providersQuery.data])
  return { desktop, cloud, providersQuery }
}
