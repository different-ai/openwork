import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { AutomationExecutionTarget } from "@openwork/types/automations"

import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { useOrgMcpConnections } from "../connections/use-org-mcp-connections"
import { buildConnectorToolIdentities } from "../connections/connector-tool-identity"
import { isOrgMcpConnectionReady } from "../settings/extension-items"
import type { AutomationConnectedAccount } from "./automation-editor"
import type { AutomationProviderCatalog } from "./automation-model-options"
import { automationCloudOptions, automationCloudRunAvailable, automationPlacementChoices } from "./automation-placement"
import { useAutomationModelChoices, type AutomationsDenContext } from "./use-automations"

/**
 * Everything the Automation editor needs to offer where an Automation runs and which model it uses: the places
 * this member can run it, the cloud's options, the accounts a cloud run can use, and the models per place.
 * Shared by the Automations page and the Calendar so both edit with the same choices.
 */
export function useAutomationEditorSetup(
  context: AutomationsDenContext,
  providerCatalog?: AutomationProviderCatalog,
  /** The workspace `providerCatalog` was read from. */
  catalogWorkspaceId?: string | null,
) {
  const { desktop: desktopModels, desktopOtherWorkspace, cloud: cloudModels } = useAutomationModelChoices(context, providerCatalog)
  const targetsQuery = useQuery({
    queryKey: [...context.queryRoot, "execution-targets"],
    queryFn: () => context.client!.listAutomationRunners(context.organizationId!),
    enabled: context.ready,
    // An older Den answers null once and keeps today's fixed placement.
    retry: false,
    refetchInterval: (queryState) => (queryState.state.data === null ? false : 60_000),
  })
  const placementChoices = automationPlacementChoices({ targets: targetsQuery.data, desktopRuntime: isDesktopRuntime() })
  const cloudRunAvailable = automationCloudRunAvailable(targetsQuery.data)
  const cloudOptions = automationCloudOptions(targetsQuery.data)
  // The accounts a cloud run can use, shown on the choice that uses only them.
  const orgConnections = useOrgMcpConnections()
  const connectedAccounts = useMemo((): AutomationConnectedAccount[] => buildConnectorToolIdentities({
    mcpServers: [],
    orgConnections: orgConnections.connections.filter(isOrgMcpConnectionReady),
  }).flatMap((identity) => identity.connectionId ? [{ id: identity.connectionId, name: identity.name, iconUrl: identity.iconUrl }] : []), [orgConnections.connections])
  const modelsByPlacement = useMemo(() => ({ desktop: desktopModels, cloud: cloudModels }), [cloudModels, desktopModels])
  const otherWorkspaceModelsByPlacement = useMemo(() => ({ desktop: desktopOtherWorkspace, cloud: cloudModels }), [cloudModels, desktopOtherWorkspace])
  /** The models per place for an Automation pinned to `workspaceId`; this runtime's catalog applies only to its own workspace. */
  const modelsByPlacementFor = (workspaceId?: string | null) => {
    const pinned = workspaceId?.trim()
    const current = catalogWorkspaceId?.trim()
    return pinned && current && pinned !== current ? otherWorkspaceModelsByPlacement : modelsByPlacement
  }
  const modelsFor = (target: AutomationExecutionTarget, workspaceId?: string | null) => modelsByPlacementFor(workspaceId)[target]
  return { targetsQuery, placementChoices, cloudRunAvailable, cloudOptions, connectedAccounts, modelsByPlacement, modelsByPlacementFor, modelsFor }
}

/** Where an Automation can be moved while editing: where it runs now is always a choice, so one whose place went away can still move. */
export function automationEditChoices(current: AutomationExecutionTarget, placementChoices: readonly AutomationExecutionTarget[]) {
  return placementChoices.length > 0 ? [...new Set([current, ...placementChoices])] : []
}
