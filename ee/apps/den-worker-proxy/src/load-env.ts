import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"

function findUpwards(startDir: string, fileName: string, maxDepth = 8) {
  let current = startDir

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const candidate = path.join(current, fileName)
    if (existsSync(candidate)) {
      return candidate
    }

    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }

  return null
}

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const serviceDir = path.resolve(srcDir, "..")

for (const filePath of [path.join(serviceDir, ".env.local"), path.join(serviceDir, ".env")]) {
  if (existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false })
  }
}

const explicitDaytonaEnvPath = process.env.OPENWORK_DAYTONA_ENV_PATH?.trim()
const detectedDaytonaEnvPath = findUpwards(path.resolve(serviceDir, "..", ".."), ".env.daytona")
const daytonaEnvPath = explicitDaytonaEnvPath || detectedDaytonaEnvPath

if (daytonaEnvPath && existsSync(daytonaEnvPath)) {
  dotenv.config({ path: daytonaEnvPath, override: false })
}

dotenv.config({ override: false })
