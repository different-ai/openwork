import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  WorkspacePortabilityError,
  isAllowedPortableFilePath,
  normalizePortableFile,
  normalizePortablePath,
} from "../src/index.js"

describe("portable workspace paths", () => {
  it("normalizes separators without accepting traversal", () => {
    assert.equal(normalizePortablePath("./.opencode\\tools//run.ts"), ".opencode/tools/run.ts")
    assert.throws(
      () => normalizePortablePath("../outside.md"),
      (error) =>
        error instanceof WorkspacePortabilityError &&
        error.code === "invalid_portable_file_path" &&
        /invalid/i.test(error.message),
    )
    assert.throws(() => normalizePortablePath(""), /required/i)
    assert.throws(() => normalizePortablePath(".opencode/tools/bad\0name.ts"), /invalid byte/i)
  })

  it("allows only shareable OpenCode directories", () => {
    assert.equal(isAllowedPortableFilePath(".opencode/agents/reviewer.md"), true)
    assert.equal(isAllowedPortableFilePath(".opencode/plugins/demo/index.ts"), true)
    assert.equal(isAllowedPortableFilePath(".opencode/tools/run.ts"), true)
    assert.equal(isAllowedPortableFilePath(".opencode/.env"), false)
    assert.equal(isAllowedPortableFilePath(".opencode/tools/.env.local"), false)
    assert.equal(isAllowedPortableFilePath(".opencode/node_modules/demo/index.js"), false)
    assert.equal(isAllowedPortableFilePath(".opencode/package.json"), false)
  })

  it("normalizes portable file values and exposes stable error codes", () => {
    assert.deepEqual(normalizePortableFile({ path: ".opencode/tools/run.ts", content: 42 }), {
      path: ".opencode/tools/run.ts",
      content: "42",
    })
    assert.throws(
      () => normalizePortableFile(null),
      (error) =>
        error instanceof WorkspacePortabilityError &&
        error.code === "invalid_portable_file",
    )
    assert.throws(
      () => normalizePortableFile({ path: ".opencode/openwork.json", content: "{}" }),
      (error) =>
        error instanceof WorkspacePortabilityError &&
        error.code === "invalid_portable_file_path" &&
        /not allowed/i.test(error.message),
    )
  })
})
