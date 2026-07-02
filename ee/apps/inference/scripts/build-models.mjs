import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, "..")
const sourceDir = path.join(appDir, "src", "models")
const outputPath = path.join(appDir, "models-site", "models", "api.json")
const devOpenworkApi = "http://127.0.0.1:8791/api/v1"
const prodOpenworkApi = "https://inference.openworklabs.com/api/v1"

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

function openworkProvider(models, api) {
  return {
    openwork: {
      id: "openwork",
      env: ["OPENWORK_API_KEY"],
      npm: "@openrouter/ai-sdk-provider",
      name: "OpenWork Models",
      api,
      models,
    },
  }
}

const isDevMode = process.env.OPENWORK_DEV_MODE === "1"
const base = await readJson(path.join(sourceDir, "base.json"))
const openworkModels = await readJson(path.join(sourceDir, "openwork-models.json"))
const openwork = openworkProvider(openworkModels, isDevMode ? devOpenworkApi : prodOpenworkApi)
const models = { ...base, ...openwork }

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(models)}\n`)

console.log(`[inference] generated ${path.relative(appDir, outputPath)} (${isDevMode ? "dev" : "prod"})`)
