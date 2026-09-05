import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createCliScenario } from "../src/cli-scenario.js"

test("CLI rejects an unknown active fault before starting the server", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PROFILE_ID: "synthetic-enterprise-oauth-mcp",
        ACTIVE_FAULT_ID: "not-a-real-fault",
      },
    },
  )

  assert.equal(result.status, 1)
  assert.match(result.stderr, /Invalid ACTIVE_FAULT_ID 'not-a-real-fault'/)
  assert.match(result.stderr, /Valid ids: .*oauth-missing-auth-challenge/)
})

test("CLI scenario activates a known fault with the always trigger", () => {
  const scenario = createCliScenario("synthetic-enterprise-oauth-mcp", "oauth-issuer-mismatch")

  assert.deepEqual(scenario.activeFault, {
    id: "oauth-issuer-mismatch",
    trigger: { occurrence: "always" },
  })
})
