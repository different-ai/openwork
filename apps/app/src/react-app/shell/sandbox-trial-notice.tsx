import { useQuery } from "@tanstack/react-query"
import { EndedSandboxNotice } from "@openwork/ui/sandbox-trial-notice"
import { useAutomationsDenContext } from "../domains/automations/use-automations"
import { useDenAuth } from "../domains/cloud/den-auth-provider"
import { useOrgFeature } from "../domains/cloud/use-org-feature"

export function SandboxTrialNotice() {
  const { client, organizationId, ready } = useAutomationsDenContext()
  const { verifiedIdentity } = useDenAuth()
  const flag = useOrgFeature("endedSandboxNotice")
  const enabled = flag && ready && Boolean(organizationId && verifiedIdentity?.organizationId === organizationId)
  const query = useQuery({
    queryKey: ["sandbox-status", verifiedIdentity?.principalId, organizationId],
    enabled,
    queryFn: ({ signal }) => {
      if (!client || !organizationId) throw new Error("Organization is unavailable")
      return client.getSandboxStatus(organizationId, signal)
    },
    refetchInterval: query => query.state.data === null ? false : 60_000,
    staleTime: 30_000,
    retry: false,
  })
  return <EndedSandboxNotice state={enabled && !query.isError ? query.data : null} className="shrink-0 border-b border-border bg-muted px-4 py-2 text-sm text-foreground" />
}
