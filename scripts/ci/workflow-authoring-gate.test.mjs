import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import test from "node:test"

const workflow = readFileSync(new URL("../../.github/workflows/ci-tests.yml", import.meta.url), "utf8")
const gate = workflow.slice(workflow.indexOf("  openwork-tests-required:"))
const script = gate.match(/        run: \|\n([\s\S]+)$/)?.[1].split("\n").map((line) => line.slice(10)).join("\n")
assert.ok(script)

test("the required gate waits for authoring verification", () => {
  assert.match(gate, /needs: \[[^\]]*workflow-authoring[^\]]*\]/)
  assert.match(gate, /AUTHORING_RESULT: \$\{\{ needs\.workflow-authoring\.result \}\}/)
})

function runGate(lane, overrides = {}) {
  return spawnSync("bash", ["-eu", "-c", script], {
    env: { ...process.env, CLASSIFY_RESULT: "success", LANE: lane,
      CORE_RESULT: lane === "full" ? "success" : "skipped",
      BUILD_RESULT: lane === "full" ? "success" : "skipped",
      SNAPSHOT_RESULT: lane === "snapshot" ? "success" : "skipped",
      DOCS_RESULT: lane === "docs" ? "success" : "skipped",
      AUTHORING_RESULT: lane === "full" ? "success" : "skipped",
      DEN_CONTRACT: "false",
      DEN_CONTRACT_RESULT: "skipped",
      ...overrides },
    encoding: "utf8",
  })
}

for (const lane of ["full", "snapshot", "docs"]) {
  for (const authoring of ["success", "failure", "cancelled", "skipped"]) {
    test(`${lane} handles authoring=${authoring} without weakening its gate`, () => {
      const result = runGate(lane, { AUTHORING_RESULT: authoring })
      assert.equal(result.status, authoring === (lane === "full" ? "success" : "skipped") ? 0 : 1, result.stderr)
    })
  }
}

test("the required gate waits for the Den API contract check", () => {
  assert.match(gate, /needs: \[[^\]]*den-contract[^\]]*\]/)
  assert.match(gate, /DEN_CONTRACT_RESULT: \$\{\{ needs\.den-contract\.result \}\}/)
})

for (const contract of ["success", "failure", "cancelled", "skipped"]) {
  test(`a Den contract change passes only when its check succeeds (result=${contract})`, () => {
    const result = runGate("full", { DEN_CONTRACT: "true", DEN_CONTRACT_RESULT: contract })
    assert.equal(result.status, contract === "success" ? 0 : 1, result.stderr)
  })
}

for (const contract of ["success", "failure"]) {
  test(`an unaffected change blocks if the Den contract check ran anyway (result=${contract})`, () => {
    assert.equal(runGate("full", { DEN_CONTRACT: "false", DEN_CONTRACT_RESULT: contract }).status, 1)
  })
}
