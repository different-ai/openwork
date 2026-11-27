import assert from "node:assert/strict"
import { test } from "node:test"
import {
  COMPUTER_OUTPUT_MAX_BYTES,
  computerAccessReportSchema,
  computerActionSchema,
  computerCommandCompleteRequestSchema,
  computerDecisionSchema,
  computerFolderSchema,
  computerGrantScopeSchema,
} from "@openwork/types/den/computers"

const scope = { surface: "sandbox", folders: ["/a/logs"] }

function numberedFolders(count: number) {
  return Array.from({ length: count }, (_, index) => `/logs/${index}`)
}

test("grants can only name the sandbox and up to 32 unique folders", () => {
  assert.deepEqual(computerGrantScopeSchema.parse(scope), scope)
  assert.equal(computerGrantScopeSchema.safeParse({ surface: "sandbox", folders: [] }).success, true)
  assert.equal(computerGrantScopeSchema.safeParse({ surface: "sandbox", folders: numberedFolders(32) }).success, true)
  for (const surface of ["whole_machine", "host", "", null, undefined]) {
    assert.equal(computerGrantScopeSchema.safeParse({ ...scope, surface }).success, false)
  }
  assert.equal(computerGrantScopeSchema.safeParse({ ...scope, wholeMachine: true }).success, false)
  assert.equal(computerGrantScopeSchema.safeParse({ ...scope, folders: ["/a/logs", "/a/logs"] }).success, false)
  assert.equal(computerGrantScopeSchema.safeParse({ ...scope, folders: numberedFolders(33) }).success, false)
})

test("folder paths are bounded absolute POSIX paths with no ambiguous segments", () => {
  for (const path of ["/a", "/a/logs", "/a/my logs", "/a/.hidden", "/a/logs..", "/" + "x".repeat(1023)]) {
    assert.equal(computerFolderSchema.parse(path), path)
  }
  for (const path of [
    "", "logs", "C:/logs", "/", "/a/", "//a", "/a//logs", "/.", "/..", "/a/.", "/a/..", "/a/./logs", "/a/../logs",
    "/a\\logs", "/a\0", "/a\n", "/a\t", "/a\u007f", "/a\u0085", "/" + "x".repeat(1024),
  ]) {
    assert.equal(computerFolderSchema.safeParse(path).success, false, JSON.stringify(path))
  }
})

test("shell actions enforce command length, timeout bounds and folder rules", () => {
  const shell = { type: "shell", command: "true" }
  assert.deepEqual(computerActionSchema.parse(shell), shell)
  assert.equal(computerActionSchema.safeParse({ ...shell, command: "x", cwd: "/a", timeoutMs: 1 }).success, true)
  assert.equal(computerActionSchema.safeParse({ ...shell, command: "x".repeat(32_000), timeoutMs: 120_000 }).success, true)
  for (const fields of [
    { command: "" }, { command: "x".repeat(32_001) }, { timeoutMs: 0 }, { timeoutMs: 120_001 }, { timeoutMs: 2.5 },
    { cwd: "/a/../logs" }, { cwd: "/" }, { type: "other" },
  ]) {
    assert.equal(computerActionSchema.safeParse({ ...shell, ...fields }).success, false)
  }
})

test("access reports are strict and cap grants and folders", () => {
  const source = { kind: "workbot" }
  const entry = { source, folders: numberedFolders(32) }
  const report = { choice: "allow", grants: [entry] }
  const grants = Array.from({ length: 16 }, (_, id) => ({ ...entry, source: { kind: "computer", id: String(id) } }))
  for (const choice of ["allow", "off", null]) {
    assert.deepEqual(computerAccessReportSchema.parse({ choice, grants }), { choice, grants })
  }
  assert.deepEqual(computerAccessReportSchema.parse(report), report)
  assert.deepEqual(computerAccessReportSchema.parse({ choice: null, grants: [] }), { choice: null, grants: [] })
  for (const changes of [
    { choice: true }, { extra: true }, { grants: [...grants, entry] }, { grants: [{ ...entry, folders: numberedFolders(33) }] },
    { grants: [{ source, folders: ["/logs", "/logs"] }] }, { grants: [{ source, folders: ["/"] }] },
    { grants: [{ ...entry, surface: "host" }] }, { grants: [{ ...entry, source: { kind: "computer" } }] },
  ]) {
    assert.equal(computerAccessReportSchema.safeParse({ ...report, ...changes }).success, false)
  }
})

test("only a direct allowance can have a null scope", () => {
  assert.equal(computerDecisionSchema.safeParse({ outcome: "allow", route: "direct", scope: null }).success, true)
  assert.equal(computerDecisionSchema.safeParse({ outcome: "allow", route: "checked", scope }).success, true)
  assert.equal(computerDecisionSchema.safeParse({ outcome: "allow", route: "direct", scope }).success, false)
  assert.equal(computerDecisionSchema.safeParse({ outcome: "allow", route: "checked", scope: null }).success, false)
})

test("command completion caps UTF-8 bytes, not just string length", () => {
  const done = { status: "done", exitCode: 0, truncated: false }
  for (const output of ["", "x".repeat(COMPUTER_OUTPUT_MAX_BYTES), "é".repeat(COMPUTER_OUTPUT_MAX_BYTES / 2)]) {
    assert.equal(computerCommandCompleteRequestSchema.safeParse({ ...done, output }).success, true)
  }
  for (const output of ["x".repeat(COMPUTER_OUTPUT_MAX_BYTES + 1), "é".repeat(COMPUTER_OUTPUT_MAX_BYTES / 2) + "x"]) {
    assert.equal(computerCommandCompleteRequestSchema.safeParse({ ...done, output }).success, false)
  }
})

test("failed command completion has a bounded snake_case code and message", () => {
  const valid = { code: "runner_failed", message: "x".repeat(300) }
  assert.equal(computerCommandCompleteRequestSchema.safeParse({ status: "failed", error: valid }).success, true)
  for (const error of [
    { ...valid, code: "runner-failed" }, { ...valid, code: "RunnerFailed" }, { ...valid, code: "x".repeat(65) },
    { ...valid, message: "x".repeat(301) },
  ]) {
    assert.equal(computerCommandCompleteRequestSchema.safeParse({ status: "failed", error }).success, false)
  }
})
