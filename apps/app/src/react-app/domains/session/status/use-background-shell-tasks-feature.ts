import { useEffect, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { useOrgFeature } from "@/react-app/domains/cloud/use-org-feature"
import { setBackgroundShellTasksEnabled } from "../sync/session-sync"

const FEATURE_STALE_MS = 5 * 60_000

/**
 * Reads `backgroundShellTasks` and applies it to the session sync and chat.
 * Signed in, it follows the active organization (`GET /v1/org` features);
 * signed out, the deployment switch (`GET /v1/features`). Unreachable or
 * missing means off, which keeps the chat exactly as before.
 */
export function useBackgroundShellTasksFeature(): void {
  const denAuth = useDenAuth()
  const context = useAutomationsDenContext()
  const baseUrl = readDenSettings().baseUrl
  const deploymentClient = useMemo(() => createDenClient({ baseUrl }), [baseUrl])
  const organization = useOrgFeature("backgroundShellTasks")
  const deployment = useQuery({
    queryKey: ["den", "deployment-features", baseUrl],
    queryFn: () => deploymentClient.getDeploymentFeatures(),
    enabled: !context.ready && denAuth.status === "signed_out",
    staleTime: FEATURE_STALE_MS,
    retry: false,
    select: (features) => features.backgroundShellTasks === true,
  })
  const enabled = context.ready ? organization : denAuth.status === "signed_out" && deployment.data === true
  useEffect(() => {
    setBackgroundShellTasksEnabled(enabled)
  }, [enabled])
}
