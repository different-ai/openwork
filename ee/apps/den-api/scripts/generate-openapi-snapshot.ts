import { mkdir, writeFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { publicOpenApiDocument } from "../src/openapi-public.js"
import { formatOpenApiSnapshot } from "./openapi-snapshot-format.js"

function setEnvDefault(name: string, value: string) {
  if (!process.env[name]?.trim()) {
    process.env[name] = value
  }
}

function seedSnapshotEnv(snapshotVersion: string) {
  // Schema export serves no traffic, but importing Better Auth registers OAuth
  // resources in MySQL. `pnpm den:contract` supplies a prepared disposable DB;
  // these defaults also support direct `pnpm api:snapshot` with a local schema.
  setEnvDefault("OPENWORK_DEV_MODE", "1")
  setEnvDefault("DB_MODE", "mysql")
  setEnvDefault("DATABASE_URL", "mysql://root:password@127.0.0.1:3306/openwork_den")
  setEnvDefault("DEN_DB_ENCRYPTION_KEY", "local-dev-db-encryption-key-please-change-1234567890")
  setEnvDefault("BETTER_AUTH_SECRET", "local-dev-secret-not-for-production-use!!")
  setEnvDefault("BETTER_AUTH_URL", "http://localhost:8790")
  // Published contract metadata: `servers[0].url` must point at the hosted API
  // so "Try it" works from the docs, and `info.version` must be deterministic
  // (not a git SHA). Den API images use the app release version, so the pinned
  // latest app version is the same value production reports.
  setEnvDefault("DEN_API_PUBLIC_URL", "https://api.openworklabs.com")
  setEnvDefault("DEN_API_VERSION", snapshotVersion)
  setEnvDefault("DEN_AUTOMATIONS_ENABLED", "true")
  setEnvDefault("DEN_AUTOMATIONS_RUNTIME_ENABLED", "true")
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
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error("OpenAPI response was not a JSON object.")
  }

  const { document: published, counts } = publicOpenApiDocument(document)
  const scriptDir = dirname(fileURLToPath(import.meta.url))
  const repoRoot = resolve(scriptDir, "../../../..")
  const { values } = parseArgs({ options: { output: { type: "string" } } })
  const outputPath = values.output
    ? resolve(values.output)
    : resolve(repoRoot, "packages/docs/openapi.json")
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, formatOpenApiSnapshot(published))

  console.log([
    `Wrote ${relative(repoRoot, outputPath)}`,
    `descriptionsFilled=${counts.descriptionsFilled}`,
    `socialDescriptionsFilled=${counts.socialDescriptionsFilled}`,
    `hideKeysDropped=${counts.hideKeysDropped}`,
    `internalOperationsExcluded=${counts.internalOperationsExcluded}`,
    `orphanSchemasPruned=${counts.orphanSchemasPruned}`,
  ].join(" "))
}

try {
  await main()
} catch (error) {
  console.error(error)
  process.exit(1)
}

// Importing the app starts background service timers and opens pools that keep
// the event loop alive; the document has been written, so exit explicitly.
process.exit(0)
