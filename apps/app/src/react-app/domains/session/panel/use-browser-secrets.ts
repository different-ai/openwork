import { useQuery } from "@tanstack/react-query"

import { desktopBridge } from "@/app/lib/desktop"
import { isElectronRuntime } from "@/app/lib/runtime-env"

import { useDesktopFeature } from "../status/use-desktop-feature"

const RETRY_MS = 30_000

export const browserSecretsListKey = (sessionId: string) => ["desktop", "browser-secrets", "list", sessionId]

export function useBrowserSecretsReport(requested: boolean): boolean {
  const reported = useQuery({
    queryKey: ["desktop", "browser-secrets", "enabled", requested],
    queryFn: () => desktopBridge.browserSecretsSetEnabled(requested),
    enabled: isElectronRuntime(),
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) => requested && query.state.data !== true ? RETRY_MS : false,
  })
  return requested && reported.data === true
}

export function useBrowserSecretsEnabled(): boolean {
  return useBrowserSecretsReport(useDesktopFeature("browserSecretHandles"))
}
