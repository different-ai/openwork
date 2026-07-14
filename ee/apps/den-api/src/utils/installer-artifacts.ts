import { createWriteStream } from "node:fs"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"

/**
 * Resolves the standard signed desktop artifact so organization install-link
 * downloads work without building a second installer application:
 *
 *   1. OPENWORK_INSTALLER_ARTIFACTS_DIR file, when set and present
 *      (self-hosted/dev override — the pre-#2480 behavior, moved here).
 *   2. Disk cache under OPENWORK_INSTALLER_CACHE_DIR/<releaseTag>/<fileName>.
 *   3. The normal public desktop release asset:
 *      https://github.com/<repo>/releases/download/<releaseTag>/<fileName>,
 *      streamed to a temp file then atomically renamed into the cache.
 *
 * A missing asset (404) resolves to null so the route can fall back to the
 * normal desktop release. Concurrent requests for the same artifact share one
 * in-flight download.
 */

export type InstallerArtifactFetcher = (url: string, init: { redirect: "follow"; signal: AbortSignal }) => Promise<Response>
export type InstallerFallbackFetcher = (url: string, init: { method: "HEAD"; redirect: "follow"; signal: AbortSignal }) => Promise<Response>

type InstallerArtifactOptions = {
  artifactsDir?: string
  cacheDir?: string
  releaseTag?: string
  releaseRepo?: string
  fetcher?: InstallerArtifactFetcher
}

const DOWNLOAD_TIMEOUT_MS = 60_000
const FALLBACK_TIMEOUT_MS = 10_000
const FALLBACK_CACHE_TTL_MS = 5 * 60_000

const inFlightDownloads = new Map<string, Promise<Buffer | null>>()
const fallbackDownloadUrls = new Map<string, { expiresAt: number; value: Promise<string> }>()
const logger = appLogger.child({ component: "installer_artifacts" })

export function installerReleaseAssetUrl(
  fileName: string,
  options: Pick<InstallerArtifactOptions, "releaseRepo" | "releaseTag"> = {},
) {
  const releaseRepo = options.releaseRepo ?? env.installerReleaseRepo
  const releaseTag = options.releaseTag ?? env.installerReleaseTag
  return `https://github.com/${releaseRepo}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(fileName)}`
}

export function desktopReleaseAssetName(platform: string, releaseTag: string) {
  const version = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag
  if (platform === "mac-arm64" || platform === "mac-x64") {
    return `openwork-${platform}-${version}.dmg`
  }
  if (platform === "win-x64") {
    return `openwork-${platform}-${version}.exe`
  }
  return null
}

async function verifyDesktopFallbackUrl(input: {
  candidateUrl: string
  fallbackUrl: string
  fetcher: InstallerFallbackFetcher
}) {
  try {
    const response = await input.fetcher(input.candidateUrl, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(FALLBACK_TIMEOUT_MS),
    })
    return response.ok ? input.candidateUrl : input.fallbackUrl
  } catch {
    return input.fallbackUrl
  }
}

export function resolveInstallerFallbackUrl(
  platform: string,
  fallbackUrl: string,
  options: Pick<InstallerArtifactOptions, "releaseRepo" | "releaseTag"> & { fetcher?: InstallerFallbackFetcher } = {},
) {
  const releaseTag = options.releaseTag ?? env.installerReleaseTag
  const fileName = desktopReleaseAssetName(platform, releaseTag)
  if (!fileName) {
    return Promise.resolve(fallbackUrl)
  }

  const candidateUrl = installerReleaseAssetUrl(fileName, options)
  const fetcher = options.fetcher
  if (fetcher) {
    return verifyDesktopFallbackUrl({ candidateUrl, fallbackUrl, fetcher })
  }

  const now = Date.now()
  const cached = fallbackDownloadUrls.get(candidateUrl)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const value = verifyDesktopFallbackUrl({ candidateUrl, fallbackUrl, fetcher: fetch })
  fallbackDownloadUrls.set(candidateUrl, { expiresAt: now + FALLBACK_CACHE_TTL_MS, value })
  return value
}

async function readFileOrNull(filePath: string) {
  try {
    return await readFile(filePath)
  } catch {
    return null
  }
}

async function streamResponseToFile(response: Response, filePath: string) {
  const body = response.body
  if (!body) {
    throw new Error("release asset response had no body")
  }
  const reader = body.getReader()
  const file = createWriteStream(filePath)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      await new Promise<void>((resolve, reject) => {
        file.write(value, (error) => (error ? reject(error) : resolve()))
      })
    }
  } finally {
    await new Promise<void>((resolve) => file.end(() => resolve()))
  }
}

async function downloadReleaseAsset(input: {
  fileName: string
  cachePath: string
  releaseTag: string
  releaseRepo: string
  fetcher: InstallerArtifactFetcher
}): Promise<Buffer | null> {
  const url = installerReleaseAssetUrl(input.fileName, {
    releaseRepo: input.releaseRepo,
    releaseTag: input.releaseTag,
  })
  logger.info("downloading installer artifact", { file_name: input.fileName, release_tag: input.releaseTag })

  const tempPath = `${input.cachePath}.download-${process.pid}-${randomUUID()}`
  try {
    const response = await input.fetcher(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!response.ok) {
      logger.warn("installer artifact unavailable", {
        file_name: input.fileName,
        release_tag: input.releaseTag,
        http_status_code: response.status,
      })
      return null
    }
    await mkdir(path.dirname(input.cachePath), { recursive: true })
    await streamResponseToFile(response, tempPath)
    await rename(tempPath, input.cachePath)
    return await readFileOrNull(input.cachePath)
  } catch (error) {
    logger.warn("installer artifact download failed", { file_name: input.fileName, release_tag: input.releaseTag, error })
    return null
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined)
  }
}

export async function resolveInstallerArtifact(fileName: string, options: InstallerArtifactOptions = {}): Promise<Buffer | null> {
  const artifactsDir = options.artifactsDir ?? env.installerArtifactsDir
  if (artifactsDir) {
    const local = await readFileOrNull(path.join(artifactsDir, fileName))
    if (local) {
      return local
    }
  }

  const releaseTag = options.releaseTag ?? env.installerReleaseTag
  const releaseRepo = options.releaseRepo ?? env.installerReleaseRepo
  const cacheDir = options.cacheDir ?? env.installerCacheDir
  const fetcher = options.fetcher ?? fetch
  const cachePath = path.join(cacheDir, releaseTag, fileName)

  const cached = await readFileOrNull(cachePath)
  if (cached) {
    logger.info("installer artifact cache hit", { file_name: fileName })
    return cached
  }

  const inFlight = inFlightDownloads.get(cachePath)
  if (inFlight) {
    return inFlight
  }
  const download = downloadReleaseAsset({ fileName, cachePath, releaseTag, releaseRepo, fetcher })
    .finally(() => inFlightDownloads.delete(cachePath))
  inFlightDownloads.set(cachePath, download)
  return download
}
