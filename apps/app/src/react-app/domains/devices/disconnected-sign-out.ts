import { readDenSettings } from "@/app/lib/den"
import { notifyAlert } from "@/react-app/shell/notifications"
import { thisComputerStillDisconnected, useComputerConnectionStore } from "./computer-connection-store"

/** The refused sign-in the person was already told about. */
let explainedSignIn: string | null = null

/**
 * A sign-in check found the session gone. When Den had already refused this
 * computer under that sign-in, the disconnect is why the person is signed out:
 * say so, once. Call it before the session is cleared, which forgets both the
 * disconnect and the organization's name. Signing out, or a session that
 * expired on a connected computer, says nothing.
 */
export function explainSignOutAfterDisconnect() {
  if (!thisComputerStillDisconnected()) return
  const signIn = useComputerConnectionStore.getState().disconnectedSignIn
  if (signIn === explainedSignIn) return
  explainedSignIn = signIn
  const organization = readDenSettings().activeOrgName?.trim() || "your organization"
  notifyAlert({
    kind: "cloud",
    severity: "info",
    title: `This computer was disconnected from ${organization}. Sign in again to reconnect it.`,
    dedupeKey: "computer-disconnected-sign-out",
  })
}
