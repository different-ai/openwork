import type { RemoteDevice } from "@openwork/types/den/remote-devices"

/**
 * UI-only deterministic fixtures for the Devices page; no computer is contacted. `working`: the `remote` scenario, whose
 * remote tasks run on the Mac Studio (`fixture-studio` in remote-jobs.ts) while Workbot also works in its own chat.
 */
export function fixtureDevices(working: boolean): RemoteDevice[] {
  const now = Date.now()
  const at = (ago: number) => new Date(now - ago).toISOString()
  const device = (id: string, values: Partial<RemoteDevice> & Pick<RemoteDevice, "kind" | "provider" | "label">): RemoteDevice => ({
    id, source: values.kind === "desktop" ? "desktop_app" : "workbot", platform: values.kind === "desktop" ? "darwin" : "linux", access: "mine",
    availability: "online", state: "ready", statusDetail: null, lastSeenAt: at(30_000), createdAt: at(30 * 24 * 3_600_000), appVersion: null,
    computerId: null, workbotChat: null, workingSince: null, canRename: false, canRemove: false, disconnectedAt: null, canDisconnect: false, remoteAccess: null,
    ...values,
  })
  return [
    device("rdv_fixture_studio", { kind: "desktop", provider: "openwork_desktop", label: "Mac Studio", computerId: "fixture-studio", appVersion: "0.18.70" }),
    device("rdv_fixture_air", { kind: "desktop", provider: "openwork_desktop", label: "Sam's MacBook Air", computerId: "fixture-air", appVersion: "0.18.70" }),
    device("rdv_fixture_workbot", {
      kind: "vm", provider: "workbot", label: "Workbot's computer", workbotChat: "main", availability: "unknown", lastSeenAt: at(12 * 60_000),
      workingSince: working ? at(2 * 60_000) : null,
    }),
  ]
}
