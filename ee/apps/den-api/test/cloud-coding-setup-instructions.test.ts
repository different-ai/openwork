import assert from "node:assert/strict"
import { test } from "node:test"
import { buildCloudCodingSetup } from "../src/cloud-coding/mcp/setup-instructions.js"

const root = "/workspace/cloud-coding/task"
const input = { apiBaseUrl: "https://api.acme.test/", setupCode: "occ_setup_fixture", root, workFolder: `${root}/storefront` }

test("setup and push commands target the same chat's task folder", () => {
  const { setupCommand, instructions } = buildCloudCodingSetup(input)
  assert.equal(setupCommand, `mkdir -p "${root}" && curl -fsSL "https://api.acme.test/v1/cloud-coding/gateway/helper.mjs" -o "${root}/openwork-code.mjs" && node "${root}/openwork-code.mjs" setup --api "https://api.acme.test" --code "occ_setup_fixture" --root "${root}"`)
  assert.ok(instructions.split("\n").includes(`node "${root}/openwork-code.mjs" request-push --root "${root}" --branch "openwork/<short-kebab-name>" --title "<title>" --body-file "${root}/pull-request.md" --tests <passed|failed|not_run> --test-command "<cmd>" --test-summary "<one line>"`))
  for (const rule of [input.workFolder, "README, package.json, Makefile, or CI config", "smallest change", "Never push with git or look for other credentials", "Never change files under .github/workflows", "report not_run or failed", "Exit 3", "Exit 4", "Exit 0", `wait --root "${root}"`, "60 minutes"]) assert.ok(instructions.includes(rule), rule)
  assert.equal(instructions.includes(input.setupCode), false)
})

test("shell-sensitive values stay quoted in the setup command", () => {
  const { setupCommand } = buildCloudCodingSetup({ ...input, setupCode: 'a"$`\\b' })
  assert.ok(setupCommand.includes('--code "a\\"\\$\\`\\\\b"'))
})
