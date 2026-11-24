import assert from "node:assert/strict"
import { test } from "node:test"
import { featureDefinition, resolveFeature } from "./resolve.ts"

const key = "workbotConfiguredEntry"
const base = { deployment: "self_hosted", locks: {}, rollouts: {}, overrides: {} } as const

test("configured Workbot entry is declared default-off and self-hosted only", () => {
  assert.equal(featureDefinition(key).default, false)
  assert.deepEqual(featureDefinition(key).deployments, ["self_hosted"])
  assert.equal(resolveFeature(key, base).enabled, false)
})

test("an explicit operator lock turns the deployment entry rule on", () => {
  assert.equal(resolveFeature(key, { ...base, locks: { [key]: true } }).enabled, true)
})

test("the registry kill switch outranks an enabled operator lock", () => {
  const result = resolveFeature(key, { ...base, locks: { [key]: true }, rollouts: { [key]: { enabled: true, killed: true } } })
  assert.equal(result.enabled, false)
  assert.equal(result.source, "killed")
})

test("Cloud cannot acquire the self-hosted entry behavior through a lock or rollout", () => {
  assert.equal(resolveFeature(key, { ...base, deployment: "cloud", locks: { [key]: true }, rollouts: { [key]: { enabled: true, killed: false } } }).enabled, false)
})
