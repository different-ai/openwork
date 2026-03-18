import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

function findUpwards(startDir: string, fileName: string, maxDepth = 6) {
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

function parseEnvFile(contents: string) {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) {
      continue
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) {
      continue
    }

    const key = match[1]
    let value = match[2] ?? ""

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function loadEnvFile(filePath: string) {
  if (!existsSync(filePath)) {
    return
  }

  parseEnvFile(readFileSync(filePath, "utf8"))
}

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(currentDir, "..")

for (const filePath of [
  path.join(packageDir, ".env.local"),
  path.join(packageDir, ".env"),
]) {
  loadEnvFile(filePath)
}

const explicitEnvPath =
  process.env.OPENWORK_DEN_DB_ENV_PATH?.trim() ||
  process.env.DATABASE_ENV_FILE?.trim()
const detectedRootEnvPath = findUpwards(path.resolve(packageDir, "..", ".."), ".env")
const envPath = explicitEnvPath || detectedRootEnvPath

if (envPath) {
  loadEnvFile(envPath)
}
