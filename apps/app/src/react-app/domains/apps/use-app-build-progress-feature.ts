import { useEffect, useMemo, useSyncExternalStore } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"

const FEATURE_STALE_MS = 5 * 60_000

// Read once by the session shell; chat steps read it without needing the
// Den providers, so they render the same anywhere a transcript is shown.
let enabled = false
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Whether the staged App build checklist is on; off until the shell has read it. */
export function useAppBuildProgressEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => false)
}

/**
 * Whether `appBuildProgress` is on: the staged checklist while an agent
 * builds an App. Signed in, it follows the active organization (`GET /v1/org`
 * features); signed out, the deployment switch (`GET /v1/features`).
 * Unreachable or missing means off, which keeps the one-line step.
 */
export function useAppBuildProgressFeature(): void {
  const denAuth = useDenAuth()
  const context = useAutomationsDenContext()
  const baseUrl = readDenSettings().baseUrl
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl])
  const organization = useOrgFeature("appBuildProgress")
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => deploymentClient.getDeploymentFeatures(),
    enabled: !context.ready && denAuth.status === "signed_out",
    staleTime: FEATURE_STALE_MS,
    retry: false,
    select: (features) => features.appBuildProgress === true,
  })
  const on = context.ready ? organization : denAuth.status === "signed_out" && deployment.data === true
  useEffect(() => {
    if (enabled === on) return
    enabled = on
    for (const listener of listeners) listener()
  }, [on])
}
