import { mkdir, writeFile } from "node:fs/promises"
import { STATUS_CODES } from "node:http"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type NormalizationCounts = {
  descriptionsFilled: number
  hideKeysDropped: number
  internalOperationsExcluded: number
}

const operationMethods = new Set<string>(["delete", "get", "head", "options", "patch", "post", "put", "trace"])

function setEnvDefault(name: string, value: string) {
  if (!process.env[name]?.trim()) {
    process.env[name] = value
  }
}

function seedSnapshotEnv(snapshotVersion: string) {
  // The snapshot never talks to a database or serves traffic; these values only
  // satisfy env validation so the Hono app can be imported and asked for its
  // OpenAPI document.
  setEnvDefault("OPENWORK_DEV_MODE", "1")
  setEnvDefault("DB_MODE", "mysql")
  setEnvDefault("DATABASE_URL", "mysql://root:password@127.0.0.1:3306/openwork_den")
  setEnvDefault("DEN_DB_ENCRYPTION_KEY", "local-dev-db-encryption-key-please-change-1234567890")
  setEnvDefault("BETTER_AUTH_SECRET", "local-dev-secret-not-for-production-use!!")
  setEnvDefault("BETTER_AUTH_URL", "http://den.local")
  // Published contract metadata: `servers[0].url` must point at the hosted API
  // so "Try it" works from the docs, and `info.version` must be deterministic
  // (not a git SHA) so CI can diff the regenerated document against the
  // committed one. Den API images are tagged with the app release version, so
  // the pinned latest app version is the same value production reports.
  setEnvDefault("DEN_API_PUBLIC_URL", "https://api.openworklabs.com")
  setEnvDefault("DEN_API_VERSION", snapshotVersion)
  setEnvDefault("DEN_AUTOMATIONS_ENABLED", "true")
  setEnvDefault("DEN_AUTOMATIONS_RUNTIME_ENABLED", "true")
}

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

// Operations tagged Internal (Automation runner protocol, development-only
// email outbox) stay in the served /openapi.json for debugging but are not part
// of the published contract.
const excludedTags = new Set<string>(["Internal"])

function hasExcludedTag(operation: Record<string, unknown>) {
  return Array.isArray(operation.tags) && operation.tags.some((tag) => typeof tag === "string" && excludedTags.has(tag))
}

function excludeInternalOperations(document: Record<string, unknown>, counts: NormalizationCounts) {
  const paths = document.paths
  if (!isRecord(paths)) return
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operationMethods.has(method.toLowerCase()) && isRecord(operation) && hasExcludedTag(operation)) {
        delete pathItem[method]
        counts.internalOperationsExcluded += 1
      }
    }
    if (Object.keys(pathItem).every((key) => !operationMethods.has(key.toLowerCase()))) {
      delete paths[path]
    }
  }
  if (Array.isArray(document.tags)) {
    document.tags = document.tags.filter((tag) => !(isRecord(tag) && typeof tag.name === "string" && excludedTags.has(tag.name)))
  }
}

function normalizeOpenApiDocument(document: Record<string, unknown>) {
  const counts: NormalizationCounts = { descriptionsFilled: 0, hideKeysDropped: 0, internalOperationsExcluded: 0 }
  excludeInternalOperations(document, counts)
  normalizePathItems(document.paths, counts)
  normalizePathItems(document.webhooks, counts)
  return counts
}

async function main() {
  const { denApiAppVersion } = await import("../src/version.js")
  seedSnapshotEnv(denApiAppVersion.latestAppVersion)

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
  const outputPath = resolve(repoRoot, "packages/docs/openapi.json")
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, JSON.stringify(document))

  console.log([
    `Wrote ${relative(repoRoot, outputPath)}`,
    `descriptionsFilled=${counts.descriptionsFilled}`,
    `hideKeysDropped=${counts.hideKeysDropped}`,
    `internalOperationsExcluded=${counts.internalOperationsExcluded}`,
  ].join(" "))
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exit(1)
}

// Importing the app opens database pools and auth timers that keep the event
// loop alive; the document has been written, so exit explicitly.
process.exit(0)
