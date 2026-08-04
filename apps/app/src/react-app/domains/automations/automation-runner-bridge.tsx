/** @jsxImportSource react */
import { useEffect } from "react"

import { createDenClient, readDenSettings } from "@/app/lib/den"
import { denSettingsChangedEvent } from "@/app/lib/den-session-events"
import { isDesktopRuntime } from "@/app/utils"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"

const RUNNER_TOKEN_REFRESH_MS = 5 * 60_000
const RUNNER_ID_KEY = "openwork.automations.desktop-runner-id"

function desktopRunnerId() {
  const existing = localStorage.getItem(RUNNER_ID_KEY)?.trim()
  if (existing) return existing
  const created = crypto.randomUUID()
  localStorage.setItem(RUNNER_ID_KEY, created)
  return created
}

/** Keeps this signed-in, preview-enabled desktop registered as the owner's Automation runner. */
export function AutomationRunnerBridge({ enabled }: { enabled: boolean }) {
  const { status } = useDenAuth()

  useEffect(() => {
    if (!isDesktopRuntime() || !window.__OPENWORK_ELECTRON__?.invokeDesktop) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const disconnect = () => window.__OPENWORK_ELECTRON__?.invokeDesktop?.("automationRunnerConfigure", null)
      .catch(() => undefined)
    const connect = async () => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      if (disposed || !enabled || status !== "signed_in") {
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
        const runnerId = desktopRunnerId()
        const build = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("appBuildInfo")
        const agent = navigator.userAgent
        const platform = /Mac/i.test(agent) ? "darwin" : /Win/i.test(agent) ? "win32" : "linux"
        const runner = await client.mintAutomationRunnerToken(organizationId, {
          runnerId,
          protocolVersion: 1,
          supportedExecutionTargets: ["desktop"],
          appVersion: String(build?.version ?? "unknown"),
          platform,
          concurrency: 1,
        })
        if (disposed) return
        await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("automationRunnerConfigure", {
          baseUrl: client.baseUrls.apiBaseUrl,
          token: runner.token,
          runnerId,
        })
      } catch (error) {
        console.warn("[automation-runner] registration failed", error)
      } finally {
        if (!disposed) timer = setTimeout(() => void connect(), RUNNER_TOKEN_REFRESH_MS)
      }
    }

    const handleSettingsChanged = () => void connect()
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged)
    void connect()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged)
      void disconnect()
    }
  }, [enabled, status])

  return null
}
