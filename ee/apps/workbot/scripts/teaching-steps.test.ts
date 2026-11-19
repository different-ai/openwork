import assert from "node:assert/strict"
import { test } from "node:test"
import { browserSkillInputs, browserSkillRunPrompt, compileBrowserDemonstration, demonstrationStepGroups, type BrowserDemonstration, type DemonstrationStep } from "@openwork/types/browser-demonstration"

const search = { role: "textbox", name: "Site Search", tag: "input" }
const result = { role: "link", name: "Example plans", tag: "a" }
function demonstration(steps: Array<Omit<DemonstrationStep, "id" | "explanation">>): BrowserDemonstration {
  return { id: "3f0e1a52-6f0b-4b7e-9d53-6f1f0a8a2c11", phase: "draft", tabId: "tab", steps: steps.map((step, index) => ({ ...step, id: index + 1, explanation: "" })) }
}
const typedThreeTimes = demonstration([
  { kind: "navigate" },
  { kind: "fill", target: search, parameter: "input_2" },
  { kind: "fill", target: search, parameter: "input_3" },
  { kind: "fill", target: search, parameter: "input_4" },
  { kind: "key", key: "Enter", target: search },
  { kind: "navigate" },
  { kind: "click", target: result },
  { kind: "click", target: result },
  { kind: "fill", target: search, parameter: "input_9" },
])

test("one action repeated in a row reads as one line, and every step is kept", () => {
  const groups = demonstrationStepGroups(typedThreeTimes.steps)
  assert.deepEqual(groups.map(group => [group.label, group.steps.map(step => step.id)]), [
    ["Open the starting page", [1]],
    ["Enter Site Search", [2, 3, 4]],
    ["Press Enter", [5]],
    ["Wait for the next page", [6]],
    ["Click Example plans", [7, 8]],
    ["Enter Site Search", [9]],
  ])
})

test("controls without a name stay separate lines", () => {
  const unnamed = { role: "button", name: "", tag: "button" }
  const groups = demonstrationStepGroups(demonstration([{ kind: "click", target: unnamed }, { kind: "click", target: unnamed }]).steps)
  assert.deepEqual(groups.map(group => group.steps.length), [1, 1])
})

test("a run asks once for a field typed several times in a row, and fills each recorded entry", () => {
  const inputs = browserSkillInputs(typedThreeTimes)
  assert.deepEqual(inputs.map(input => [input.label, input.names]), [
    ["Starting page", ["start_url"]],
    ["Site Search", ["input_2", "input_3", "input_4"]],
    ["Site Search (step 9)", ["input_9"]],
  ])
  const prompt = browserSkillRunPrompt("Plan lookup", typedThreeTimes, { input_2: "dental", start_url: "https://example.com" })
  assert.deepEqual(JSON.parse(prompt.split("\n")[1] ?? ""), { name: "Plan lookup", inputs: { start_url: "https://example.com", input_2: "dental", input_3: "dental", input_4: "dental" } })
  assert.ok(prompt.endsWith("Run my Plan lookup skill.\nStarting page: https://example.com\nSite Search: dental"))
  for (const name of ["input_2", "input_3", "input_4", "input_9"]) assert.ok(compileBrowserDemonstration(typedThreeTimes, "Plan lookup", "Find a plan").includes(`"${name}"`))
})

test("an entry the teacher names is its own input", () => {
  const named = structuredClone(typedThreeTimes)
  const step = named.steps[2]
  assert.ok(step)
  step.parameter = "plan_type"
  assert.deepEqual(browserSkillInputs(named).map(input => [input.label, input.names]), [
    ["Starting page", ["start_url"]],
    ["Site Search", ["input_2", "input_4"]],
    ["Plan type", ["plan_type"]],
    ["Site Search (step 9)", ["input_9"]],
  ])
})
