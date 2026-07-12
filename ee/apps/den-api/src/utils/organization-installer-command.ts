import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { installConfigSchema, type InstallConfig } from "@openwork/install-config"
import {
  isOrganizationInstallerPlatform,
  installerReleaseArtifactUrl,
  type OrganizationInstallerPlatform,
} from "./installer-release.js"
import {
  buildOrganizationInstallerBundle,
  organizationInstallerArtifactNames,
  organizationInstallerBundleFileName,
} from "./organization-installer-bundle.js"

type ArtifactFetcher = (url: string, init: { redirect: "follow"; signal: AbortSignal }) => Promise<Response>

export type BuildOrganizationInstallerOptions = {
  configPath: string
  platform: string
  output: string
  artifactsDir?: string
  releaseRepo?: string
  allowInsecureHttp?: boolean
  dryRun?: boolean
  fetcher?: ArtifactFetcher
}

export type OrganizationInstallerBuildResult = {
  platform: OrganizationInstallerPlatform
  releaseTag: string
  outputPath: string
  checksumPath: string | null
  bundleSha256: string | null
  byteLength: number
  artifacts: Array<{ fileName: string; sha256: string; source: string }>
}

function isLoopbackHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return normalized === "localhost" || normalized === "::1" || normalized === "127.0.0.1" || normalized.startsWith("127.")
}

function requireEnterpriseHttps(value: string, field: string, allowInsecureHttp: boolean) {
  const url = new URL(value)
  if (url.protocol === "https:" || (url.protocol === "http:" && (allowInsecureHttp || isLoopbackHostname(url.hostname)))) {
    return
  }
  throw new Error(`${field} must use HTTPS for an enterprise bundle (use --allow-insecure-http only for controlled development)`)
}

export function parseOrganizationInstallerConfig(payload: unknown, allowInsecureHttp = false): InstallConfig & { appVersion: string } {
  const parsed = installConfigSchema.parse(payload)
  if (!parsed.appVersion) {
    throw new Error("appVersion is required so the organization bundle selects one exact desktop release")
  }
  const normalizedVersion = parsed.appVersion.replace(/^v/i, "")
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(normalizedVersion) || normalizedVersion.includes("..")) {
    throw new Error("appVersion must be a release-safe version without path separators")
  }
  requireEnterpriseHttps(parsed.webUrl, "webUrl", allowInsecureHttp)
  requireEnterpriseHttps(parsed.apiUrl, "apiUrl", allowInsecureHttp)
  if (parsed.logoUrl) requireEnterpriseHttps(parsed.logoUrl, "logoUrl", allowInsecureHttp)
  if (parsed.iconUrl) requireEnterpriseHttps(parsed.iconUrl, "iconUrl", allowInsecureHttp)
  return { ...parsed, appVersion: normalizedVersion }
}

function sha256Buffer(value: Buffer) {
  return createHash("sha256").update(Uint8Array.from(value)).digest("hex")
}

async function sha256File(filePath: string) {
  const digest = createHash("sha256")
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk)
  }
  return digest.digest("hex")
}

async function localArtifact(fileName: string, artifactsDir: string) {
  const filePath = path.join(artifactsDir, fileName)
  try {
    const metadata = await stat(filePath)
    if (!metadata.isFile()) throw new Error("not a file")
    return { bytes: await readFile(filePath), source: filePath }
  } catch {
    throw new Error(`Required release artifact is missing: ${filePath}`)
  }
}

async function remoteArtifact(fileName: string, releaseRepo: string, releaseTag: string, fetcher: ArtifactFetcher) {
  const url = installerReleaseArtifactUrl(fileName, releaseRepo, releaseTag)
  const response = await fetcher(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) })
  if (!response.ok) {
    throw new Error(`Required release artifact is unavailable (${response.status} ${response.statusText}): ${url}`)
  }
  return { bytes: Buffer.from(await response.arrayBuffer()), source: url }
}

async function writeBundleAtomically(outputPath: string, body: ReadableStream<Uint8Array>) {
  await mkdir(path.dirname(outputPath), { recursive: true })
  const tempPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    const handle = await open(tempPath, "wx", 0o600)
    try {
      const reader = body.getReader()
      while (true) {
        const next = await reader.read()
        if (next.done) break
        await handle.write(next.value)
      }
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tempPath, outputPath)
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

async function writeChecksum(outputPath: string, checksum: string) {
  const checksumPath = `${outputPath}.sha256`
  const tempPath = `${checksumPath}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(tempPath, `${checksum}  ${path.basename(outputPath)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" })
    await rename(tempPath, checksumPath)
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
  return checksumPath
}

export async function buildOrganizationInstaller(options: BuildOrganizationInstallerOptions): Promise<OrganizationInstallerBuildResult> {
  if (!isOrganizationInstallerPlatform(options.platform)) {
    throw new Error(`platform must be one of: mac-arm64, mac-x64, win-x64 (got ${options.platform || "empty"})`)
  }
  const releaseRepo = options.releaseRepo?.trim() || "different-ai/openwork"
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(releaseRepo)) {
    throw new Error("releaseRepo must use the owner/repository form")
  }

  const payload: unknown = JSON.parse(await readFile(options.configPath, "utf8"))
  const config = parseOrganizationInstallerConfig(payload, options.allowInsecureHttp)
  const releaseTag = `v${config.appVersion}`
  const names = organizationInstallerArtifactNames(options.platform, releaseTag)
  const fetcher = options.fetcher ?? fetch
  const resolveArtifact = options.artifactsDir
    ? (fileName: string) => localArtifact(fileName, options.artifactsDir ?? "")
    : (fileName: string) => remoteArtifact(fileName, releaseRepo, releaseTag, fetcher)
  const [generic, desktop] = await Promise.all([
    resolveArtifact(names.genericFileName),
    resolveArtifact(names.desktopFileName),
  ])
  const bundle = buildOrganizationInstallerBundle({
    platform: options.platform,
    config,
    desktopFileName: names.desktopFileName,
    desktopArtifact: desktop.bytes,
    genericInstallerArtifact: generic.bytes,
  })
  const outputPath = options.output.toLowerCase().endsWith(".zip")
    ? path.resolve(options.output)
    : path.resolve(options.output, organizationInstallerBundleFileName(config.clientName, options.platform))
  const artifacts = [
    { fileName: names.genericFileName, sha256: sha256Buffer(generic.bytes), source: generic.source },
    { fileName: names.desktopFileName, sha256: sha256Buffer(desktop.bytes), source: desktop.source },
  ]

  if (options.dryRun) {
    return { platform: options.platform, releaseTag, outputPath, checksumPath: null, bundleSha256: null, byteLength: bundle.byteLength, artifacts }
  }

  await writeBundleAtomically(outputPath, bundle.body)
  const bundleSha256 = await sha256File(outputPath)
  const checksumPath = await writeChecksum(outputPath, bundleSha256)
  return { platform: options.platform, releaseTag, outputPath, checksumPath, bundleSha256, byteLength: bundle.byteLength, artifacts }
}
