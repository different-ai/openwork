/** @jsxImportSource react */
import { useEffect, useReducer } from "react"
import { useQueryClient } from "@tanstack/react-query"

import { readDenSettings } from "@/app/lib/den"
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events"
import { desktopBridge } from "@/app/lib/desktop"
import { desktopRunnerId } from "@/react-app/domains/automations/automation-runner-identity"
import { useAutomationsDenContext } from "@/react-app/domains/automations/use-automations"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { denSignInKey, markThisComputerDisconnected, useThisComputerDisconnected } from "./computer-connection-store"
import { DEVICE_REPORT_POLL_MS, createDeviceReporter, deviceReportFailure, type DeviceReportOutcome } from "./device-report"
import { useThisDeviceStore } from "./this-device-store"
import { remoteDevicesQueryKey } from "./use-remote-devices"

export function DeviceReporter({ computersEnabled }: { computersEnabled: boolean }) {
  const context = useAutomationsDenContext()
  const { refresh: checkSignIn } = useDenAuth()
  const disconnected = useThisComputerDisconnected()
  const queryClient = useQueryClient()
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
    if (!active || !client || !organizationId || disconnected) return
    const signIn = denSignInKey(readDenSettings())
    const reporter = createDeviceReporter({
      computersEnabled,
      readIdentity: () => desktopBridge.desktopDeviceIdentity(),
      readSnapshot: () => desktopBridge.computerDevices(),
      fallbackInstallId: desktopRunnerId,
      send: async (report): Promise<DeviceReportOutcome> => {
        try {
          const response = await client.reportThisComputer(organizationId, report)
          return { kind: "sent", deviceId: response.device.id, reportAfterSeconds: response.reportAfterSeconds }
        } catch (error) {
          return deviceReportFailure(error)
        }
      },
      onDisconnected: () => {
        markThisComputerDisconnected(signIn)
        void checkSignIn()
      },
      onSignInRefused: () => { void checkSignIn() },
      onReported: (deviceId) => {
        const known = useThisDeviceStore.getState().deviceIds[organizationId]
        useThisDeviceStore.getState().setDeviceId(organizationId, deviceId)
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
  }, [active, checkSignIn, client, computersEnabled, disconnected, organizationId, queryClient])
  return null
}
