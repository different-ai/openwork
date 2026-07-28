import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import dotenv from "dotenv"

const srcDir = path.dirname(fileURLToPath(import.meta.url))
const serviceDir = path.resolve(srcDir, "..")

for (const filePath of [path.join(serviceDir, ".env.local"), path.join(serviceDir, ".env")]) {
  if (existsSync(filePath)) {
    dotenv.config({ path: filePath, override: false })
  }
}

dotenv.config({ override: false })
