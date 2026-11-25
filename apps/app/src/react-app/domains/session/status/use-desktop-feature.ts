import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useOrgFeatureState } from "@/react-app/domains/cloud/use-org-feature"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"

const FEATURE_STALE_MS = 30_000

type DesktopFeatureKey = "remoteComputers" | "questionMinimize" | "questionInThread" | "importOpencodeConnections" | "lowStorageWarning" | "sessionTree" | "sideChatFromSelection" | "sideQuestions" | "providerFilterSyncFix" | "browserSecretHandles" | "officeOutlinePreview" | "composerInlineSuggestions" | "desktopLibraryModels"

export function useDesktopFeature(key: DesktopFeatureKey): boolean {
  const denAuth = useDenAuth()
  const context = useAutomationsDenContext()
  const baseUrl = readDenSettings().baseUrl
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl])
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
