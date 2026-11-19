// Builds the published model catalog, served from models.openworklabs.com:
//   models-site/models/api.json                    models.dev v1 shape (/api.json)
//   models-site/models/experimental/v2.0/api.json  models.dev v2 shape, which
//                                                  OpenCode v2 engines read first
// Each is its base snapshot, then every validated src/models/providers/*.json,
// then the OpenWork provider from openwork-models.json. A bad provider file
// fails the build.
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readPublishedCatalog } from "../src/models/catalog.ts"
import { readPublishedCatalogV2 } from "../src/models/catalog-v2.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, "..")
const siteDir = path.join(appDir, "models-site", "models")
const outputs = [
  { path: path.join(siteDir, "api.json"), read: readPublishedCatalog },
  { path: path.join(siteDir, "experimental", "v2.0", "api.json"), read: readPublishedCatalogV2 },
]
const devOpenworkApi = "http://127.0.0.1:8791/api/v1"
const prodOpenworkApi = "https://inference.openworklabs.com/api/v1"

const isDevMode = process.env.OPENWORK_DEV_MODE === "1"
const openworkApi = isDevMode ? devOpenworkApi : prodOpenworkApi

for (const output of outputs) {
  const models = output.read(openworkApi)
  await mkdir(path.dirname(output.path), { recursive: true })
  await writeFile(output.path, `${JSON.stringify(models)}\n`)
  console.log(`[gateway] generated ${path.relative(appDir, output.path)} (${isDevMode ? "dev" : "prod"})`)
}
