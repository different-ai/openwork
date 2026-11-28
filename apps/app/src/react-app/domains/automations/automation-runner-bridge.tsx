/** @jsxImportSource react */
import { useEffect, useState } from "react"
import type { AutomationDesktopRunnerCapability, AutomationDesktopRunnerRegistration } from "@openwork/types/automations"
import type { ComputerSharingState } from "@openwork/types/computer-sharing"
import { COMPUTER_DISCONNECTED_ERROR } from "@openwork/types/den/remote-devices"

import { createDenClient, DenApiError, isDenSessionRevokedError, readDenSettings } from "@/app/lib/den"
import { denSettingsChangedEvent, denSessionUpdatedEvent } from "@/app/lib/den-session-events"
import { observeDesktopAutomationLifecycle } from "@/app/lib/analytics"
import { isDesktopRuntime } from "@/app/utils"
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider"
import { useEnterpriseActivationRequired } from "@/react-app/domains/cloud/enterprise-activation-gate"
import {
  denSignInKey,
  markThisComputerConnected,
  markThisComputerDisconnected,
  thisComputerStillDisconnected,
  useComputerConnectionStore,
} from "@/react-app/domains/devices/computer-connection-store"
import { readLocalComputerServer } from "@/react-app/infra/local-computer-server"
import { useDesktopAutomationsEnabled } from "./automation-availability"
import { automationRunnerCapabilitySets } from "./automation-runner-capabilities"
import { createAutomationRunnerConnectCoordinator } from "./automation-runner-connect-coordinator"
import { desktopRunnerId, organizationRunnerId } from "./automation-runner-identity"
import { createComputerRunnerAvailabilityPoller } from "./computer-runner-availability"
import { createComputerRunnerDelivery } from "./computer-runner-delivery"

const RUNNER_TOKEN_REFRESH_MS = 30 * 60_000
const RUNNER_DISCONNECTED_RETRY_MS = 5 * 60_000

export function AutomationRunnerBridge({ computersEnabled }: { computersEnabled: boolean }) {
  if (useEnterpriseActivationRequired()) return null
  return <ActivatedAutomationRunnerBridge computersEnabled={computersEnabled} />
}

