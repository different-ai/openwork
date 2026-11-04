import { expect } from "vitest"
import { spec } from "@openwork/testkit"
import { browserSessionHistory } from "../worlds/computer-session-history.ts"

// Component proof: the real MessageList in headless Chrome, no native shell or Den needed.
const test = spec.world(browserSessionHistory, { timeout: 90_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } })

test("browser work keeps its own steps instead of the computer session card", async ({ user, probe, step, evidence }) => {
  await step("before: repeated browser steps and three page captures fill the conversation", async () => {
    await user.see({ text: "The landscape is on the canvas." })
    await user.click({ label: "10 steps. Show steps" })
    await user.see({ text: "I’ll open the canvas." })
    const images = (await probe.dom('[data-message-role="assistant"] img')).elements.length
    expect(images).toBe(3)
    evidence.recordAssertionEvidence("Individual captures", `${images} page captures before grouping`, images === 3)
    await user.screenshot()
  })
  await step("after: grouping computer history leaves browser steps and their pages in the conversation", async () => {
    await user.click("Group computer history")
    await user.see({ text: "The landscape is on the canvas." })
    await user.see({ label: "10 steps. Hide steps" })
    const cards = (await probe.dom("[data-computer-session-history]")).elements.length
    const images = (await probe.dom('[data-message-role="assistant"] img')).elements.length
    expect(cards).toBe(0); expect(images).toBe(3)
    evidence.recordAssertionEvidence("No computer card for browser work", `${cards} cards; ${images} page captures`, cards === 0 && images === 3)
    await user.screenshot()
  })
})
