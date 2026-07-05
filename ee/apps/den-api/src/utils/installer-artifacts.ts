import { createWriteStream } from "node:fs"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"
import { env } from "../env.js"

/**
 * Resolves a generic installer artifact (openwork-installer-mac-arm64.zip,
 * openwork-installer-mac-x64.zip, openwork-installer-win-x64.exe) so
 * install-link downloads work without any local artifact directory:
 *
 *   1. OPENWORK_INSTALLER_ARTIFACTS_DIR file, when set and present
 *      (self-hosted/dev override — the pre-#2480 behavior, moved here).
 *   2. Disk cache under OPENWORK_INSTALLER_CACHE_DIR/<releaseTag>/<fileName>.
 *   3. The public release asset published by release-generic-installer.yml:
 *      https://github.com/<repo>/releases/download/<releaseTag>/<fileName>,
 *      streamed to a temp file then atomically renamed into the cache.
 *
 * A missing asset (404) resolves to null so the route can 503. Concurrent
 * requests for the same artifact share one in-flight download.
 */

export type InstallerArtifactFetcher = (url: string, init: { redirect: "follow"; signal: AbortSignal }) => Promise<Response>

type InstallerArtifactOptions = {
  artifactsDir?: string
  cacheDir?: string
  releaseTag?: string
  releaseRepo?: string
  fetcher?: InstallerArtifactFetcher
}

const DOWNLOAD_TIMEOUT_MS = 60_000

const inFlightDownloads = new Map<string, Promise<Buffer | null>>()

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
  const url = `https://github.com/${input.releaseRepo}/releases/download/${encodeURIComponent(input.releaseTag)}/${encodeURIComponent(input.fileName)}`
  console.info(`[installer-artifacts] downloading ${input.fileName} from ${input.releaseTag}`)

  const tempPath = `${input.cachePath}.download-${process.pid}-${randomUUID()}`
  try {
    const response = await input.fetcher(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    })
    if (!response.ok) {
      console.warn(`[installer-artifacts] ${input.fileName} unavailable at ${input.releaseTag} (${response.status})`)
      return null
    }
    await mkdir(path.dirname(input.cachePath), { recursive: true })
    await streamResponseToFile(response, tempPath)
    await rename(tempPath, input.cachePath)
    return await readFileOrNull(input.cachePath)
  } catch (error) {
    console.warn(`[installer-artifacts] download of ${input.fileName} failed: ${error instanceof Error ? error.message : String(error)}`)
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
    console.info(`[installer-artifacts] cache hit ${fileName}`)
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
