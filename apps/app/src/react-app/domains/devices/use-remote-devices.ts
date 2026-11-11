import { useEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { RemoteDeviceRegisterRequest } from "@openwork/types/den/remote-devices"

import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events"
import type { AutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { useComputerConnectionStore } from "./computer-connection-store"

const DEVICES_STALE_MS = 30_000
const DEVICES_REFRESH_MS = 60_000

export const remoteDevicesQueryKey = (organizationId: string | null) => ["den", "remote-devices", organizationId] as const

// A new sign-in or Den host must not reuse another member's cached inventory,
// even when the organization id is unchanged. Never put credentials in keys.
const clientScopes = new WeakMap<object, number>()
let nextClientScope = 0
export function remoteDevicesContextQueryKey(context: AutomationsDenContext) {
  const client = context.client
  if (client && !clientScopes.has(client)) clientScopes.set(client, ++nextClientScope)
  return [...remoteDevicesQueryKey(context.organizationId), client ? clientScopes.get(client)! : null] as const
}

function ready(context: AutomationsDenContext) {
  if (!context.client || !context.organizationId) throw new Error("Sign in to your organization first.")
  return { client: context.client, organizationId: context.organizationId }
}

/** The member's computers. Refreshes every minute while the page is visible, on focus and when the sign-in changes. */
export function useRemoteDevicesQuery(context: AutomationsDenContext, enabled: boolean) {
  const queryClient = useQueryClient()
  const active = enabled && context.ready
  const organizationId = context.organizationId
  useEffect(() => {
    if (!active) return
    const queryKey = remoteDevicesContextQueryKey(context)
    const refresh = () => { void queryClient.invalidateQueries({ queryKey }) }
    // The query client follows page visibility; a window coming back to the front counts too.
    const focus = () => { if (document.visibilityState === "visible") void queryClient.refetchQueries({ queryKey, exact: true, stale: true }) }
    window.addEventListener(denSessionUpdatedEvent, refresh)
    window.addEventListener(denSettingsChangedEvent, refresh)
    window.addEventListener("focus", focus)
    // This computer being disconnected or connected again changes its own row.
    const unsubscribeConnection = useComputerConnectionStore.subscribe(refresh)
    return () => {
      unsubscribeConnection()
      window.removeEventListener(denSessionUpdatedEvent, refresh)
      window.removeEventListener(denSettingsChangedEvent, refresh)
      window.removeEventListener("focus", focus)
    }
  }, [active, organizationId, context.client, queryClient])
  return useQuery({
    queryKey: remoteDevicesContextQueryKey(context),
    queryFn: () => { const { client, organizationId } = ready(context); return client.listRemoteDevices(organizationId) },
    enabled: active,
    staleTime: DEVICES_STALE_MS,
    refetchInterval: DEVICES_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/** One computer's recent activity, read when its row is opened. */
export function useRemoteDeviceDetailQuery(context: AutomationsDenContext, deviceId: string, open: boolean) {
  return useQuery({
    queryKey: [...remoteDevicesContextQueryKey(context), "detail", deviceId],
    queryFn: () => { const { client, organizationId } = ready(context); return client.getRemoteDevice(organizationId, deviceId) },
    enabled: open && context.ready,
    staleTime: DEVICES_STALE_MS,
    retry: false,
  })
}

export function useRemoteDeviceMutations(context: AutomationsDenContext) {
  const queryClient = useQueryClient()
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: remoteDevicesQueryKey(context.organizationId) })
  return {
    register: useMutation({
      mutationFn: (input: RemoteDeviceRegisterRequest) => { const { client, organizationId } = ready(context); return client.registerRemoteDevice(organizationId, input) },
      onSuccess,
    }),
    rename: useMutation({
      mutationFn: (input: { deviceId: string; label: string }) => { const { client, organizationId } = ready(context); return client.renameRemoteDevice(organizationId, input.deviceId, input.label) },
      onSuccess,
    }),
    disconnect: useMutation({
      mutationFn: (deviceId: string) => { const { client, organizationId } = ready(context); return client.disconnectRemoteDevice(organizationId, deviceId) },
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (deviceId: string) => { const { client, organizationId } = ready(context); return client.removeRemoteDevice(organizationId, deviceId) },
      onSuccess,
    }),
  }
}
