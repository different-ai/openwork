import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { analyzeStrictImpact, validateStrictPaths } from "./spec-impact.mjs"

const script = fileURLToPath(new URL("./spec-impact.mjs", import.meta.url))
const configPath = fileURLToPath(new URL("../specs/spec-impact-strict-paths.json", import.meta.url))
const config = validateStrictPaths(JSON.parse(readFileSync(configPath, "utf8")))
const providerAuthStore = "apps/app/src/react-app/domains/connections/provider-auth/store.ts"

test("strict paths require a spec or test change for protected surfaces", () => {
  const run = (...changedFiles) => spawnSync(process.execPath, [
    script,
    "--strict-paths",
    configPath,
    ...changedFiles.flatMap((pathname) => ["--changed-file", pathname]),
  ])
  assert.equal(run(providerAuthStore).status, 2)
  assert.equal(run(providerAuthStore, "evals/specs/provider-auth.test.ts").status, 0)
  assert.equal(run("packages/docs/provider-auth.md").status, 0)
  assert.equal(analyzeStrictImpact(config, ["ee/apps/den-api/src/routes/org/sso.ts"]).required, true)
})
