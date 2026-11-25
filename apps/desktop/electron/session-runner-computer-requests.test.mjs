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

const PASSWORD = { field: "password", command: ["op", "read", "op://Private/Example/password"] }
const CODE = { field: "number", command: ["/opt/homebrew/bin/bw", "get", "totp", "example site"] }

test("commands are described by their exact words, their fields and the site", () => {
  const one = computerRequestPending(request({ site: "https://app.example", fills: [PASSWORD] }))
  assert.equal(one.pending.title, "Run a command and fill what it prints on a website")
  assert.match(one.pending.detail, /runs each command on that computer as you/)
  assert.equal(one.pending.command, "Site: https://app.example\nop read op://Private/Example/password\n  into a password field")
  assert.equal(one.allow, true)
  const two = computerRequestPending(request({ site: "https://app.example", fills: [PASSWORD, CODE] }))
  assert.equal(two.pending.title, "Run 2 commands and fill what they print on a website")
  assert.equal(two.pending.command, "Site: https://app.example\nop read op://Private/Example/password\n  into a password field\n/opt/homebrew/bin/bw get totp 'example site'\n  into a number field")
  assert.equal(two.allow, true)
  const unlisted = computerRequestPending(request({ site: "https://app.example", fills: [{ ...PASSWORD, field: "week" }] }))
  assert.match(unlisted.pending.command, /into a field of type week$/)
})

test("commands that cannot be shown whole can only be approved on that computer", () => {
  for (const credential of [
    { fills: [PASSWORD] },
    { site: "https://app.example", fills: [] },
    { site: "https://app.example", fills: "op read" },
    { site: "https://app.example", fills: [{ ...PASSWORD, command: ["op", "read\nSite: https://other.example"] }] },
    { site: "https://app.example", fills: [{ ...PASSWORD, command: ["./op", "read"] }] },
    { site: "https://app.example", fills: [{ ...PASSWORD, field: "" }] },
    { site: "https://app.example", fills: [{ ...PASSWORD, field: "text\n  into a password field" }] },
    { site: "https://app.example\nop read x", fills: [PASSWORD] },
    { site: "https://app.example", fills: [PASSWORD], secret: SECRET },
    { site: "https://app.example", fills: Array.from({ length: 6 }, () => ({ field: "text", command: ["op", "read", "x".repeat(400)] })) },
  ]) {
    assert.equal(computerRequestPending(request(credential)).allow, false, JSON.stringify(credential).slice(0, 120))
  }
})

test("a hidden character in a field name is shown and warned about", () => {
  const { pending } = computerRequestPending(request({ site: "https://app.example", fills: [{ ...PASSWORD, field: "te\u3164xt" }] }))
  assert.match(pending.command, /a field of type te<U\+3164>xt/)
  assert.match(pending.detail, /1 hidden character/)
})

const ASKED = { field: "password", ask: "Example password" }

test("a value that has to be pasted is described, and can only be given on that computer", () => {
  const one = computerRequestPending(request({ site: "https://app.example", fills: [ASKED] }))
  assert.equal(one.pending.title, "Fill a private value on a website")
  assert.match(one.pending.detail, /paste into OpenWork on that computer/)
  assert.match(one.pending.detail, /cannot be given from here/)
  assert.equal(one.pending.command, "Site: https://app.example\nPasted on that computer: Example password\n  into a password field")
  assert.equal(one.allow, false)
  const mixed = computerRequestPending(request({ site: "https://app.example", fills: [PASSWORD, ASKED] }))
  assert.equal(mixed.pending.title, "Fill 2 private values on a website")
  assert.equal(mixed.pending.command, "Site: https://app.example\nop read op://Private/Example/password\n  into a password field\nPasted on that computer: Example password\n  into a password field")
  assert.equal(mixed.allow, false)
})

test("a value already kept for the chat can be approved from elsewhere, alone or beside a command", () => {
  const kept = { ...ASKED, kept: true }
  const one = computerRequestPending(request({ site: "https://app.example", fills: [kept] }))
  assert.equal(one.pending.title, "Fill a private value on a website")
  assert.match(one.pending.detail, /what you kept for this chat/)
  assert.equal(one.pending.command, "Site: https://app.example\nKept for this chat: Example password\n  into a password field")
  assert.equal(one.allow, true)
  assert.equal(computerRequestPending(request({ site: "https://app.example", fills: [CODE, kept] })).allow, true)
  assert.equal(computerRequestPending(request({ site: "https://app.example", fills: [kept, ASKED] })).allow, false)
})

test("an asked value that cannot be shown whole can only be approved on that computer", () => {
  for (const fill of [
    { field: "password", ask: "Example\nSite: https://other.example", kept: true },
    { field: "password", ask: "", kept: true },
    { field: "password", ask: " padded", kept: true },
    { field: "password", ask: "x".repeat(81), kept: true },
    { field: "password", ask: "hidden‮order", kept: true },
    { ...PASSWORD, ask: "Example password", kept: true },
    { field: "", ask: "Example password", kept: true },
  ]) {
    assert.equal(computerRequestPending(request({ site: "https://app.example", fills: [fill] })).allow, false, JSON.stringify(fill))
  }
})

const LOCKED = { field: "password", command: ["/opt/homebrew/bin/bw", "get", "password", "example site"], needs: "BW_SESSION" }
const KEY = { unlock: "BW_SESSION", program: "/opt/homebrew/bin/bw", ask: "Bitwarden session key" }

test("a key a command needs is described with its variable and program, and can only be pasted on that computer", () => {
  const one = computerRequestPending(request({ site: "https://app.example", fills: [LOCKED, KEY] }))
  assert.equal(one.pending.title, "Run a command and fill what it prints on a website")
  assert.match(one.pending.detail, /needs a key that you paste into OpenWork on that computer/)
  assert.equal(one.pending.command, "Site: https://app.example\n/opt/homebrew/bin/bw get password 'example site'\n  into a password field, with BW_SESSION set\nPasted on that computer: Bitwarden session key\n  as BW_SESSION for /opt/homebrew/bin/bw")
  assert.equal(one.allow, false)
})

test("a key already kept for the chat can be approved from elsewhere", () => {
  const kept = { ...KEY, kept: true }
  const one = computerRequestPending(request({ site: "https://app.example", fills: [LOCKED, PASSWORD, kept] }))
  assert.equal(one.pending.title, "Run 2 commands and fill what they print on a website")
  assert.match(one.pending.detail, /given the key you kept for this chat/)
  assert.match(one.pending.command, /\nKept for this chat: Bitwarden session key\n  as BW_SESSION for \/opt\/homebrew\/bin\/bw$/)
  assert.equal(one.allow, true)
  assert.equal(computerRequestPending(request({ site: "https://app.example", fills: [LOCKED, ASKED, kept] })).allow, false)
  assert.equal(computerRequestPending(request({ site: "https://app.example", fills: [LOCKED, { ...ASKED, kept: true }, kept] })).allow, true)
})

test("a key row that cannot be shown whole can only be approved on that computer", () => {
  for (const key of [
    { ...KEY, kept: true, unlock: "PATH" },
    { ...KEY, kept: true, unlock: "BW SESSION" },
    { ...KEY, kept: true, ask: "key\nSite: https://other.example" },
    { ...KEY, kept: true, ask: "" },
    { ...KEY, kept: true, program: 7 },
    { ...KEY, kept: true, program: undefined },
  ]) {
    assert.equal(computerRequestPending(request({ site: "https://app.example", fills: [LOCKED, key] })).allow, false, JSON.stringify(key))
  }
})
