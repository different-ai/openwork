/** @jsxImportSource react */
import { useEffect } from "react"
import { AUTOMATION_MODEL_ATTENTION_CAPABILITY } from "@openwork/types/automations"

import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den"
import { denSettingsChangedEvent } from "@/app/lib/den-session-events"
import { isDesktopRuntime } from "@/app/utils"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { createAutomationRunnerConnectCoordinator } from "./automation-runner-connect-coordinator"

const RUNNER_TOKEN_REFRESH_MS = 5 * 60_000
const RUNNER_ID_KEY = "openwork.automations.desktop-runner-id"

function desktopRunnerId() {
  const existing = localStorage.getItem(RUNNER_ID_KEY)?.trim()
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(RUNNER_ID_KEY, created)
  return created
}

function resetDesktopRunnerId() {
  localStorage.removeItem(RUNNER_ID_KEY)
  return desktopRunnerId()
}

/** Keeps this signed-in, preview-enabled desktop registered as the owner's Automation runner. */
export function AutomationRunnerBridge({ enabled }: { enabled: boolean }) {
  const { status } = useDenAuth()

  useEffect(() => {
    if (!isDesktopRuntime() || !window.__OPENWORK_ELECTRON__?.invokeDesktop) return

    const disconnect = () => window.__OPENWORK_ELECTRON__?.invokeDesktop?.("automationRunnerConfigure", null)
      .catch(() => undefined)
    const coordinator = createAutomationRunnerConnectCoordinator({
      refreshMs: RUNNER_TOKEN_REFRESH_MS,
      connect: async (isCurrent) => {
        if (!enabled || status !== "signed_in") {
          await disconnect()
          return
        }
        const settings = readDenSettings()
        const authToken = settings.authToken?.trim() ?? ""
        const organizationId = settings.activeOrgId?.trim() ?? ""
        if (!authToken || !organizationId) {
          await disconnect()
          return
        }
        try {
          const client = createDenClient({ baseUrl: settings.baseUrl, token: authToken })
          let runnerId = desktopRunnerId()
          const build = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("appBuildInfo")
          if (!isCurrent()) return
          const agent = navigator.userAgent
          const platform = /Mac/i.test(agent) ? "darwin" : /Win/i.test(agent) ? "win32" : "linux"
          let runner: Awaited<ReturnType<typeof client.mintAutomationRunnerToken>>
          try {
            runner = await client.mintAutomationRunnerToken(organizationId, {
              runnerId,
              protocolVersion: 1,
              supportedExecutionTargets: ["desktop"],
              capabilities: [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
              appVersion: String(build?.version ?? "unknown"),
              platform,
              concurrency: 1,
            })
          } catch (error) {
            if (!(error instanceof DenApiError) || error.status !== 409 || error.code !== "automation_runner_identity_conflict") {
              throw error
            }
            if (!isCurrent()) return
            runnerId = resetDesktopRunnerId()
            runner = await client.mintAutomationRunnerToken(organizationId, {
              runnerId,
              protocolVersion: 1,
              supportedExecutionTargets: ["desktop"],
              capabilities: [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
              appVersion: String(build?.version ?? "unknown"),
              platform,
              concurrency: 1,
            })
          }
          if (!isCurrent()) return
          await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("automationRunnerConfigure", {
            baseUrl: client.baseUrls.apiBaseUrl,
            token: runner.token,
            runnerId,
          })
        } catch (error) {
          if (isCurrent()) console.warn("[automation-runner] registration failed", error)
        }
      },
    })

    const requestConnect = () => void coordinator.request().catch(() => undefined)
    const handleSettingsChanged = () => requestConnect()
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged)
    const unsubscribeCredentialRejected = window.__OPENWORK_ELECTRON__.automationRunner
      ?.onCredentialRejected?.(() => coordinator.credentialRejected())
    requestConnect()
    return () => {
      coordinator.dispose()
      unsubscribeCredentialRejected?.()
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged)
      void disconnect()
    }
  }, [enabled, status])

  return null
}
