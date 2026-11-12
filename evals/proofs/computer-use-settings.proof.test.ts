import { expect } from "vitest"
import { spec } from "@openwork/testkit"
import { computerUseSettings } from "../worlds/computer-use-settings.ts"

// Component proof: the real Settings > Computer use page in headless Chrome, no native shell or Den needed.
const test = spec.world(computerUseSettings, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } })

const permission = (id: string, state: string) => `[data-testid="settings-computer-permission-${id}"][data-state="${state}"]`
const status = (state: string) => `[data-testid="settings-computer-status"][data-state="${state}"]`

test("a person setting up computer use sees what is left to turn on and when every chat can use it", async ({ user, probe, step, evidence }) => {
  await step("before: Settings says setup is needed and that neither macOS permission is on", async () => {
    await user.see({ text: "Setup needed" })
    await user.see({ text: "Turn on both macOS permissions below." })
    await user.see({ text: "0 of 2 on" })
    const todo = (await probe.dom('[data-testid^="settings-computer-permission-"][data-state="todo"]')).elements.length
    expect(todo).toBe(2)
    evidence.recordAssertionEvidence("Nothing is on yet", `Setup needed, 0 of 2 on, ${todo} permissions to open`, todo === 2)
    await user.screenshot()
  })
  await step("opening Accessibility marks that permission as waiting for macOS", async () => {
    await user.click("Open Accessibility")
    await user.see({ text: "Waiting for macOS" })
    const waiting = (await probe.dom(permission("accessibility", "waiting"))).elements.length
    expect(waiting).toBe(1)
    evidence.recordAssertionEvidence("Opening a pane grants nothing", "Accessibility waits for macOS and the count stays 0 of 2 on", waiting === 1)
    await user.screenshot()
  })
  await step("turning Accessibility on in macOS counts it and names the one permission left", async () => {
    await user.click("Turn on Accessibility in macOS")
    await user.see({ text: "1 of 2 on" }, { timeoutMs: 10_000 })
    await user.see({ text: "Turn on Screen Recording below." })
    const done = (await probe.dom(permission("accessibility", "done"))).elements.length
    expect(done).toBe(1)
    evidence.recordAssertionEvidence("One left, by name", "1 of 2 on; the summary asks for Screen Recording", done === 1)
    await user.screenshot()
  })
  await step("after: with both permissions on, Settings reports that every chat can use apps on this computer", async () => {
    await user.click("Turn on Screen Recording in macOS")
    await user.see({ text: "2 of 2 on" }, { timeoutMs: 10_000 })
    await user.see({ text: "Every chat can use apps on this computer." })
    await user.notSee({ text: "Open Screen Recording" })
    const ready = (await probe.dom(status("ready"))).elements.length
    expect(ready).toBe(1)
    evidence.recordAssertionEvidence("Ready for every chat", "2 of 2 on, no permission left to open, status ready", ready === 1)
    await user.screenshot()
  })
  await step("removing a remembered folder updates the list in place", async () => {
    await user.see({ text: "2 folders" })
    await user.click({ label: "Remove file sharing with https://app.example.com from /Users/sam/Documents/Quarterly reports" })
    await user.see({ text: "1 folder" })
    await user.notSee({ text: "https://app.example.com" })
    await user.see({ text: "Blocked by your organization" })
    const left = (await probe.dom('#remembered-file-sharing button[aria-label^="Remove file sharing"]')).elements.length
    expect(left).toBe(1)
    evidence.recordAssertionEvidence("One folder left", `${left} folder listed: the removed site is gone and the one blocked by the organization can still be removed`, left === 1)
    await user.screenshot()
  })
})
