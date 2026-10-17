import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"

const FEATURE_STALE_MS = 5 * 60_000

/**
 * Whether `offlineRecovery` is on for the current deployment or organization. Signed in, it follows the active organization (`GET /v1/org`
 * features); signed out, the deployment switch (`GET /v1/features`).
 * Missing flags default off; cached flag data survives a temporary outage.
 */
export function useOfflineRecoveryFeature(active: boolean): boolean {
  const denAuth = useDenAuth()
  const context = useAutomationsDenContext()
  const baseUrl = readDenSettings().baseUrl
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl])
  const organization = useOrgFeature("offlineRecovery", { active })
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => deploymentClient.getDeploymentFeatures(),
    enabled: active && !context.ready && denAuth.status === "signed_out",
    staleTime: FEATURE_STALE_MS,
    retry: false,
    select: (features) => features.offlineRecovery === true,
  })
  return active && (context.ready ? organization : denAuth.status === "signed_out" && deployment.data === true)
}
