import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (relative: string) =>
  readFileSync(join(import.meta.dir, "..", relative), "utf8")

/**
 * A Desktop Automation only runs while a desktop is connected, and for a long
 * time the surface said nothing about that until an occurrence had already
 * been missed — with one generic wording that could not distinguish a closed
 * laptop from a runner that could never connect. These checks pin the signals
 * that make the state visible before and after a due occurrence.
 */
describe("Automation runner visibility", () => {
  test("the page warns while no desktop is connected", () => {
    const page = read("src/react-app/domains/automations/automations-page.tsx")
    expect(page).toContain("getAutomationDesktopRunnerPresence")
    expect(page).toContain("data-automation-runner-offline")
    expect(page).toContain("No desktop connected")
    // Unknown presence, from a Den too old to answer, must stay silent rather
    // than warn about a desktop that is connected and running Automations.
    expect(page).toContain("const noDesktopConnected = runnerPresenceQuery.data?.connected === false")
    // A Den without the route answers null once; polling it again buys nothing.
    expect(page).toContain("refetchInterval: (queryState) => (queryState.state.data === null ? false : 60_000)")
  })

  test("a missed run shows the cause Den recorded", () => {
    const page = read("src/react-app/domains/automations/automations-page.tsx")
    expect(page).toContain("run.error.message.trim() || \"Missed — desktop runner unavailable\"")
  })

  test("the full Automation list does not enter a fast polling window", () => {
    const page = read("src/react-app/domains/automations/automations-page.tsx")
    const listQuery = page.slice(
      page.indexOf("const listQuery"),
      page.indexOf("const providersQuery"),
    )

    expect(listQuery).toContain("refetchInterval: AUTOMATIONS_PAGE_SLOW_POLL_MS")
    expect(listQuery).not.toContain("AUTOMATIONS_PAGE_FAST_POLL_MS")
    expect(page).not.toContain("AUTOMATIONS_PAGE_FAST_POLL_WINDOW_MS")
  })

  test("the bridge re-registers when the network comes back", () => {
    const bridge = read("src/react-app/domains/automations/automation-runner-bridge.tsx")
    expect(bridge).toContain("window.addEventListener(\"online\", handleSettingsChanged)")
    expect(bridge).toContain("window.removeEventListener(\"online\", handleSettingsChanged)")
  })
})
