import { spawn } from "node:child_process"
import { readdir } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const testRoot = resolve(appRoot, "test")
const requestedFiles = process.argv.slice(2).filter((argument) => argument !== "--")
const testFiles = requestedFiles.length > 0
  ? requestedFiles.map((file) => resolve(appRoot, file))
  : (await readdir(testRoot))
      .filter((file) => file.endsWith(".test.ts"))
      .sort()
      .map((file) => resolve(testRoot, file))
const bun = process.env.DEN_API_TEST_BUN_BIN?.trim() || "bun"
const failures = []
const inheritedTestEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => ![
    "DEN_API_PUBLIC_URL",
    "DEN_AUTH_FALLBACK_BASE",
    "DEN_AUTH_ORIGIN",
    "DEN_MCP_RESOURCE_URL",
  ].includes(key)),
)
const testEnv = {
  ...inheritedTestEnv,
  BETTER_AUTH_URL: "http://127.0.0.1:8790",
  CORS_ORIGINS: "http://127.0.0.1:8790",
  DEN_API_PUBLIC_URL: "http://127.0.0.1:8790",
  PORT: "8790",
}

function runTestFile(file) {
  return new Promise((resolveRun) => {
    const child = spawn(bun, [
      "test",
      "--conditions",
      "development",
      relative(appRoot, file),
    ], {
      cwd: appRoot,
      env: testEnv,
      stdio: "inherit",
    })
    child.on("error", (error) => resolveRun({ code: 1, error }))
    child.on("exit", (code, signal) => resolveRun({ code: code ?? 1, signal }))
  })
}

for (const file of testFiles) {
  const label = relative(appRoot, file)
  console.log(`\n[den-api:test] ${label}`)
  const result = await runTestFile(file)
  if (result.code !== 0) {
    failures.push(label)
    console.error(`[den-api:test] failed: ${label}${result.signal ? ` (${result.signal})` : ""}`)
  }
}

if (failures.length > 0) {
  console.error(`\n[den-api:test] ${failures.length} isolated file(s) failed:`)
  for (const file of failures) console.error(`- ${file}`)
  process.exitCode = 1
} else {
  console.log(`\n[den-api:test] ${testFiles.length} isolated file(s) passed.`)
}
