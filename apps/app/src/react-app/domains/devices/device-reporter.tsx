/** @jsxImportSource react */
import { useEffect, useReducer } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { DenApiError } from "@/app/lib/den"
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events"
import { desktopBridge } from "@/app/lib/desktop"
import { isElectronRuntime } from "@/app/lib/runtime-env"
import { desktopRunnerId } from "@/react-app/domains/automations/automation-runner-identity"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { useDesktopFeature } from "@/react-app/domains/session/status/use-desktop-feature"
import { DEVICE_REPORT_POLL_MS, createDeviceReporter, type DeviceReportOutcome } from "./device-report"
import { useThisDeviceStore } from "./this-device-store"
import { remoteDevicesQueryKey } from "./use-remote-devices"

/**
 * Keeps this desktop in its organization's devices list (`remoteDevices`):
 * who it is and how its computer use is doing, at launch, when that changes
 * and every few minutes. Mounted once per window. With the feature off, or
 * signed out, it calls nothing: no desktop command and no request to Den.
 */
export function DeviceReporter() {
  const enabled = useDesktopFeature("remoteDevices")
  return enabled && isElectronRuntime() ? <ActiveDeviceReporter /> : null
}

function ActiveDeviceReporter() {
  const context = useAutomationsDenContext()
  const queryClient = useQueryClient()
  // The sign-in and the active organization live outside React: look again when they change.
  const [, refresh] = useReducer((count: number) => count + 1, 0)
  useEffect(() => {
    window.addEventListener(denSessionUpdatedEvent, refresh)
    window.addEventListener(denSettingsChangedEvent, refresh)
    return () => {
      window.removeEventListener(denSessionUpdatedEvent, refresh)
      window.removeEventListener(denSettingsChangedEvent, refresh)
    }
  }, [])

  const { client, organizationId } = context
  const active = context.ready
  useEffect(() => {
    if (!active || !client || !organizationId) return
    const reporter = createDeviceReporter({
      readIdentity: () => desktopBridge.desktopDeviceIdentity(),
      readSnapshot: () => desktopBridge.computerDevices(),
      fallbackInstallId: desktopRunnerId,
      send: async (report): Promise<DeviceReportOutcome> => {
        try {
          const response = await client.reportThisComputer(organizationId, report)
          return { kind: "sent", deviceId: response.device.id, reportAfterSeconds: response.reportAfterSeconds }
        } catch (error) {
          if (error instanceof DenApiError && error.status === 429) return { kind: "rate_limited", retryAfterSeconds: error.retryAfterSeconds ?? null }
          if (error instanceof DenApiError && error.status === 404 && error.code === "feature_disabled") return { kind: "feature_off" }
          return { kind: "failed" }
        }
      },
      onReported: (deviceId) => {
        const known = useThisDeviceStore.getState().deviceIds[organizationId]
        useThisDeviceStore.getState().setDeviceId(organizationId, deviceId)
        // First report of this sign-in: an open Devices page shows this computer now.
        if (known !== deviceId) void queryClient.invalidateQueries({ queryKey: remoteDevicesQueryKey(organizationId) })
      },
    })
    reporter.start()
    const check = () => { if (document.visibilityState === "visible") void reporter.check() }
    const timer = window.setInterval(check, DEVICE_REPORT_POLL_MS)
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", check)
    return () => {
      reporter.stop()
      window.clearInterval(timer)
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", check)
    }
  }, [active, client, organizationId, queryClient])
  return null
}
