import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("local development child processes explicitly disable shell execution", () => {
  const source = readFileSync(new URL("./dev-local.mjs", import.meta.url), "utf8")

  assert.equal(source.match(/\bspawn\(/g)?.length, 2)
  assert.equal(source.match(/shell: false/g)?.length, 2)
})
