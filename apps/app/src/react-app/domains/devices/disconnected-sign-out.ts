import { readDenSettings } from "@/app/lib/den"
import { notifyAlert } from "@/react-app/shell/notifications"
import { thisComputerStillDisconnected, useComputerConnectionStore } from "./computer-connection-store"

let explainedSignIn: string | null = null

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
