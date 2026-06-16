import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const serviceDir = path.resolve(scriptDir, "..")
const repoRoot = path.resolve(serviceDir, "..", "..", "..")
const desktopPackagePath = path.join(repoRoot, "apps", "desktop", "package.json")
const generatedVersionPath = path.join(serviceDir, "src", "generated", "app-version.ts")
const pnpmCommand = "pnpm"
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

export function quoteShellArg(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`
}

export function createPnpmSpawnInput(command, args, platform = process.platform) {
  const useShell = platform === "win32"
  return {
    command: useShell ? [command, ...args].map(quoteShellArg).join(" ") : command,
    args: useShell ? [] : args,
    shell: useShell,
  }
}

export function createPackageManagerSpawnInput(args, options = {}) {
  const npmExecPath = options.npmExecPath ?? process.env.npm_execpath
  const npmExecPathExists = npmExecPath
    ? options.npmExecPathExists ?? existsSync(npmExecPath)
    : false
  if (npmExecPath && npmExecPathExists) {
    return {
      command: options.nodeCommand ?? process.execPath,
      args: [npmExecPath, ...args],
      shell: false,
    }
  }

  return createPnpmSpawnInput(pnpmCommand, args, options.platform ?? process.platform)
}

function run(args) {
  const input = createPackageManagerSpawnInput(args)
  const result = spawnSync(input.command, input.args, {
    cwd: serviceDir,
    env: process.env,
    stdio: "inherit",
    shell: input.shell,
  })

  if (result.error) {
    console.error(result.error)
    process.exit(1)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function main() {
  process.env.DEN_API_LATEST_APP_VERSION = process.env.DEN_API_LATEST_APP_VERSION || readDesktopVersion()
  writeGeneratedVersionFile(process.env.DEN_API_LATEST_APP_VERSION)

  run(["run", "build:email"])
  run(["run", "build:den-db"])
  run(["exec", "tsc", "-p", "tsconfig.json"])
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
