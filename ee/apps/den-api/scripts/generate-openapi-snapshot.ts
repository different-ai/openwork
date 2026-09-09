import { mkdir, writeFile } from "node:fs/promises"
import { STATUS_CODES } from "node:http"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

import { seedSnapshotEnv } from "./openapi-snapshot-env.js"

type NormalizationCounts = {
  descriptionsFilled: number
  hideKeysDropped: number
}

const operationMethods = new Set<string>(["delete", "get", "head", "options", "patch", "post", "put", "trace"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function responseDescription(status: string) {
  if (status === "default") return "Default response"
  const reason = STATUS_CODES[status]
  return reason ?? `${status} response`
}

function normalizeResponses(responses: unknown, counts: NormalizationCounts) {
  if (!isRecord(responses)) return
  for (const [status, response] of Object.entries(responses)) {
    if (!isRecord(response) || typeof response.$ref === "string") continue
    if (typeof response.description !== "string") {
      response.description = responseDescription(status)
      counts.descriptionsFilled += 1
    }
  }
}

function normalizePathItem(pathItem: Record<string, unknown>, counts: NormalizationCounts) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (operationMethods.has(method.toLowerCase()) && isRecord(operation)) {
      normalizeOperation(operation, counts)
    }
  }
}

function normalizeCallback(callback: Record<string, unknown>, counts: NormalizationCounts) {
  for (const pathItem of Object.values(callback)) {
    if (isRecord(pathItem)) normalizePathItem(pathItem, counts)
  }
}

function normalizeOperation(operation: Record<string, unknown>, counts: NormalizationCounts) {
  if (Object.hasOwn(operation, "hide")) {
    delete operation.hide
    counts.hideKeysDropped += 1
  }

  normalizeResponses(operation.responses, counts)

  const callbacks = operation.callbacks
  if (!isRecord(callbacks)) return
  for (const callback of Object.values(callbacks)) {
    if (isRecord(callback)) normalizeCallback(callback, counts)
  }
}

function normalizePathItems(pathItems: unknown, counts: NormalizationCounts) {
  if (!isRecord(pathItems)) return
  for (const pathItem of Object.values(pathItems)) {
    if (isRecord(pathItem)) normalizePathItem(pathItem, counts)
  }
}

function normalizeOpenApiDocument(document: Record<string, unknown>) {
  const counts: NormalizationCounts = { descriptionsFilled: 0, hideKeysDropped: 0 }
  normalizePathItems(document.paths, counts)
  normalizePathItems(document.webhooks, counts)
  return counts
}

async function main() {
  seedSnapshotEnv(process.env)

  const app = (await import("../src/app.js")).default
  const response = await app.request("http://den-api.local/openapi.json")
  if (!response.ok) {
    throw new Error(`Failed to generate OpenAPI snapshot: HTTP ${response.status}`)
  }

  const document: unknown = await response.json()
  if (!isRecord(document)) {
    throw new Error("OpenAPI response was not a JSON object.")
  }

  const counts = normalizeOpenApiDocument(document)
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(scriptDir, "../../../..")
  const { values } = parseArgs({ options: { output: { type: "string" } } })
  const outputPath = values.output
    ? resolve(values.output)
    : resolve(repoRoot, "packages/docs/openapi.json")
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(document))

  console.log([
    `Wrote ${relative(repoRoot, outputPath)}`,
    `descriptionsFilled=${counts.descriptionsFilled}`,
    `hideKeysDropped=${counts.hideKeysDropped}`,
  ].join(" "))
}

await main()
// Importing the app starts background service timers; this one-shot exporter
// must finish without waiting for those services after the file is written.
process.exit(0)
