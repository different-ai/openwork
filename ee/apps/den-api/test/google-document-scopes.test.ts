import assert from "node:assert/strict"
import { test } from "node:test"
import { canWriteDriveDocument } from "../src/routes/org/google-document-scopes.js"

const write = "https://www.googleapis.com/auth/drive"
test("Office writes require the complete Drive grant from both the account and connector policy", () => {
  assert.equal(canWriteDriveDocument([write], [write]), true)
  assert.equal(canWriteDriveDocument(undefined, [write]), false)
  assert.equal(canWriteDriveDocument(null, [write]), false)
  assert.equal(canWriteDriveDocument([write], []), false)
  for (const grant of [`${write}.readonly`, `${write}.file`, `${write}/extra`, `https://untrusted.example/${write}`, `${write}.untrusted.example`]) {
    assert.equal(canWriteDriveDocument([grant], [write]), false, `account grant ${grant}`)
    assert.equal(canWriteDriveDocument([write], [grant]), false, `connector grant ${grant}`)
  }
})
