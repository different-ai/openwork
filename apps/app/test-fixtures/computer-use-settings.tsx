import { createRoot } from "react-dom/client"
import type { ComputerPermission, ComputerStatus } from "@openwork/types/desktop-ipc"
import { ComputerUseSettings } from "../src/react-app/domains/settings/pages/computer-use-view"
import { SettingsContent, SettingsPanel, SettingsPanelDescription, SettingsPanelHeading, SettingsPanelTitle } from "../src/react-app/domains/settings/shell/panel"
import { Button } from "../src/components/ui/button"
import { TooltipProvider } from "../src/components/ui/tooltip"
import "../src/app/index.css"

// Settings > Computer use in each state it can report, behind the desktop IPC
// boundary: no helper, no macOS permissions and no account are involved.
//   ?state=ready | setup | partial | unsupported | unavailable | failed | checking | vm | off
//   &targets=2   offers a second computer to choose
//   &grants=none | some | failed | off   remembered file sharing (default none)
//   &theirs      macOS lists the permissions under an app OpenWork cannot reset
//   &controls    shows buttons that stand in for System Settings
const query = new URLSearchParams(location.search)
const state = query.get("state") ?? "ready"
const granted: Record<ComputerPermission, boolean> = {
  accessibility: state === "ready" || state === "partial",
  screenRecording: state === "ready",
}
let targetId = state === "vm" ? "vm" : "local"
let grants = query.get("grants") === "some" ? [
  { id: "reports", origin: "https://app.example.com", folder: "/Users/sam/Documents/Quarterly reports" },
  { id: "invoices", origin: "https://billing.example.com", folder: "/Users/sam/Documents/Invoices", blocked: true },
] : []

function status(): ComputerStatus {
  const local = targetId === "local"
  const targets: ComputerStatus["targets"] = [{ id: "local", label: "This Mac", placement: "local" }]
  if (query.get("targets") === "2" || !local) targets.push({ id: "vm", label: "Design VM", placement: "remote" })
  const entry = { name: query.has("theirs") ? "Terminal" : "OpenWork Computer Use", ours: !query.has("theirs") }
  const base = { enabled: true, entry, targetId, targets, placement: local ? "local" : "remote" } satisfies Partial<ComputerStatus>
  if (!local) return { ...base, readiness: "ready", detail: "Ready" }
  if (state === "unsupported") return { ...base, readiness: "unsupported", detail: "This Mac requires macOS 14 or later for Computer Use." }
  if (state === "unavailable") return { ...base, readiness: "unavailable", detail: "The Computer Use helper is missing from this OpenWork build. Rebuild or reinstall OpenWork." }
  const ready = granted.accessibility && granted.screenRecording
  return {
    ...base,
    permissions: { ...granted },
    readiness: ready ? "ready" : "setup-required",
    detail: ready ? "Computer Use is ready." : "Computer Use needs permission. Open setup to review access.",
  }
}

async function invoke(command: string, ...args: unknown[]) {
  switch (command) {
    case "computerStatus":
      if (state === "checking") return new Promise(() => {})
      if (state === "failed") throw new Error("The helper did not answer.")
      return status()
    case "computerChoose":
      if (typeof args[0] === "string") targetId = args[0]
      return status()
    // Opening a pane grants nothing; the fixture's "Grant" buttons stand in for System Settings.
    case "computerSetup":
    case "computerResetPermission":
      return { setupId: "fixture" }
    case "computerDismissSetup":
      return null
    case "computerListFileGrants":
      if (query.get("grants") === "failed") throw new Error("The account could not be read.")
      return { enabled: query.get("grants") !== "off", grants }
    case "computerRemoveFileGrant":
      grants = grants.filter((grant) => grant.id !== args[0])
      return { ok: true }
    default:
      throw new Error(`The fixture has no ${command}`)
  }
}
Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: invoke })

// What a person does in System Settings. The page finds out on its next check, as it does from macOS.
function SystemSettings() {
  return (
    <div className="flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
      <span className="text-sm font-medium">System Settings stand-in</span>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => { granted.accessibility = true }}>Turn on Accessibility in macOS</Button>
        <Button variant="outline" size="sm" onClick={() => { granted.screenRecording = true }}>Turn on Screen Recording in macOS</Button>
      </div>
    </div>
  )
}

const root = document.getElementById("root")
if (!root) throw new Error("Fixture root missing")
createRoot(root).render(
  <TooltipProvider>
    <div className="flex h-screen bg-background text-foreground">
      <SettingsContent>
        {query.has("controls") ? <SystemSettings /> : null}
        <SettingsPanel>
          <SettingsPanelHeading>
            <SettingsPanelTitle>Computer use</SettingsPanelTitle>
            <SettingsPanelDescription>Let the agent use apps on this computer</SettingsPanelDescription>
          </SettingsPanelHeading>
        </SettingsPanel>
        <ComputerUseSettings enabled={state !== "off"} />
      </SettingsContent>
    </div>
  </TooltipProvider>,
)
