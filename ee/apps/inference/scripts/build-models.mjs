import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(__dirname, "..")
const sourceDir = path.join(appDir, "src", "models")
const outputPath = path.join(appDir, "models-site", "models", "api.json")
const devMicxApi = "http://127.0.0.1:8791/api/v1"
const prodMicxApi = "https://inference.micxlabs.com/api/v1"

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"))
}

function micxProvider(models, api) {
  return {
    micx: {
      id: "micx",
      env: ["MICX_API_KEY"],
      npm: "@openrouter/ai-sdk-provider",
      name: "Micx Models",
      api,
      models,
    },
  }
}

const isDevMode = process.env.MICX_DEV_MODE === "1"
const base = await readJson(path.join(sourceDir, "base.json"))
const micxModels = await readJson(path.join(sourceDir, "micx-models.json"))
const micx = micxProvider(micxModels, isDevMode ? devMicxApi : prodMicxApi)
const models = { ...base, ...micx }

await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify(models)}\n`)

console.log(`[inference] generated ${path.relative(appDir, outputPath)} (${isDevMode ? "dev" : "prod"})`)
