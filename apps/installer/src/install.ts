import { spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { desktopBootstrapPath, legacyDesktopBootstrapPath } from "./bootstrap-path"
import { installerBundleDirectories } from "./config-sources"
import type { InstallerConfig } from "./config"
import { releaseAssetFor, type ReleaseAsset } from "./release-asset"

export type InstallStep = "write-config" | "check-version" | "download" | "install"

export type InstallStatus = {
  state: "idle" | "running" | "done" | "error"
  step: InstallStep | null
  message: string
  version: string | null
  downloadedBytes: number
  totalBytes: number | null
  installedPath: string | null
  error: string | null
}

export type InstallOptions = {
  /** Stop after resolving + HEAD-checking the download; used by CI smoke tests. */
  dryRun?: boolean
  /** Explicit bundle roots used by tests and managed launchers. */
  bundleDirectories?: string[]
  onStatus?: (status: InstallStatus) => void
}

const status: InstallStatus = {
  state: "idle",
  step: null,
  message: "",
  version: null,
  downloadedBytes: 0,
  totalBytes: null,
  installedPath: null,
  error: null,
}

type BootstrapCandidate = {
  config: Record<string, unknown>
  mtimeMs: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readBootstrapCandidate(candidatePath: string): BootstrapCandidate | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(candidatePath, "utf8"))
    if (!isRecord(parsed)) return null
    if (typeof parsed.baseUrl !== "string" || !parsed.baseUrl.trim()) return null
    return { config: parsed, mtimeMs: statSync(candidatePath).mtimeMs }
  } catch {
    return null
  }
}

function bootstrapCandidateTimeMs(candidate: BootstrapCandidate): number {
  const writtenAt = typeof candidate.config.writtenAt === "string" ? candidate.config.writtenAt.trim() : ""
  const writtenAtMs = writtenAt ? Date.parse(writtenAt) : Number.NaN
  return Number.isFinite(writtenAtMs) ? writtenAtMs : candidate.mtimeMs
}

function compareBootstrapCandidates(left: BootstrapCandidate, right: BootstrapCandidate): number {
  return bootstrapCandidateTimeMs(left) - bootstrapCandidateTimeMs(right)
}

export function installStatus(): InstallStatus {
  return { ...status }
}

function update(partial: Partial<InstallStatus>, onStatus?: (status: InstallStatus) => void) {
  Object.assign(status, partial)
  onStatus?.(installStatus())
}

/**
 * The generic installer is an explicit, confirmed provisioning action, so its
 * deployment always wins. Retain unrelated prepared/claimLinks state and drop
 * one-time handoff grants (see normalizeDesktopBootstrapConfig in Electron).
 */
export function writeBootstrapConfig(
  config: InstallerConfig,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const target = desktopBootstrapPath(env, platform)
  const legacy = legacyDesktopBootstrapPath(env, platform)
  const canonicalCandidate = readBootstrapCandidate(target)
  const legacyCandidate = path.resolve(legacy) === path.resolve(target) ? null : readBootstrapCandidate(legacy)
  const installedCandidates: BootstrapCandidate[] = []
  if (canonicalCandidate) installedCandidates.push(canonicalCandidate)
  if (legacyCandidate) installedCandidates.push(legacyCandidate)
  installedCandidates.sort((left, right) => compareBootstrapCandidates(right, left))
  const installed = installedCandidates[0]
  const existing = installed ? installed.config : {}
  const prepared = canonicalCandidate?.config.prepared ?? legacyCandidate?.config.prepared
  const claimLinks = canonicalCandidate?.config.claimLinks ?? legacyCandidate?.config.claimLinks
  const next: Record<string, unknown> = {
    ...existing,
    baseUrl: config.webUrl,
    apiBaseUrl: config.apiUrl,
    requireSignin: config.requireSignin,
    brandAppName: config.appName,
    ...(config.logoUrl ? { brandLogoUrl: config.logoUrl } : {}),
    ...(config.iconUrl ? { brandIconUrl: config.iconUrl } : {}),
    ...(prepared !== undefined ? { prepared } : {}),
    ...(claimLinks !== undefined ? { claimLinks } : {}),
    writtenAt: new Date().toISOString(),
  }
  if (!config.logoUrl) delete next.brandLogoUrl
  if (!config.iconUrl) delete next.brandIconUrl
  delete next.handoff
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  try {
    if (path.resolve(legacy) !== path.resolve(target) && existsSync(legacy)) rmSync(legacy, { force: true })
  } catch {
    // Best-effort cleanup only; the canonical config was written successfully.
  }
  return target
}

