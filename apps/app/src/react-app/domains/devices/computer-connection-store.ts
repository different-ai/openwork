import { create } from "zustand"

import { readDenSettings, type DenSettings } from "@/app/lib/den"
import { denSettingsChangedEvent } from "@/app/lib/den-session-events"

type DenSignIn = Pick<DenSettings, "baseUrl" | "activeOrgId" | "authToken">

export const denSignInKey = (settings: DenSignIn) =>
  [settings.baseUrl, settings.activeOrgId?.trim() ?? "", settings.authToken?.trim() ?? ""].join("\n")

type ComputerConnectionStore = {
  disconnectedSignIn: string | null
}

export const useComputerConnectionStore = create<ComputerConnectionStore>(() => ({ disconnectedSignIn: null }))

export function markThisComputerDisconnected(signIn: string) {
  window.addEventListener(denSettingsChangedEvent, thisComputerStillDisconnected)
  useComputerConnectionStore.setState({ disconnectedSignIn: signIn })
}

export function markThisComputerConnected() {
  window.removeEventListener(denSettingsChangedEvent, thisComputerStillDisconnected)
  useComputerConnectionStore.setState({ disconnectedSignIn: null })
}

export function thisComputerStillDisconnected(): boolean {
  const refused = useComputerConnectionStore.getState().disconnectedSignIn
  if (refused === null) return false
  if (refused === denSignInKey(readDenSettings())) return true
  markThisComputerConnected()
  return false
}

export const useThisComputerDisconnected = () =>
  useComputerConnectionStore((state) => state.disconnectedSignIn !== null)