function ActivatedAutomationRunnerBridge({ computersEnabled }: { computersEnabled: boolean }) {
  const { status, refresh } = useDenAuth()
  const deploymentEnabled = useDesktopAutomationsEnabled()
  const [delivery] = useState(createComputerRunnerDelivery)

  useEffect(() => {
    if (!isDesktopRuntime() || !window.__OPENWORK_ELECTRON__?.invokeDesktop) return

    let availability: ComputerSharingState["availability"] | undefined
    let currentSignIn = denSignInKey(readDenSettings())
    const clearCredential = () => { if (computersEnabled) void delivery.setCredential(null) }
    const disconnect = () => {
      clearCredential()
      return window.__OPENWORK_ELECTRON__?.invokeDesktop?.("automationRunnerConfigure", null).catch(() => undefined)
    }
    const coordinator = createAutomationRunnerConnectCoordinator({
      refreshMs: RUNNER_TOKEN_REFRESH_MS,
      disconnectedRetryMs: RUNNER_DISCONNECTED_RETRY_MS,
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
        const signIn = denSignInKey(settings)
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
            const capabilitySets = automationRunnerCapabilitySets(deploymentEnabled, computersEnabled, availability)
            for (const [index, capabilities] of capabilitySets.entries()) {
              try {
                return await mintToken(organizationId, registration(capabilities))
              } catch (error) {
                const last = index === capabilitySets.length - 1
                if (!isCurrent() || last || !(error instanceof DenApiError) || error.status !== 400) throw error
              }
            }
            throw new Error("automation_runner_registration_unreachable")
          }
          let runner: Awaited<ReturnType<typeof client.mintAutomationRunnerToken>>
          try {
            runner = await mintRunner(runnerId)
          } catch (error) {
            if (!deploymentEnabled && error instanceof DenApiError && error.status === 404) {
              if (!isCurrent()) return
              await disconnect()
              return
            }
            if (!(error instanceof DenApiError) || error.status !== 409 || error.code !== "automation_runner_identity_conflict") {
              throw error
            }
            if (!isCurrent()) return
            runnerId = organizationRunnerId(runnerId, organizationId)
            runner = await mintRunner(runnerId)
          }
          if (!isCurrent() || (computersEnabled && signIn !== denSignInKey(readDenSettings()))) return
          markThisComputerConnected()
          const credential = { baseUrl: client.baseUrls.apiBaseUrl, token: runner.token }
          if (computersEnabled) void delivery.setCredential(credential)
          await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("automationRunnerConfigure", { ...credential, runnerId })
        } catch (error) {
          if (!isCurrent()) throw error
          if (error instanceof DenApiError && error.status === 403 && error.code === COMPUTER_DISCONNECTED_ERROR) {
            markThisComputerDisconnected(signIn)
            await disconnect()
            return "disconnected"
          }
          if (isDenSessionRevokedError(error)) {
            clearCredential()
            void refresh()
            return
          }
          console.warn("[automation-runner] registration failed", error instanceof DenApiError
            ? { name: error.name, status: error.status, code: error.code }
            : { name: error instanceof Error ? error.name : "UnknownError" })
          throw error
        }
      },
    })

    const requestConnect = () => void coordinator.request().catch(() => undefined)
    const poller = computersEnabled && status === "signed_in" ? createComputerRunnerAvailabilityPoller({
      readServer: () => thisComputerStillDisconnected() ? Promise.resolve(null) : readLocalComputerServer(),
      prepareServer: delivery.setServer,
      onAvailability: next => {
        const capabilityChanged = (availability?.state === "available") !== (next?.state === "available")
        availability = next
        if (capabilityChanged && !thisComputerStillDisconnected()) requestConnect()
      },
    }) : null
    const checkLocalServer = () => { void poller?.refresh() }
    const handleSettingsChanged = () => {
      if (computersEnabled) {
        const nextSignIn = denSignInKey(readDenSettings())
        if (nextSignIn !== currentSignIn) {
          currentSignIn = nextSignIn
          availability = undefined
          poller?.reset()
          clearCredential()
        }
        void checkLocalServer()
      }
      if (!thisComputerStillDisconnected()) requestConnect()
    }
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged)
    window.addEventListener("online", handleSettingsChanged)
    if (computersEnabled) {
      window.addEventListener(denSessionUpdatedEvent, handleSettingsChanged)
      window.addEventListener("openwork-server-settings-changed", checkLocalServer)
    }
    const unsubscribeComputer = computersEnabled ? useComputerConnectionStore.subscribe((state, previous) => {
      if (state.disconnectedSignIn !== null) {
        availability = undefined
        poller?.reset()
        clearCredential()
      } else if (previous.disconnectedSignIn !== null) {
        checkLocalServer()
      }
    }) : undefined
    const unsubscribeCredentialRejected = window.__OPENWORK_ELECTRON__.automationRunner
      ?.onCredentialRejected?.((rejection) => {
        clearCredential()
        if (rejection?.reason !== COMPUTER_DISCONNECTED_ERROR) {
          coordinator.credentialRejected()
          return
        }
        markThisComputerDisconnected(denSignInKey(readDenSettings()))
        coordinator.computerDisconnected()
        void refresh()
      })
    const unsubscribeRunLifecycle = window.__OPENWORK_ELECTRON__.automationRunner
      ?.onRunLifecycle?.(observeDesktopAutomationLifecycle)
    if (thisComputerStillDisconnected()) coordinator.computerDisconnected()
    else requestConnect()
    checkLocalServer()
    return () => {
      poller?.dispose()
      coordinator.dispose()
      unsubscribeCredentialRejected?.()
      unsubscribeRunLifecycle?.()
      unsubscribeComputer?.()
      window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged)
      window.removeEventListener("online", handleSettingsChanged)
      if (computersEnabled) {
        window.removeEventListener(denSessionUpdatedEvent, handleSettingsChanged)
        window.removeEventListener("openwork-server-settings-changed", checkLocalServer)
      }
      void disconnect()
    }
  }, [computersEnabled, delivery, deploymentEnabled, refresh, status])

  return null
}
