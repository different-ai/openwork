import { createRoot } from "react-dom/client"
import type { ComputerPermission, ComputerStatus, PrivateValueSettings } from "@openwork/types/desktop-ipc"
import { ComputerUseSettings, RememberedFileSharing } from "../src/react-app/domains/settings/pages/computer-use-view"
import { SettingsContent, SettingsPanel, SettingsPanelDescription, SettingsPanelHeading, SettingsPanelTitle } from "../src/react-app/domains/settings/shell/panel"
import { Button } from "../src/components/ui/button"
import { TooltipProvider } from "../src/components/ui/tooltip"
import "../src/app/index.css"

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

const values = query.get("values")
const privateValues: PrivateValueSettings = {
  enabled: values !== null && values !== "off",
  switches: { commands: true, paste: true, keep: true },
  organization: values === "org" ? { fills: "ask", commands: "limited", paste: "blocked" } : values === "blocked" ? { fills: "blocked", commands: null, paste: null } : { fills: null, commands: null, paste: null },
  always: values === "some" || values === "org" ? [
    { id: "bank", sessionId: "chat-1", site: "https://bank.example.com", field: "password", command: "bw get password bank.example.com", blocked: false },
    { id: "ops", sessionId: "chat-2", site: "https://ops.example.com", field: "password", command: "security find-generic-password -s ops -w", blocked: values === "org" },
  ] : [],
  kept: values === "some" ? [
    { id: "code", sessionId: "chat-1", site: "https://bank.example.com", label: "Sign-in code" },
    { id: "key", sessionId: "chat-1", program: "bw", label: "Bitwarden session key" },
  ] : [],
  recent: values === "some" ? [
    { at: Date.UTC(2026, 0, 5, 17, 4), sessionId: "chat-1", site: "https://bank.example.com", field: "password", source: "command", program: "bw", result: "filled" },
    { at: Date.UTC(2026, 0, 5, 17, 2), sessionId: "chat-1", site: "https://bank.example.com", field: "text", source: "paste", result: "declined" },
    { at: Date.UTC(2026, 0, 5, 16, 58), sessionId: "chat-2", site: "https://ops.example.com", field: "password", source: "command", program: "security", result: "blocked" },
  ] : [],
}

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
    case "computerSetup":
    case "computerResetPermission":
      return { setupId: "fixture" }
    case "computerDismissSetup":
      return null
    case "computerListFileGrants":
      if (query.get("grants") === "failed") throw new Error("The account could not be read.")
      return { enabled: query.get("grants") !== "off", grants }
    case "computerListPrivateValues":
      if (values === "failed") throw new Error("The account could not be read.")
      return privateValues
    case "computerSetPrivateValueSwitch":
      if ((args[0] === "commands" || args[0] === "paste" || args[0] === "keep") && typeof args[1] === "boolean") privateValues.switches = { ...privateValues.switches, [args[0]]: args[1] }
      return { ok: true }
    case "computerRemovePrivateValue":
      if (args[0] === "always") privateValues.always = privateValues.always.filter((entry) => entry.id !== args[1])
      else privateValues.kept = privateValues.kept.filter((entry) => entry.id !== args[1])
      return { ok: true }
    case "computerRemoveFileGrant":
      grants = grants.filter((grant) => grant.id !== args[0])
      return { ok: true }
    default:
      throw new Error(`The fixture has no ${command}`)
  }
}
Reflect.set(window, "__OPENWORK_ELECTRON__", { invokeDesktop: invoke })

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
        <RememberedFileSharing />
      </SettingsContent>
    </div>
  </TooltipProvider>,
)
