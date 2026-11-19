import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

// Production runs plain Node, not tsx: extensionless imports accepted by the
// development loader can otherwise build successfully and crash the Den API.
test("automation models load in plain Node with production export conditions", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict"
    import { automationModelOptions, cloudDefaultModelOption } from "./packages/types/src/automation-models.ts"
    assert.deepEqual(automationModelOptions([], { includeCloudDefault: true, includeFreeStarter: false }), [cloudDefaultModelOption])
  `], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
