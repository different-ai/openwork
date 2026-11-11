/** @jsxImportSource react */
import { useEffect } from "react"
import {
  AUTOMATION_MODEL_ATTENTION_CAPABILITY,
  REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY,
  REMOTE_SESSION_ANSWER_RUNNER_CAPABILITY,
  REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
  REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
  REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY,
  REMOTE_SESSION_ONLY_RUNNER_CAPABILITY,
} from "@openwork/types/automations"
import type {
  AutomationDesktopRunnerCapability,
  AutomationDesktopRunnerRegistration,
} from "@openwork/types/automations"

import { createDenClient, DenApiError, readDenSettings } from "@/app/lib/den"
import { denSettingsChangedEvent } from "@/app/lib/den-session-events"
import { isDesktopRuntime } from "@/app/utils"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useEnterpriseActivationRequired } from "@/react-app/domains/cloud/enterprise-activation-gate"
import { useDesktopAutomationsEnabled } from "./automation-availability"
import { createAutomationRunnerConnectCoordinator } from "./automation-runner-connect-coordinator"
import { desktopRunnerId, organizationRunnerId } from "./automation-runner-identity"

const RUNNER_TOKEN_REFRESH_MS = 30 * 60_000

/** Keeps this signed-in desktop registered as the owner's Automation runner when Den allows it. */
export function AutomationRunnerBridge() {
  if (useEnterpriseActivationRequired()) return null
  return <ActivatedAutomationRunnerBridge />
}

function ActivatedAutomationRunnerBridge() {
  const { status } = useDenAuth()
  const deploymentEnabled = useDesktopAutomationsEnabled()

  useEffect(() => {
    if (!isDesktopRuntime() || !window.__OPENWORK_ELECTRON__?.invokeDesktop) return

    const disconnect = () => window.__OPENWORK_ELECTRON__?.invokeDesktop?.("automationRunnerConfigure", null)
      .catch(() => undefined)
    const coordinator = createAutomationRunnerConnectCoordinator({
      refreshMs: RUNNER_TOKEN_REFRESH_MS,
      connect: async (isCurrent) => {
        if (status !== "signed_in") {
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
          const mintToken = deploymentEnabled ? client.mintAutomationRunnerToken : client.mintSessionRunnerToken
          const mintRunner = async (id: string) => {
            const registration = (
              capabilities: AutomationDesktopRunnerCapability[],
            ): AutomationDesktopRunnerRegistration => ({
              runnerId: id,
              protocolVersion: 1,
              supportedExecutionTargets: ["desktop"],
              capabilities,
              appVersion: String(build?.version ?? "unknown"),
              platform,
              concurrency: 1,
            })
            // Older/self-hosted Den versions reject capabilities they do not
            // know with a 400. Step down one capability set at a time so
            // Automation delivery keeps working until that server upgrades.
            const recoveryCapabilities: AutomationDesktopRunnerCapability[] = [
              AUTOMATION_MODEL_ATTENTION_CAPABILITY,
              REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
              REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
              REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY,
            ]
            // Den sends answer requests only to runners that say they take them,
            // and lets other devices open sessions started here only on runners
            // that honour the owner's session access choice. Released Dens take
            // at most five capabilities, so the sets they accept today follow.
            const answerCapabilities: AutomationDesktopRunnerCapability[] = [
              ...recoveryCapabilities,
              REMOTE_SESSION_ANSWER_RUNNER_CAPABILITY,
            ]
            const sessionOnlyCapabilities: AutomationDesktopRunnerCapability[] = [
              REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
              REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
              REMOTE_SESSION_RECOVERY_RUNNER_CAPABILITY,
              REMOTE_SESSION_ONLY_RUNNER_CAPABILITY,
            ]
            const capabilitySets: AutomationDesktopRunnerCapability[][] = deploymentEnabled ? [
              [...answerCapabilities, REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY],
              answerCapabilities,
              recoveryCapabilities,
              [
                AUTOMATION_MODEL_ATTENTION_CAPABILITY,
                REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY,
                REMOTE_SESSION_CONTROL_RUNNER_CAPABILITY,
              ],
              [AUTOMATION_MODEL_ATTENTION_CAPABILITY, REMOTE_SESSION_DESKTOP_RUNNER_CAPABILITY],
              [AUTOMATION_MODEL_ATTENTION_CAPABILITY],
            ] : [
              [...sessionOnlyCapabilities, REMOTE_SESSION_ANSWER_RUNNER_CAPABILITY, REMOTE_SESSION_ACCESS_RUNNER_CAPABILITY],
              [...sessionOnlyCapabilities, REMOTE_SESSION_ANSWER_RUNNER_CAPABILITY],
              sessionOnlyCapabilities,
            ]
            for (const [index, capabilities] of capabilitySets.entries()) {
              try {
                return await mintToken(organizationId, registration(capabilities))
              } catch (error) {
                const last = index === capabilitySets.length - 1
                if (last || !(error instanceof DenApiError) || error.status !== 400) throw error
              }
            }
            throw new Error("automation_runner_registration_unreachable")
          }
          let runner: Awaited<ReturnType<typeof client.mintAutomationRunnerToken>>
          try {
            runner = await mintRunner(runnerId)
          } catch (error) {
            // An older Den answers 404 for remote session targets when that
            // organization never had them turned on (or the route predates
            // them). Nothing to connect: wait for the next refresh quietly
            // instead of retrying every few seconds.
            if (!deploymentEnabled && error instanceof DenApiError && error.status === 404) {
              if (!isCurrent()) return
              await disconnect()
              return
            }
            if (!(error instanceof DenApiError) || error.status !== 409 || error.code !== "automation_runner_identity_conflict") {
              throw error
            }
            if (!isCurrent()) return
            // Only a Den from before runner rows were scoped refuses an install
            // already registered in another organization. Use an id derived
            // for this organization rather than replacing the install's id,
            // which left a stale runner behind on every switch.
            runnerId = organizationRunnerId(runnerId, organizationId)
            runner = await mintRunner(runnerId)
          }
          if (!isCurrent()) return
          await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("automationRunnerConfigure", {
            baseUrl: client.baseUrls.apiBaseUrl,
            token: runner.token,
            runnerId,
          })
        } catch (error) {
          if (isCurrent()) console.warn("[automation-runner] registration failed", error)
          throw error
        }
      },
    })

    const requestConnect = () => void coordinator.request().catch(() => undefined)
    const handleSettingsChanged = () => requestConnect()
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged)
    // Rejoining a network mints a fresh credential immediately instead of
    // leaving this desktop unreachable until the next refresh, which is long
    // enough for a scheduled occurrence to come due and be missed.
    window.addEventListener("online", handleSettingsChanged)
    const unsubscribeCredentialRejected = window.__OPENWORK_ELECTRON__.automationRunner
      ?.onCredentialRejected?.(() => coordinator.credentialRejected())
    requestConnect()
    return () => {
      coordinator.dispose()
      unsubscribeCredentialRejected?.()
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged)
      window.removeEventListener("online", handleSettingsChanged)
      void disconnect()
    }
  }, [deploymentEnabled, status])

  return null
}
