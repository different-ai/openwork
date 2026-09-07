import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const helm = process.env.HELM_BINARY
const chart = fileURLToPath(new URL("../../../../packaging/helm/openwork-ee", import.meta.url))

test("Helm retention is opt-in, daily, bounded, internal-only and uses the gateway's same Secret", { skip: !helm }, () => {
  assert.ok(helm)
  const render = (args: string[]) => spawnSync(helm, ["template", "accounting", chart, ...args], { encoding: "utf8" })
  const disabled = render([])
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.equal(disabled.stdout.includes("kind: CronJob"), false)
  const enabled = render(["--set", "inference.enabled=true", "--set", "inference.retention.enabled=true", "--set", "inference.retention.adminTokenSecret=accounting-secret"])
  assert.equal(enabled.status, 0, enabled.stderr)
  assert.match(enabled.stdout, /kind: CronJob/)
  assert.match(enabled.stdout, /schedule: "0 3 \* \* \*"/)
  assert.match(enabled.stdout, /timeZone: "Etc\/UTC"/)
  assert.match(enabled.stdout, /concurrencyPolicy: Forbid/)
  assert.match(enabled.stdout, /backoffLimit: 2/)
  assert.match(enabled.stdout, /activeDeadlineSeconds: 600/)
  assert.match(enabled.stdout, /http:\/\/accounting-openwork-ee-inference:8791\/internal\/rollups\/run/)
  assert.equal((enabled.stdout.match(/name: "accounting-secret"/g) ?? []).length, 2)
  assert.equal((enabled.stdout.match(/key: "INFERENCE_ADMIN_TOKEN"/g) ?? []).length, 2)
  const retention = enabled.stdout.split("\n---").find((document) => document.includes("kind: CronJob"))
  assert.ok(retention)
  assert.equal(retention.includes("error.message"), false)
})

test("Helm rejects a missing token reference or competing inline token", { skip: !helm }, () => {
  assert.ok(helm)
  const args = ["template", "accounting", chart, "--set", "inference.enabled=true", "--set", "inference.retention.enabled=true"]
  const missing = spawnSync(helm, args, { encoding: "utf8" })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /adminTokenSecret is required/)
  const conflicting = spawnSync(helm, [...args, "--set", "inference.retention.adminTokenSecret=accounting-secret", "--set", "inference.env.INFERENCE_ADMIN_TOKEN=fake-value"], { encoding: "utf8" })
  assert.notEqual(conflicting.status, 0)
  assert.match(conflicting.stderr, /Use inference.retention.adminTokenSecret/)
})
