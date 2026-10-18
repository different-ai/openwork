import assert from "node:assert/strict"
import { test } from "node:test"
import type { RunnerMessage, RunnerSnapshot } from "@openwork-ee/headless-protocol"
import { buildWorkbotTurns } from "@openwork-ee/workbot-server"

function snapshot(messages: RunnerMessage[], status = "completed"): RunnerSnapshot {
  return {
    turns: [{ messageId: "wb_example", status, error: null, createdAt: 1000, updatedAt: 6000 }],
    messages: [{ role: "user", messageId: "wb_example", text: "Prepare the report" }, ...messages.map(message => ({ ...message, messageId: "wb_example" }))],
    finalAssistantText: "",
  }
}
const command: RunnerMessage = { role: "assistant", text: "", createdAt: 2000, toolCalls: [{ id: "command", name: "bash", input: { description: "Checking the report" } }] }
const result: RunnerMessage = { role: "tool", name: "bash", callId: "command", createdAt: 4000, isError: false }
function steps(value: RunnerSnapshot) {
  return buildWorkbotTurns(value)[0]?.parts.flatMap(part => part.kind === "steps" ? part.steps : []) ?? []
}

test("computer results distinguish success, failure, and missing completion", () => {
  assert.equal(steps(snapshot([command, result]))[0]?.status, "done")
  assert.equal(steps(snapshot([command, { ...result, isError: true }]))[0]?.status, "failed")
  assert.equal(steps(snapshot([command]))[0]?.status, "interrupted")
  assert.equal(steps(snapshot([command], "aborted"))[0]?.status, "stopped")
  assert.equal(steps(snapshot([command], "running"))[0]?.status, "running")
})

test("a completed command stops its own timer before the answer finishes", () => {
  const [step] = steps(snapshot([command, result], "running"))
  assert.equal(step?.status, "done")
  assert.equal(step?.finishedAt, 4000)
  assert.equal(step?.startedAt, 2000)
})

test("recovered command failures stay in one neutral computer step", () => {
  const next: RunnerMessage = { role: "assistant", text: "", createdAt: 4500, toolCalls: [{ id: "recovery", name: "bash", input: { description: "Reading the saved report" } }] }
  const recovered: RunnerMessage = { role: "tool", name: "bash", callId: "recovery", createdAt: 5000, isError: false }
  const values = steps(snapshot([command, { ...result, isError: true }, next, recovered]))
  assert.equal(values.length, 1)
  assert.equal(values[0]?.status, "done")
  assert.deepEqual(values[0]?.updates, ["Checking the report", "Reading the saved report"])
})

test("interrupted answers retain their words and do not claim to be running", () => {
  const value = snapshot([{ ...command, text: "The report has three sections." }], "interrupted")
  const [turn] = buildWorkbotTurns(value)
  assert.equal(turn?.status, "interrupted")
  assert.equal(turn?.parts[0]?.kind, "text")
  assert.equal(steps(value)[0]?.status, "interrupted")
})

test("skill and catalog routing never becomes an app name or activity", () => {
  const value = snapshot([{ role: "assistant", text: "", toolCalls: [
    { id: "skill", name: "execute_capability", input: { name: "skill:slack-gmail-calendar-guide" } },
    { id: "catalog", name: "search_capabilities", input: { query: "slack" } },
    { id: "app", name: "execute_capability", input: { name: "mcp:connection:slack_mail_calendar_delete" } },
  ] }], "running")
  assert.equal(steps(value).length, 1)
  assert.equal(steps(value)[0]?.app, null)
  assert.equal(steps(value)[0]?.label, "Using a connected app")
  assert.doesNotMatch(JSON.stringify(steps(value)), /Slack|Gmail|Calendar|skill:|mcp:/)
  const internal = snapshot([{ ...command, toolCalls: [{ id: "command", name: "bash", input: { description: "Reading skill:slack-guide" } }] }], "running")
  assert.deepEqual(steps(internal)[0]?.updates, [])
})

test("an unconfirmed reaction cannot acknowledge a message", () => {
  const react: RunnerMessage = { role: "assistant", text: "", toolCalls: [{ id: "react", name: "react", input: { emoji: "👍" } }] }
  assert.equal(buildWorkbotTurns(snapshot([react], "running"))[0]?.reaction, null)
  const accepted: RunnerMessage = { role: "tool", name: "react", callId: "react", isError: false }
  assert.equal(buildWorkbotTurns(snapshot([react, accepted]))[0]?.reaction, "👍")
  assert.equal(buildWorkbotTurns(snapshot([react, { ...accepted, isError: true }]))[0]?.reaction, null)
})
