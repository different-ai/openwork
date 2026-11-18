import assert from "node:assert/strict"
import { test } from "node:test"
import { resolve } from "node:path"
import { headlessSessionAccess, readLocationSessionChoices } from "./remote-access.ts"

const home = resolve("/example/home")
const workspace = resolve(home, "workspace")
const policy = { ceiling: "created", optIn: true }

test("consent is deny-by-default, exact-directory only, and never all-session access", () => {
  for (const value of [undefined, null, true, "created", [], {}, { [workspace]: "all" }, { [workspace]: true }, { workspace: "created" }]) {
    assert.equal(headlessSessionAccess(readLocationSessionChoices(value), workspace, policy), "off")
  }
  const choices = readLocationSessionChoices({ [workspace]: "created", [home]: "off" })
  assert.equal(headlessSessionAccess(choices, workspace, policy), "created")
  for (const directory of [home, resolve(workspace, "nested"), resolve(home, "sibling")]) {
    assert.equal(headlessSessionAccess(choices, directory, policy), "off")
  }
  assert.equal(headlessSessionAccess(choices, workspace, { ceiling: "all", optIn: true }), "created")
})

test("the organization can narrow consent; missing, old and unknown policies fail closed", () => {
  const choices = readLocationSessionChoices({ [workspace]: "created" })
  for (const value of [undefined, null, {}, { ceiling: "created" }, { ceiling: "created", optIn: "true" }, { ceiling: "future", optIn: true }, { ceiling: "off", optIn: false }]) {
    assert.equal(headlessSessionAccess(choices, workspace, value), "off")
  }
  assert.equal(headlessSessionAccess(choices, workspace, { ceiling: "created", optIn: false }), "created")
})
