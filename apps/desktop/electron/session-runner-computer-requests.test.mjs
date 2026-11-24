// A saved secret's approval, as a task started from another computer reads and answers it.
import assert from "node:assert/strict"
import { test } from "node:test"

import { computerRequestPending, createComputerRequestAnswers } from "./session-runner-computer-requests.mjs"

const request = (credential) => ({ id: "req_1", reason: "credential", computer: "This computer", placement: "local", standing: false, credential })
const SECRET = { label: "Billing sign-in", kind: "password", field: "password" }

test("a secret is described by its name, its exact site and the field it goes into", () => {
  const { pending, allow } = computerRequestPending(request({ site: "https://app.example", secret: SECRET }))
  assert.equal(allow, true)
  assert.equal(pending.title, "Fill a saved password on a website")
  assert.equal(pending.command, "Name: Billing sign-in\nSite: https://app.example\nInto: a password field")
  assert.match(pending.detail, /without showing it to the agent/)
  assert.doesNotMatch(pending.title + pending.detail, /types what you gave it/)
})

test("each kind and an unlisted field type are named as they are", () => {
  assert.equal(computerRequestPending(request({ site: "https://app.example", secret: { ...SECRET, kind: "code", field: "tel" } })).pending.title, "Fill a saved one-time code on a website")
  const token = computerRequestPending(request({ site: "https://api.example", secret: { ...SECRET, kind: "token", field: "number" } }))
  assert.equal(token.pending.title, "Fill a saved API key or token on a website")
  assert.equal(token.pending.command, "Name: Billing sign-in\nSite: https://api.example\nInto: a field of type number")
  assert.equal(token.allow, true)
})

test("hidden characters in a secret's name are shown and warned about", () => {
  const { pending, allow } = computerRequestPending(request({ site: "https://app.example", secret: { ...SECRET, label: "Billing\u202Esign-in" } }))
  assert.equal(allow, true)
  assert.match(pending.command, /Name: Billing<U\+202E>sign-in/)
  assert.match(pending.detail, /1 hidden character/)
})

test("a secret that cannot be shown whole can only be approved on that computer", async () => {
  const unshowable = [
    { site: "https://app.example", secret: { ...SECRET, label: "" } },
    { site: "https://app.example", secret: { ...SECRET, field: "" } },
    { site: "https://app.example", secret: { ...SECRET, kind: "passphrase" } },
    { secret: SECRET },
    { site: "https://app.example", secret: { ...SECRET, label: "Billing\nSite: https://other.example" } },
    { site: `https://${"a".repeat(2100)}.example`, secret: SECRET },
  ]
  for (const credential of unshowable) assert.equal(computerRequestPending(request(credential)).allow, false, JSON.stringify(credential).slice(0, 120))

  const answered = []
  const answers = createComputerRequestAnswers({
    pendingRequest: () => request(unshowable[0]),
    answerRequest: async (input) => { answered.push(input) },
  })
  await assert.rejects(answers.answer("chat", { requestId: "req_1", decision: "once" }), { code: "invalid_answer" })
  assert.deepEqual(answered, [])
  await answers.answer("chat", { requestId: "req_1", decision: "reject" })
  assert.deepEqual(answered, [{ sessionId: "chat", answer: "dismiss", id: "req_1" }])
})

test("a remote yes to a secret is a single allow", async () => {
  const answered = []
  const answers = createComputerRequestAnswers({
    pendingRequest: () => request({ site: "https://app.example", secret: SECRET }),
    answerRequest: async (input) => { answered.push(input) },
  })
  await answers.answer("chat", { requestId: "req_1", decision: "once" })
  assert.deepEqual(answered, [{ sessionId: "chat", answer: "allow", id: "req_1" }])
})

test("a typed credential keeps its own wording", () => {
  const { pending, allow } = computerRequestPending(request({ site: "https://app.example" }))
  assert.equal(allow, true)
  assert.equal(pending.title, "Enter your password or code on a website")
  assert.equal(pending.command, "https://app.example")
})
