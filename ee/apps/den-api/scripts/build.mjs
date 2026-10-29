import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: serviceDir,
    env,
    stdio: "inherit",
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

// Even with shared declaration boundaries, den-api exceeds Node's default
// heap cap. Raise only the tsc heap; an explicit
// --max-old-space-size in NODE_OPTIONS, or DEN_API_TSC_MAX_OLD_SPACE_MB, wins.
export const tscHeapEnvFlag = "DEN_API_TSC_MAX_OLD_SPACE_MB"
export const defaultTscHeapMb = 6144

export function tscBuildEnv(env = process.env) {
  const nodeOptions = env.NODE_OPTIONS?.trim() ?? ""
  if (/--max-old-space-size[= ]/.test(nodeOptions)) return env
  const override = Number.parseInt(env[tscHeapEnvFlag] ?? "", 10)
  const heapMb = Number.isInteger(override) && override > 0 ? override : defaultTscHeapMb
  return { ...env, NODE_OPTIONS: [nodeOptions, `--max-old-space-size=${heapMb}`].filter(Boolean).join(" ") }
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

function productionExportTarget(value) {
  if (typeof value === "string") {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(productionExportTarget).find(Boolean)
  }
  if (!value || typeof value !== "object") {
    return undefined
  }

  for (const [condition, target] of Object.entries(value)) {
    if (["node", "import", "default"].includes(condition)) {
      const resolved = productionExportTarget(target)
      if (resolved) return resolved
    }
  }
  return undefined
}

function missingWorkspaceExports(packageDir, checkExport) {
  const visited = new Set()
  const missing = []

  function visit(currentDir) {
    const packageJsonPath = path.join(currentDir, "package.json")
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))
    if (visited.has(packageJson.name)) return
    visited.add(packageJson.name)

    for (const [dependency, version] of Object.entries(packageJson.dependencies ?? {})) {
      if (typeof version !== "string" || !version.startsWith("workspace:")) continue

      const dependencyDir = path.dirname(path.join(currentDir, "node_modules", dependency, "package.json"))
      const dependencyPackageJson = JSON.parse(readFileSync(path.join(dependencyDir, "package.json"), "utf8"))
      const exports = dependencyPackageJson.exports
      const exportEntries = exports && typeof exports === "object" && !Array.isArray(exports)
        && Object.keys(exports).some((key) => key.startsWith("."))
        ? Object.entries(exports)
        : [[".", exports]]

      for (const [subpath, value] of exportEntries) {
        const problem = checkExport(value, dependencyDir)
        if (problem) missing.push(`${dependency}${subpath === "." ? "" : subpath.slice(1)}: ${problem}`)
      }
      visit(dependencyDir)
    }
  }

  visit(packageDir)
  return missing.sort()
}

export function missingProductionWorkspaceExports(packageDir = serviceDir) {
  return missingWorkspaceExports(packageDir, (value, dependencyDir) => {
    const target = productionExportTarget(value)
    return target && !existsSync(path.resolve(dependencyDir, target)) ? target : undefined
  })
}

export function missingProductionWorkspaceTypes(packageDir = serviceDir) {
  return missingWorkspaceExports(packageDir, (value, dependencyDir) => {
    const types = value?.types
    if (!types) {
      const target = productionExportTarget(value)
      return /\.tsx?$/.test(target ?? "") ? "missing openwork-build declaration export" : undefined
    }
    const target = typeof types === "string" ? types : types["openwork-build"]
    if (!target?.endsWith(".d.ts")) return "missing openwork-build declaration export"
    return existsSync(path.resolve(dependencyDir, target)) ? undefined : target
  })
}

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(entryPath) : [entryPath]
  })
}

