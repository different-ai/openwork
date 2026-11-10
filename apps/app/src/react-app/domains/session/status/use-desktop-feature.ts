import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useOrgFeatureState } from "@/react-app/domains/cloud/use-org-feature"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"

const FEATURE_STALE_MS = 30_000

/** Deployment-only even when signed in: pre-login capabilities cannot use an org override. */
export function useDeploymentFeature(key: "remoteDesktopDeviceLogin"): boolean {
  const settings = readDenSettings()
  const { baseUrl, apiBaseUrl } = settings
  const client = useMemo(() => createDenClient({ baseUrl, apiBaseUrl }), [baseUrl, apiBaseUrl])
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl, apiBaseUrl],
    queryFn: () => client.getDeploymentFeatures(),
    staleTime: FEATURE_STALE_MS,
    refetchInterval: FEATURE_STALE_MS,
    refetchIntervalInBackground: true,
    retry: false,
    select: (features) => features[key] === true,
  })
  return !deployment.isError && deployment.data === true
}

type DesktopFeatureKey = "claudeAgentProvider" | "computerUse" | "computerSessionHistory" | "remoteComputers" | "settledSessions" | "composerBackgroundTasks" | "agentQuestions" | "standardCodeMode" | "parallelComputerUse" | "steadyLiveTurn" | "plainFreeModel" | "remoteDevices" | "remoteSessionAccess"

/**
 * Reads one desktop feature from the registry. Signed in, it follows the
 * active organization through the shared org-feature hook; signed out, the
 * deployment switch (`GET /v1/features`). Unreachable or missing means off.
 */
export function useDesktopFeature(key: DesktopFeatureKey): boolean {
  const denAuth = useDenAuth()
  const context = useAutomationsDenContext()
  const baseUrl = readDenSettings().baseUrl
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl])
  // Not desktopOnly: the web app shows the cloud computer from these flags too.
  const organization = useOrgFeatureState(key)
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => deploymentClient.getDeploymentFeatures(),
    enabled: !context.ready && denAuth.status === "signed_out",
    staleTime: FEATURE_STALE_MS,
    refetchInterval: FEATURE_STALE_MS,
    refetchIntervalInBackground: true,
    retry: false,
    select: (features) => features[key] === true,
  })
  return context.ready ? organization.enabled : denAuth.status === "signed_out" && !deployment.isError && deployment.data === true
}
