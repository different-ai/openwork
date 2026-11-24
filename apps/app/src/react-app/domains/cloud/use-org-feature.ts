import { useQuery } from "@tanstack/react-query"

import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"

export type OrgFeatureOptions = {
  desktopOnly?: boolean
  active?: boolean
}

export function useOrgFeatureState(name: string, options: OrgFeatureOptions = {}) {
  const context = useAutomationsDenContext()
  const allowed = options.active !== false && context.ready && Boolean(context.client && context.organizationId)
    && (!options.desktopOnly || isDesktopRuntime())
  const query = useQuery({
    queryKey: ["den", "org-features", context.organizationId],
    queryFn: () => {
      if (!context.client || !context.organizationId) throw new Error("Organization is not ready")
      return context.client.getOrgFeatures(context.organizationId)
    },
    enabled: allowed,
    staleTime: 30_000,
    retry: false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: true,
  })
  const data = !allowed ? false : query.data === undefined ? undefined : query.data[name] === true
  return {
    enabled: data === true,
    data,
    ready: !allowed || !query.isPending,
    resolved: allowed && query.data !== undefined && !query.isError,
    isLoading: allowed && query.isLoading,
    isError: allowed && query.isError,
  }
}

export function useOrgFeature(name: string, options: OrgFeatureOptions = {}): boolean {
  return useOrgFeatureState(name, options).enabled
}
