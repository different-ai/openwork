import { useQuery } from "@tanstack/react-query"

import { isDesktopRuntime } from "@/app/lib/runtime-env"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"

export type OrgFeatureOptions = {
  desktopOnly?: boolean
  active?: boolean
}

/** Shared query and guarded state for surfaces that also need loading/error information. */
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
  // `enabled: false` stops fetching, not cache reads. Always guard the value too.
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

/** Missing, signed-out, inactive or wrong-runtime features are off, even in a populated cache. */
export function useOrgFeature(name: string, options: OrgFeatureOptions = {}): boolean {
  return useOrgFeatureState(name, options).enabled
}
