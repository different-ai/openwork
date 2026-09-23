import type { DesktopFreeVersionError } from "@openwork/types/desktop-free-access"

export const DESKTOP_FREE_RELEASES_URL = "https://api.github.com/repos/different-ai/openwork/releases?per_page=20"
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
const semver = new RegExp(`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)
export function parseDesktopVersion(value: string) {
  if (value.length > 128) return null
  const match = semver.exec(value)
  if (!match || match[0] !== value) return null
  const core = match.slice(1, 4).map(Number)
  if (core.some((part) => !Number.isSafeInteger(part)) || core.every((part) => part === 0)) return null
  return { core, prerelease: match[4] }
}
export function compareDesktopVersions(a: string, b: string) {
  const left = parseDesktopVersion(a), right = parseDesktopVersion(b)
  if (!left || !right) return null
  for (let index = 0; index < 3; index++) {
    const comparison = Math.sign(left.core[index] - right.core[index])
    if (comparison !== 0) return comparison
  }
  return Number(Boolean(right.prerelease)) - Number(Boolean(left.prerelease))
}

export type DesktopRelease = { version: string; publishedAt: number }
export type DesktopReleaseWindow = { count: number; minDays: number; blocked: readonly string[] }
/**
 * The releases guests may use: the newest `count` stable releases, plus any
 * stable release published within `minDays`, minus explicitly blocked ones.
 * Prereleases never qualify.
 */
export function supportedDesktopReleases(releases: readonly DesktopRelease[], window: DesktopReleaseWindow, now = Date.now()): string[] {
  const stable = releases
    .filter((release) => { const parsed = parseDesktopVersion(release.version); return parsed && !parsed.prerelease && Number.isFinite(release.publishedAt) })
    .sort((a, b) => compareDesktopVersions(b.version, a.version) ?? 0)
  const floor = now - window.minDays * 86400000
  const supported = stable.filter((release, index) => index < window.count || release.publishedAt >= floor)
  return [...new Set(supported.map((release) => release.version))].filter((version) => !window.blocked.includes(version))
}
export function lowestDesktopVersion(versions: readonly string[]) {
  return versions.length ? versions.reduce((lowest, version) => (compareDesktopVersions(version, lowest) ?? 0) < 0 ? version : lowest) : null
}

export function desktopFreeVersionError(currentVersion: string, supported: readonly string[] | null): DesktopFreeVersionError | null {
  const minimumVersion = supported ? lowestDesktopVersion(supported) : null
  if (!minimumVersion) return { code: "desktop_version_unavailable", currentVersion, minimumVersion: null,
    message: "The supported desktop version cannot be verified. Auto is temporarily unavailable." }
  if (!supported?.includes(currentVersion)) return { code: "desktop_update_required", currentVersion, minimumVersion,
    message: `Update OpenWork Desktop to ${minimumVersion} or newer to use Auto.` }
  return null
}

/** Reads the published stable releases; caches 5 minutes and serves a stale list for up to a day if the source fails. */
export function createDesktopFreeReleaseSource(options: { url: string; fetch?: typeof fetch; now?: () => number; token?: string }) {
  const now = options.now ?? Date.now
  const fetcher = options.fetch ?? fetch
  let cached: { releases: DesktopRelease[]; expiresAt: number; staleAt: number } | null = null
  let pending: Promise<DesktopRelease[] | null> | null = null
  let retryAt = 0
  function parseReleases(value: unknown): DesktopRelease[] | null {
    const entries = Array.isArray(value) ? value : typeof value === "object" && value !== null && "releases" in value && Array.isArray(value.releases) ? value.releases : null
    if (!entries) return null
    const releases: DesktopRelease[] = []
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) return null
      if ("tag_name" in entry) {
        if (typeof entry.tag_name !== "string" || !("draft" in entry) || !("prerelease" in entry) || !("published_at" in entry)) return null
        if (entry.draft !== false || entry.prerelease !== false || typeof entry.published_at !== "string") continue
        const publishedAt = Date.parse(entry.published_at)
        if (Number.isFinite(publishedAt)) releases.push({ version: entry.tag_name.replace(/^v/, ""), publishedAt })
      } else if ("version" in entry && "publishedAt" in entry && typeof entry.version === "string" && typeof entry.publishedAt === "string") {
        const publishedAt = Date.parse(entry.publishedAt)
        if (Number.isFinite(publishedAt)) releases.push({ version: entry.version.replace(/^v/, ""), publishedAt })
      } else return null
    }
    return releases
  }
  async function refresh() {
    const startedAt = now()
    try {
      const url = new URL(options.url)
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return null
      const response = await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(3000),
        headers: { accept: "application/json", "user-agent": "OpenWork-Desktop-Free-Access", ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) } })
      if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        void response.body?.cancel().catch(() => undefined)
        return null
      }
      const reader = response.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 1048576) { void reader.cancel().catch(() => undefined); return null }
        chunks.push(chunk.value)
      }
      const releases = parseReleases(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      if (!releases || releases.length === 0) return null
      cached = { releases, expiresAt: startedAt + 300000, staleAt: startedAt + 86400000 }
      return releases
    } catch { return null }
    finally { retryAt = now() + 30000 }
  }
  return async (): Promise<DesktopRelease[] | null> => {
    if (cached && cached.expiresAt > now()) return cached.releases
    const stale = cached && cached.staleAt > now() ? cached.releases : null
    if (pending) return (await pending) ?? stale
    if (retryAt > now()) return stale
    pending = refresh().finally(() => { pending = null })
    return (await pending) ?? stale
  }
}
