// Prints a behaviour baseline for the plugin-system split (W0-P03): every
// registered Hono route in registration order, and the exported names (values
// and types) of each plugin-system module. Run it before and after a move and
// diff the outputs; a pure move leaves both identical.
//
//   pnpm --filter @openwork-ee/den-api plugin-system:baseline --output /tmp/before.txt

import { writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import ts from "typescript"

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

const exportFiles = [
  "src/routes/org/plugin-system/access.ts",
  "src/routes/org/plugin-system/agent-plugin-v1.ts",
  "src/routes/org/plugin-system/connector-cleanup.ts",
  "src/routes/org/plugin-system/contracts.ts",
  "src/routes/org/plugin-system/default-marketplaces.ts",
  "src/routes/org/plugin-system/github-app.ts",
  "src/routes/org/plugin-system/github-discovery.ts",
  "src/routes/org/plugin-system/projection-text.ts",
  "src/routes/org/plugin-system/routes.ts",
  "src/routes/org/plugin-system/schemas.ts",
  "src/routes/org/plugin-system/store.ts",
]

function setEnvDefault(name: string, value: string) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

function exportLists() {
  const configPath = resolve(packageDir, "tsconfig.json")
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageDir)
  const program = ts.createProgram({ options: parsed.options, rootNames: exportFiles.map((file) => resolve(packageDir, file)) })
  const checker = program.getTypeChecker()
  const lines: string[] = []
  for (const file of exportFiles) {
    const source = program.getSourceFile(resolve(packageDir, file))
    const symbol = source ? checker.getSymbolAtLocation(source) : undefined
    const names = symbol ? checker.getExportsOfModule(symbol).map((entry) => entry.getName()).sort() : []
    lines.push(`## ${file} (${names.length})`, ...names.map((name) => `  ${name}`))
  }
  return lines
}

async function routeList() {
  setEnvDefault("OPENWORK_DEV_MODE", "1")
  setEnvDefault("DB_MODE", "mysql")
  setEnvDefault("DATABASE_URL", "mysql://root:password@127.0.0.1:3306/openwork_den")
  setEnvDefault("DEN_DB_ENCRYPTION_KEY", "local-dev-db-encryption-key-please-change-1234567890")
  setEnvDefault("BETTER_AUTH_SECRET", "local-dev-secret-not-for-production-use!!")
  setEnvDefault("BETTER_AUTH_URL", "http://localhost:8790")
  setEnvDefault("DEN_AUTOMATIONS_ENABLED", "true")
  setEnvDefault("DEN_AUTOMATIONS_RUNTIME_ENABLED", "true")
  const app = (await import("../../src/app.js")).default
  return app.routes.map((route) => `${route.method} ${route.path}`)
}

const { values } = parseArgs({ options: { output: { type: "string" } } })
const routes = await routeList()
const output = [`# routes (${routes.length})`, ...routes, "", "# exports", ...exportLists(), ""].join("\n")
if (values.output) {
  await writeFile(resolve(values.output), output)
  console.log(`Wrote ${values.output}: ${routes.length} routes`)
} else {
  process.stdout.write(output)
}
// Importing the app starts background timers and pools; exit explicitly.
process.exit(0)