/** Workspace package specifiers (`@openwork/…`, `@openwork-ee/…`) the compiled service imports. */
export function workspaceSpecifiersIn(directory) {
  const specifiers = new Set()
  for (const file of filesUnder(directory)) {
    if (!file.endsWith(".js")) continue
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(/(?:from|import)\s*\(?\s*["'](@openwork(?:-ee)?\/[^"']+)["']/g)) specifiers.add(match[1])
  }
  return [...specifiers].sort()
}

/** The export's production target, when Node loads it straight from TypeScript source (type stripping). */
function sourceServedTarget(specifier, packageDir = serviceDir) {
  const parts = specifier.split("/")
  const name = parts.slice(0, 2).join("/")
  const subpath = parts.length > 2 ? `./${parts.slice(2).join("/")}` : "."
  const packageJsonPath = path.join(packageDir, "node_modules", name, "package.json")
  if (!existsSync(packageJsonPath)) return undefined
  const exports = JSON.parse(readFileSync(packageJsonPath, "utf8")).exports
  const value = exports && typeof exports === "object" && !Array.isArray(exports) && subpath in exports ? exports[subpath] : subpath === "." ? exports : undefined
  const target = productionExportTarget(value)
  return /\.(c|m)?tsx?$/.test(target ?? "") ? target : undefined
}

/** The whole environment of the import check's child process: no secrets, no NODE_OPTIONS, only PATH (and Windows' SystemRoot). */
export function sourceExportCheckEnv(env = process.env) {
  const allowed = process.platform === "win32" ? ["PATH", "Path", "SystemRoot"] : ["PATH"]
  return Object.fromEntries(allowed.flatMap((key) => (typeof env[key] === "string" ? [[key, env[key]]] : [])))
}

/**
 * Loads every source-served workspace export the compiled service imports, in a plain Node process (no development
 * condition), the way production starts. A relative import Node can't resolve from source (for example one without a
 * file extension) only fails at runtime otherwise, after the deploy.
 */
export function unloadableSourceExports(specifiers, packageDir = serviceDir) {
  const failures = []
  for (const specifier of specifiers) {
    if (!sourceServedTarget(specifier, packageDir)) continue
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`], {
      cwd: packageDir,
      encoding: "utf8",
      // Importing runs the modules' top-level code: give it nothing from the build's environment (Sentry upload
      // token, registry credentials, …), only what Node needs to start.
      env: sourceExportCheckEnv(),
    })
    if (result.status !== 0) {
      const reason = /^\w*Error(?: \[[A-Z_]+\])?: [^\n]+/m.exec(result.stderr ?? "")?.[0] ?? `exit ${result.status}`
      failures.push(`${specifier}: ${reason}`)
    }
  }
  return failures
}

export function verifySourceExportsLoad() {
  const failures = unloadableSourceExports(workspaceSpecifiersIn(distDir))
  if (failures.length > 0) {
    throw new Error(`Workspace exports the service imports fail to load in production:\n${failures.map((entry) => `- ${entry}`).join("\n")}`)
  }
}

function verifyProductionWorkspaceExports() {
  const missing = [...missingProductionWorkspaceExports(), ...missingProductionWorkspaceTypes()]
  if (missing.length > 0) {
    throw new Error(`Workspace production exports are missing:\n${missing.map((entry) => `- ${entry}`).join("\n")}`)
  }
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

  run(pnpmCommand, ["run", "build:workspace-dependencies"])
  verifyProductionWorkspaceExports()
  run(pnpmCommand, ["exec", "tsc", "-p", "tsconfig.build.json"], tscBuildEnv())
  // The check runs the imported modules' code. A build that uploads source maps has the Sentry token on hand
  // (environment or /run/secrets), so there it runs as its own step instead (`check:runtime-imports`, a separate
  // Dockerfile.den step with no secrets mounted).
  if (shouldUploadSentrySourcemaps()) console.log("Skipping the runtime import check during a source-map upload build; run check:runtime-imports separately.")
  else verifySourceExportsLoad()
  maybeUploadSentrySourcemaps()
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main()
}
