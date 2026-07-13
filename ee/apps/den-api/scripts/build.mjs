import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptPath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(scriptPath)
const serviceDir = path.resolve(scriptDir, "..")
const repoRoot = path.resolve(serviceDir, "..", "..", "..")
const desktopPackagePath = path.join(repoRoot, "apps", "desktop", "package.json")
const generatedVersionPath = path.join(serviceDir, "src", "generated", "app-version.ts")
const distDir = path.join(serviceDir, "dist")
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm"
const fallbackAppVersion = "0.0.0"
export const sentrySourcemapUploadFlag = "DEN_UPLOAD_SENTRY_SOURCEMAPS"
export const requiredSentrySourcemapEnv = ["SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT", "SENTRY_RELEASE"]

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

export function envFlagEnabled(value) {
  return value === "1" || value === "true" || value === "yes"
}

export function shouldUploadSentrySourcemaps(env = process.env) {
  return envFlagEnabled(env[sentrySourcemapUploadFlag])
}

export function missingSentrySourcemapUploadEnv(env = process.env) {
  return requiredSentrySourcemapEnv.filter((key) => !env[key]?.trim())
}

export function requireSentrySourcemapUploadEnv(env = process.env) {
  const missing = missingSentrySourcemapUploadEnv(env)
  if (missing.length > 0) {
    throw new Error(`${sentrySourcemapUploadFlag}=1 requires ${missing.join(", ")}`)
  }
}

function cleanDist() {
  rmSync(distDir, { recursive: true, force: true })
}

function maybeUploadSentrySourcemaps() {
  if (!shouldUploadSentrySourcemaps()) {
    return
  }
  requireSentrySourcemapUploadEnv()

  const uploadArgs = [
    "exec",
    "sentry-cli",
    "sourcemaps",
    "upload",
    "--release",
    process.env.SENTRY_RELEASE,
    "--url-prefix",
    "~/",
  ]
  if (process.env.SENTRY_DIST) {
    uploadArgs.push("--dist", process.env.SENTRY_DIST)
  }
  uploadArgs.push("dist")

  run(pnpmCommand, ["exec", "sentry-cli", "sourcemaps", "inject", "dist"])
  run(pnpmCommand, uploadArgs)
}

function main() {
  process.env.DEN_API_LATEST_APP_VERSION = process.env.DEN_API_LATEST_APP_VERSION || readDesktopVersion()
  writeGeneratedVersionFile(process.env.DEN_API_LATEST_APP_VERSION)
  cleanDist()

  run(pnpmCommand, ["run", "build:email"])
  run(pnpmCommand, ["run", "build:install-config"])
  run(pnpmCommand, ["run", "build:enterprise-mcp-client"])
  run(pnpmCommand, ["run", "build:den-db"])
  run(pnpmCommand, ["exec", "tsc", "-p", "tsconfig.json"])
  maybeUploadSentrySourcemaps()
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main()
}
