import { create } from "zustand"

import { readDenSettings, type DenSettings } from "@/app/lib/den"
import { denSettingsChangedEvent } from "@/app/lib/den-session-events"

type DenSignIn = Pick<DenSettings, "baseUrl" | "activeOrgId" | "authToken">

/** Names a sign-in to one organization, to tell it from the next one. Held in memory only, never shown. */
export const denSignInKey = (settings: DenSignIn) =>
  [settings.baseUrl, settings.activeOrgId?.trim() ?? "", settings.authToken?.trim() ?? ""].join("\n")

type ComputerConnectionStore = {
  /**
   * The sign-in Den refuses as a computer because this desktop was
   * disconnected from its organization. Null while connected. The one place
   * the app keeps this: the runner, the device report and Settings read it here.
   */
  disconnectedSignIn: string | null
}

export const useComputerConnectionStore = create<ComputerConnectionStore>(() => ({ disconnectedSignIn: null }))

/** Den answered `computer_disconnected` to a request made with this sign-in. Stands until the sign-in changes. */
export function markThisComputerDisconnected(signIn: string) {
  window.addEventListener(denSettingsChangedEvent, thisComputerStillDisconnected)
  useComputerConnectionStore.setState({ disconnectedSignIn: signIn })
}

/** A runner token was issued, or the sign-in changed: Den takes this computer again. */
export function markThisComputerConnected() {
  window.removeEventListener(denSettingsChangedEvent, thisComputerStillDisconnected)
  useComputerConnectionStore.setState({ disconnectedSignIn: null })
}

/**
 * Whether Den still refuses this computer for the sign-in in use. Signing in
 * again is what reconnects it, so a different sign-in clears the refusal.
 */
export function thisComputerStillDisconnected(): boolean {
  const refused = useComputerConnectionStore.getState().disconnectedSignIn
  if (refused === null) return false
  if (refused === denSignInKey(readDenSettings())) return true
  markThisComputerConnected()
  return false
}

/** This computer was disconnected from its organization and nobody has signed in on it since. */
export const useThisComputerDisconnected = () =>
  useComputerConnectionStore((state) => state.disconnectedSignIn !== null)
