import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(value: unknown, label: string) {
  assert.ok(isRecord(value), `${label} must be an object`)
  return value
}

test("Databricks GPT-5.6 models expose Max reasoning effort", async () => {
  const catalog = requireRecord(
    JSON.parse(await readFile(new URL("../src/models/base.json", import.meta.url), "utf8")),
    "catalog",
  )
  const databricks = requireRecord(catalog.databricks, "databricks provider")
  const models = requireRecord(databricks.models, "databricks models")

  for (const id of [
    "databricks-gpt-5-6-luna",
    "databricks-gpt-5-6-terra",
    "databricks-gpt-5-6-sol",
  ]) {
    const model = requireRecord(models[id], id)
    assert.ok(Array.isArray(model.reasoning_options), `${id} reasoning_options must be an array`)
    const effort = model.reasoning_options.find(
      (option) => isRecord(option) && option.type === "effort",
    )
    assert.ok(isRecord(effort), `${id} must define effort reasoning options`)
    assert.ok(Array.isArray(effort.values), `${id} effort values must be an array`)
    assert.ok(effort.values.includes("max"), `${id} must include max effort`)
  }
})
