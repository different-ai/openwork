import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"

const FEATURE_STALE_MS = 30_000

type DesktopFeatureKey = "computerUse" | "browserFloatingView" | "remoteComputers"

/**
 * Reads one desktop feature from the registry. Signed in, it follows the
 * active organization (`GET /v1/org` features); signed out, the deployment
 * switch (`GET /v1/features`). Unreachable or missing means off.
 */
export function useDesktopFeature(key: DesktopFeatureKey): boolean {
  const denAuth = useDenAuth()
  const context = useAutomationsDenContext()
  const baseUrl = readDenSettings().baseUrl
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl])
  const organization = useQuery({
    // Shares the cache with the other organization feature reads.
    queryKey: ["den", "org-features", baseUrl, context.organizationId],
    queryFn: (): Promise<Record<string, boolean>> => context.client && context.organizationId
      ? context.client.getOrgFeatures(context.organizationId)
      : Promise.resolve({}),
    enabled: context.ready,
    staleTime: FEATURE_STALE_MS,
    refetchInterval: FEATURE_STALE_MS,
    refetchIntervalInBackground: true,
    retry: false,
    select: (features) => features[key] === true,
  })
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
  return context.ready ? !organization.isError && organization.data === true : denAuth.status === "signed_out" && !deployment.isError && deployment.data === true
}
