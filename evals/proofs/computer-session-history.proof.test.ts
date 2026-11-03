import { expect } from "vitest"
import { spec } from "@openwork/testkit"
import { computerSessionHistory } from "../worlds/computer-session-history.ts"

// Component proof: the real MessageList in headless Chrome, no native shell or Den needed.
const test = spec.world(computerSessionHistory, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } })

test("computer work stays in one quiet card with captured views to browse", async ({ user, probe, step, evidence }) => {
  await step("before: individual computer actions and three screenshots fill the conversation", async () => {
    await user.see({ text: "The drawing is open. It hasn’t been saved yet." })
    const images = (await probe.dom('[data-message-role="assistant"] img')).elements.length
    expect(images).toBe(3)
    evidence.recordAssertionEvidence("Individual captures", `${images} screenshots before grouping`, images === 3)
    await user.screenshot()
  })
  await step("after: the same work becomes one collapsed computer session", async () => {
    await user.click("Group computer history")
    await user.see({ label: "View computer session history" })
    await user.see({ text: "I’m adding the clouds." })
    await user.see({ text: "The drawing is open. It hasn’t been saved yet." })
    const cards = (await probe.dom("[data-computer-session-history]")).elements.length
    const oldImages = (await probe.dom('[data-message-role="assistant"] img')).elements.length
    expect(cards).toBe(1); expect(oldImages).toBe(0)
    evidence.recordAssertionEvidence("One card, narration retained", `${cards} card; ${oldImages} repeated transcript images`, cards === 1 && oldImages === 0)
    await user.screenshot()
  })
  await step("opening the session lets the member browse and play the captured views", async () => {
    await user.click({ label: "View computer session history" })
    await user.see({ text: "3 / 3" })
    await user.click({ label: "Play captured views" })
    await user.see({ text: "1 / 3" })
    await user.see({ text: "2 / 3" }, { timeoutMs: 5000 })
    await user.click({ label: "Pause captured views" })
    await user.click({ label: "Browse captured views" }); await user.press("Home")
    await user.see({ text: "1 / 3" })
    await user.click({ label: "View computer actions" })
    const actions = (await probe.dom("[data-computer-session-history] [data-capability-call]")).elements.length
    expect(actions).toBe(4)
    evidence.recordAssertionEvidence("Captured playback and original actions", `Played, scrubbed to view 1, and retained ${actions} actions`, actions === 4)
    await user.screenshot()
  })
  await step("turning grouping off restores the original conversation and captures", async () => {
    await user.click("Group computer history")
    await user.notSee({ label: "View computer session history" })
    const images = (await probe.dom('[data-message-role="assistant"] img')).elements.length
    expect(images).toBe(3)
    evidence.recordAssertionEvidence("Reversible presentation", `${images} original captures restored`, images === 3)
    await user.screenshot()
  })
})
