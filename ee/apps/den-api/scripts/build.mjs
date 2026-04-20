import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serviceDir = path.resolve(scriptDir, "..")
const repoRoot = path.resolve(serviceDir, "..", "..", "..")
const desktopPackagePath = path.join(repoRoot, "apps", "desktop", "package.json")
const generatedVersionPath = path.join(serviceDir, "src", "generated", "app-version.ts")
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const fallbackAppVersion = "0.0.0"

function readDesktopVersion() {
  if (!existsSync(desktopPackagePath)) {
    // The Den API is built inside contexts (e.g. the Docker image used by
    // `packaging/docker/den-dev-up.sh`) that intentionally do not ship the
    // Tauri desktop sources. Falling back lets the container image build
    // without copying unrelated packages; consumers that need the real
    // version can override via DEN_API_LATEST_APP_VERSION.
    console.warn(`Desktop package.json not found at ${desktopPackagePath}; using fallback version ${fallbackAppVersion}`)
    return fallbackAppVersion
  }

  const packageJson = JSON.parse(readFileSync(desktopPackagePath, "utf8"))
  const version = packageJson.version?.trim()

  if (!version) {
    throw new Error(`Desktop version missing in ${desktopPackagePath}`)
  }

  return version
}

function writeGeneratedVersionFile(latestAppVersion) {
  mkdirSync(path.dirname(generatedVersionPath), { recursive: true })
  writeFileSync(
    generatedVersionPath,
    `export const BUILD_LATEST_APP_VERSION = ${JSON.stringify(latestAppVersion)} as const\n`,
  )
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: serviceDir,
    env: process.env,
    stdio: "inherit",
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

process.env.DEN_API_LATEST_APP_VERSION = process.env.DEN_API_LATEST_APP_VERSION || readDesktopVersion()
writeGeneratedVersionFile(process.env.DEN_API_LATEST_APP_VERSION)

run(pnpmCommand, ["run", "build:den-db"])
run(pnpmCommand, ["exec", "tsc", "-p", "tsconfig.json"])
