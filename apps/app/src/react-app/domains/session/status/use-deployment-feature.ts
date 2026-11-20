import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings } from "@/app/lib/den"

const FEATURE_STALE_MS = 30_000

export type DeploymentFeatureSnapshot = { enabled: boolean | undefined; updatedAt: number }

/** Deployment-only; unknown discovery is not evidence that the deployment is off. */
export function useDeploymentFeature(key: "remoteDesktopDeviceLogin"): DeploymentFeatureSnapshot {
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
    select: (features) => typeof features[key] === "boolean" ? features[key] : undefined,
  })
  return { enabled: deployment.isError || deployment.isPending ? undefined : deployment.data, updatedAt: deployment.dataUpdatedAt }
}
