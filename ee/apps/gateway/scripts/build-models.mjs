// Builds models-site/models/api.json, published at models.openworklabs.com/api.json:
// base.json, then every validated src/models/providers/*.json, then the OpenWork
// provider from openwork-models.json. A bad provider file fails the build.
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readPublishedCatalog } from "../src/models/catalog.ts"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, "..")
const outputPath = path.join(appDir, "models-site", "models", "api.json")
const devOpenworkApi = "http://127.0.0.1:8791/api/v1"
const prodOpenworkApi = "https://inference.openworklabs.com/api/v1"

const isDevMode = process.env.OPENWORK_DEV_MODE === "1"
const models = readPublishedCatalog(isDevMode ? devOpenworkApi : prodOpenworkApi)

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(models)}\n`)

console.log(`[gateway] generated ${path.relative(appDir, outputPath)} (${isDevMode ? "dev" : "prod"})`)
