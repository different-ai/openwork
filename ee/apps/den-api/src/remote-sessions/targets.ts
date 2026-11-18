import { desktopRunnerConnected } from "@openwork/automations"
import type { RemoteSessionDesktopRecord } from "../mcp/remote-session-capabilities.js"

type NamedComputer = Pick<RemoteSessionDesktopRecord, "platform" | "lastSeenAt" | "inventory">

/** The name a computer reported for itself with its platform; null for one that never reported a name. */
function reportedName(computer: NamedComputer): string | null {
  const label = computer.inventory?.computer.label
  return label ? `${computer.platform}\n${label}` : null
}

/**
 * The member's computers that are offered as places to start a task.
 *
 * Every OpenWork app profile registers by itself, so a computer that ran
 * another build of OpenWork, or whose app data was reset, leaves a
 * registration behind under the computer's own name. No task can be started
 * on it and nothing but its app version tells it from the one in use, so an
 * offline registration is left out once another with the same name and
 * platform has been seen since. Registrations that are online all stay: two
 * apps open on one computer are two places a task can run. So does a computer
 * that never reported a name, which says nothing about being the same one.
 *
 * Only what is listed changes. A registration left out here keeps its
 * sessions, and naming its id still answers for it as before.
 */
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
