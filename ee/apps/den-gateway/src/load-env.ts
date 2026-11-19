import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"

let serviceDir = path.dirname(fileURLToPath(import.meta.url))
while (!existsSync(path.join(serviceDir, "package.json")) && path.dirname(serviceDir) !== serviceDir) {
  serviceDir = path.dirname(serviceDir)
}

for (const filePath of [path.join(serviceDir, ".env.local"), path.join(serviceDir, ".env")]) {
  if (existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false })
  }
}

dotenv.config({ override: false })
