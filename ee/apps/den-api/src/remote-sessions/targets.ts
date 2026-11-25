import { desktopRunnerConnected } from "@openwork/automations"
import type { RemoteSessionDesktopRecord } from "../mcp/remote-session-capabilities.js"

type NamedComputer = Pick<RemoteSessionDesktopRecord, "platform" | "lastSeenAt" | "inventory">

function reportedName(computer: NamedComputer): string | null {
  const label = computer.inventory?.computer.label
  return label ? `${computer.platform}\n${label}` : null
}

export function listedTargets<Computer extends NamedComputer>(computers: readonly Computer[], now: number): Computer[] {
  const latest = new Map<string, Computer>()
  for (const computer of computers) {
    const name = reportedName(computer)
    if (name === null) continue
    const known = latest.get(name)
    if (!known || computer.lastSeenAt > known.lastSeenAt) latest.set(name, computer)
  }
  return computers.filter((computer) => {
    if (desktopRunnerConnected({ lastSeenAt: computer.lastSeenAt, now })) return true
    const name = reportedName(computer)
    return name === null || latest.get(name) === computer
  })
}