export function bundledReleaseAssetPath(fileName: string, directories = installerBundleDirectories()): string | null {
  for (const directory of directories) {
    const candidate = path.join(directory, fileName)
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // A missing adjacent artifact is normal for the standalone installer.
    }
  }
  return null
}

/** Ask the deployment's Den API which desktop version it supports. */
export async function fetchLatestSupportedVersion(apiUrl: string): Promise<string> {
  const response = await fetch(`${apiUrl}/v1/app-version`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(`Deployment version check failed (${response.status} ${response.statusText})`)
  }
  const payload = (await response.json()) as { latestAppVersion?: unknown }
  const version = typeof payload.latestAppVersion === "string" ? payload.latestAppVersion.trim() : ""
  if (!version || version === "0.0.0") {
    throw new Error("Deployment did not declare a desktop app version (latestAppVersion missing)")
  }
  return version
}

async function downloadAsset(asset: ReleaseAsset, targetPath: string, opts: InstallOptions): Promise<void> {
  const response = await fetch(asset.url, { redirect: "follow" })
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${asset.url}`)
  }
  const contentLength = Number(response.headers.get("content-length") ?? "")
  update({ totalBytes: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null }, opts.onStatus)

  const file = Bun.file(targetPath)
  const writer = file.writer()
  let downloaded = 0
  for await (const chunk of response.body) {
    writer.write(chunk)
    downloaded += chunk.byteLength
    update({ downloadedBytes: downloaded }, opts.onStatus)
  }
  await writer.end()
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore" })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))
    })
  })
}

function installDmg(dmgPath: string, workDir: string): string {
  const mountPoint = path.join(workDir, "mount")
  mkdirSync(mountPoint, { recursive: true })
  const appDir = path.join(os.homedir(), "Applications")
  mkdirSync(appDir, { recursive: true })
  const attach = Bun.spawnSync(["hdiutil", "attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountPoint])
  if (attach.exitCode !== 0) {
    throw new Error(`hdiutil attach failed: ${attach.stderr.toString().trim()}`)
  }
  try {
    const appName = readdirSync(mountPoint).find((entry) => entry.endsWith(".app"))
    if (!appName) throw new Error("No .app bundle found inside the downloaded disk image")
    const target = path.join(appDir, appName)
    rmSync(target, { recursive: true, force: true })
    const copy = Bun.spawnSync(["ditto", path.join(mountPoint, appName), target])
    if (copy.exitCode !== 0) {
      throw new Error(`ditto failed: ${copy.stderr.toString().trim()}`)
    }
    return target
  } finally {
    Bun.spawnSync(["hdiutil", "detach", mountPoint, "-quiet"])
  }
}

async function installExe(exePath: string): Promise<string> {
  // The release asset is an NSIS installer; /S runs the standard per-user
  // silent install (shortcuts, uninstaller, updater layout all included).
  await run(exePath, ["/S"])
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
  return path.join(localAppData, "Programs", "OpenWork", "OpenWork.exe")
}

function installAppImage(appImagePath: string): string {
  const appDir = path.join(os.homedir(), ".local", "share", "openwork")
  mkdirSync(appDir, { recursive: true })
  const target = path.join(appDir, "OpenWork.AppImage")
  rmSync(target, { force: true })
  writeFileSync(target, readFileSync(appImagePath))
  chmodSync(target, 0o755)

  // Best-effort launcher entry so the app shows up in desktop menus.
  try {
    const applicationsDir = path.join(os.homedir(), ".local", "share", "applications")
    mkdirSync(applicationsDir, { recursive: true })
    writeFileSync(
      path.join(applicationsDir, "openwork.desktop"),
      ["[Desktop Entry]", "Type=Application", "Name=OpenWork", `Exec=${target}`, "Terminal=false", "Categories=Utility;"].join("\n") + "\n",
      "utf8",
    )
  } catch {
    // Menu integration is optional; the AppImage itself is installed.
  }
  return target
}

export async function runInstall(config: InstallerConfig, opts: InstallOptions = {}): Promise<InstallStatus> {
  if (status.state === "running") return installStatus()
  update(
    {
      state: "running",
      step: "write-config",
      message: "Writing deployment configuration...",
      version: null,
      downloadedBytes: 0,
      totalBytes: null,
      installedPath: null,
      error: null,
    },
    opts.onStatus,
  )

  try {
    const bootstrapPath = writeBootstrapConfig(config)
    update({ step: "check-version", message: "Checking the supported app version..." }, opts.onStatus)
    const version = config.appVersion ?? await fetchLatestSupportedVersion(config.apiUrl)
    const asset = releaseAssetFor(version)
    const bundledArtifact = bundledReleaseAssetPath(asset.fileName, opts.bundleDirectories)
    update({ version, message: bundledArtifact ? `OpenWork ${version} is ready in this setup bundle.` : `Deployment supports OpenWork ${version}.` }, opts.onStatus)

    if (opts.dryRun) {
      if (!bundledArtifact) {
        const head = await fetch(asset.url, { method: "HEAD", redirect: "follow" })
        if (!head.ok) throw new Error(`Release asset missing (${head.status}): ${asset.url}`)
      }
      update(
        { state: "done", step: null, message: `Dry run ok: ${asset.fileName} ${bundledArtifact ? "bundled" : "available"}; config written to ${bootstrapPath}.` },
        opts.onStatus,
      )
      return installStatus()
    }

    const workDir = path.join(os.tmpdir(), `openwork-installer-${process.pid}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(workDir, { recursive: true })
    try {
      const artifactPath = bundledArtifact ?? path.join(workDir, asset.fileName)
      if (bundledArtifact) {
        const bundledBytes = statSync(bundledArtifact).size
        update({ step: "install", message: `Using bundled OpenWork ${version}...`, downloadedBytes: bundledBytes, totalBytes: bundledBytes }, opts.onStatus)
      } else {
        update({ step: "download", message: `Downloading OpenWork ${version}...` }, opts.onStatus)
        await downloadAsset(asset, artifactPath, opts)
      }

      update({ step: "install", message: "Installing OpenWork..." }, opts.onStatus)
      const installedPath =
        asset.type === "dmg"
          ? installDmg(artifactPath, workDir)
          : asset.type === "exe"
            ? await installExe(artifactPath)
            : installAppImage(artifactPath)

      update(
        { state: "done", step: null, installedPath, message: `OpenWork ${version} installed successfully.` },
        opts.onStatus,
      )
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  } catch (error) {
    update(
      { state: "error", error: error instanceof Error ? error.message : String(error), message: "Install failed." },
      opts.onStatus,
    )
  }
  return installStatus()
}

export function launchInstalledApp(installedPath: string): void {
  if (!installedPath || !existsSync(installedPath)) return
  if (process.platform === "darwin") {
    Bun.spawn(["open", installedPath], { stdio: ["ignore", "ignore", "ignore"] })
  } else {
    Bun.spawn([installedPath], { stdio: ["ignore", "ignore", "ignore"] })
  }
}
