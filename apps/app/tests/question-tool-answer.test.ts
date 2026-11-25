import assert from "node:assert/strict"
import { test } from "node:test"
import { questionAnswerSummary, questionToolAnswers } from "../src/components/tools/question"
import type { QuestionToolPart } from "../src/lib/build-in-tools"

const questions = [{ question: "Which name should the team use?", header: "Name", options: [] }]
const answered = (extra: Partial<QuestionToolPart>): QuestionToolPart => ({
  type: "dynamic-tool", toolName: "question", toolCallId: "call-1", state: "output-available",
  input: { questions }, output: "", ...extra,
} as QuestionToolPart)

test("the row reads the answers the engine kept", () => {
  const part = answered({ callProviderMetadata: { openwork: { questionAnswers: [["Guillaume", "Guiome"]] } } })
  assert.deepEqual(questionToolAnswers(part), [["Guillaume", "Guiome"]])
  assert.equal(questionAnswerSummary(questionToolAnswers(part)), "Guillaume, Guiome")
})

test("an older transcript's text still gives a single answer", () => {
  const part = answered({ output: 'User has answered your questions: "Which name should the team use?"="Call him Guiome". You can now continue with the user\'s answers in mind.' })
  assert.deepEqual(questionToolAnswers(part), [["Call him Guiome"]])
})

test("several questions join into one short line, skipping empty ones", () => {
  assert.equal(questionAnswerSummary([["Yes"], [], ["Tomorrow", " "]]), "Yes · Tomorrow")
  assert.equal(questionAnswerSummary([[]]), null)
})

test("unknown or unanswered stays on the plain Answered row", () => {
  assert.equal(questionToolAnswers(answered({ output: "done" })), null)
  assert.equal(questionToolAnswers(answered({ output: 'User has answered your questions: "Q"="Unanswered". You can now continue' })), null)
  assert.equal(questionToolAnswers(answered({ state: "input-available", output: undefined } as Partial<QuestionToolPart>)), null)
})
