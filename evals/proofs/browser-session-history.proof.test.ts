import { expect } from "vitest"
import { spec } from "@openwork/testkit"
import { browserSessionHistory } from "../worlds/computer-session-history.ts"

// Component proof: the real MessageList in headless Chrome, no native shell or Den needed.
const test = spec.world(browserSessionHistory, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } })

test("browser work stays in one quiet card with the pages it saw", async ({ user, probe, step, evidence }) => {
  await step("before: repeated browser steps and three page captures fill the conversation", async () => {
    await user.see({ text: "The landscape is on the canvas." })
    await user.click({ label: "10 steps. Show steps" })
    await user.see({ text: "I’ll open the canvas." })
    const images = (await probe.dom('[data-message-role="assistant"] img')).elements.length
    expect(images).toBe(3)
    evidence.recordAssertionEvidence("Individual captures", `${images} page captures before grouping`, images === 3)
    await user.screenshot()
  })
  await step("after: the same work becomes one collapsed browser session", async () => {
    await user.click("Group computer history")
    await user.see({ label: "View browser session history" })
    await user.see({ text: "Used browser" })
    await user.see({ text: "The landscape is on the canvas." })
    const cards = (await probe.dom("[data-computer-session-history]")).elements.length
    const oldImages = (await probe.dom('[data-message-role="assistant"] img')).elements.length
    expect(cards).toBe(1); expect(oldImages).toBe(0)
    evidence.recordAssertionEvidence("One card, reply retained", `${cards} card; ${oldImages} repeated transcript images`, cards === 1 && oldImages === 0)
    await user.screenshot()
  })
  await step("opening the session shows the captured pages and the original steps", async () => {
    await user.click({ label: "View browser session history" })
    await user.see({ text: "3 / 3" })
    await user.click({ label: "Browse captured views" }); await user.press("Home")
    await user.see({ text: "1 / 3" })
    await user.click({ label: "View browser actions" })
    const actions = (await probe.dom("[data-computer-session-history] [data-capability-call]")).elements.length
    expect(actions).toBe(6)
    evidence.recordAssertionEvidence("Original steps retained", `${actions} browser steps behind the card`, actions === 6)
    await user.screenshot()
  })
})
