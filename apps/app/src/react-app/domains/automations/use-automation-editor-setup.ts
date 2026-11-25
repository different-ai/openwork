import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { AutomationExecutionTarget } from "@openwork/types/automations"

import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { useOrgMcpConnections } from "../connections/use-org-mcp-connections"
import { buildConnectorToolIdentities } from "../connections/connector-tool-identity"
import { isOrgMcpConnectionReady } from "../settings/extension-items"
import type { AutomationConnectedAccount } from "./automation-editor"
import type { AutomationProviderCatalog } from "./automation-model-options"
import { useDesktopAutomationsEnabled } from "./automation-availability"
import { automationCloudOptions, automationCloudRunAvailable, automationPlacementChoices } from "./automation-placement"
import { useAutomationModelChoices, type AutomationsDenContext } from "./use-automations"

export function useAutomationEditorSetup(
  context: AutomationsDenContext,
  providerCatalog?: AutomationProviderCatalog,
  catalogWorkspaceId?: string | null,
) {
  const { desktop: desktopModels, desktopOtherWorkspace, cloud: cloudModels } = useAutomationModelChoices(context, providerCatalog)
  const targetsQuery = useQuery({
    queryKey: [...context.queryRoot, "execution-targets"],
    queryFn: () => context.client!.listAutomationRunners(context.organizationId!),
    enabled: context.ready,
    retry: false,
    refetchInterval: (queryState) => (queryState.state.data === null ? false : 60_000),
  })
  const desktopAllowed = useDesktopAutomationsEnabled()
  const placementChoices = automationPlacementChoices({ targets: targetsQuery.data, desktopRuntime: isDesktopRuntime(), desktopAllowed })
  const cloudRunAvailable = automationCloudRunAvailable(targetsQuery.data)
  const cloudOptions = automationCloudOptions(targetsQuery.data)
  const orgConnections = useOrgMcpConnections()
  const connectedAccounts = useMemo((): AutomationConnectedAccount[] => buildConnectorToolIdentities({
    mcpServers: [],
    orgConnections: orgConnections.connections.filter(isOrgMcpConnectionReady),
  }).flatMap((identity) => identity.connectionId ? [{ id: identity.connectionId, name: identity.name, iconUrl: identity.iconUrl }] : []), [orgConnections.connections])
  const modelsByPlacement = useMemo(() => ({ desktop: desktopModels, cloud: cloudModels }), [cloudModels, desktopModels])
  const otherWorkspaceModelsByPlacement = useMemo(() => ({ desktop: desktopOtherWorkspace, cloud: cloudModels }), [cloudModels, desktopOtherWorkspace])
  const modelsByPlacementFor = (workspaceId?: string | null) => {
    const pinned = workspaceId?.trim()
    const current = catalogWorkspaceId?.trim()
    return pinned && current && pinned !== current ? otherWorkspaceModelsByPlacement : modelsByPlacement
  }
  const modelsFor = (target: AutomationExecutionTarget, workspaceId?: string | null) => modelsByPlacementFor(workspaceId)[target]
  return { targetsQuery, placementChoices, cloudRunAvailable, cloudOptions, connectedAccounts, modelsByPlacement, modelsByPlacementFor, modelsFor }
}

export function automationEditChoices(current: AutomationExecutionTarget, placementChoices: readonly AutomationExecutionTarget[]) {
  return placementChoices.length > 0 ? [...new Set([current, ...placementChoices])] : []
}
