import type { DesktopFreeVersionError } from "@openwork/types/desktop-free-access"

export const DESKTOP_FREE_RELEASE_URL = "https://api.github.com/repos/different-ai/openwork/releases/latest"

const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)"
const semver = new RegExp(`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)

function parseVersion(value: string) {
  if (value.length > 128) return null
  const match = semver.exec(value)
  if (!match || match[0] !== value) return null
  const core = match.slice(1, 4).map(Number)
  if (core.some((part) => !Number.isSafeInteger(part)) || core.every((part) => part === 0)) return null
  return { core, prerelease: match[4] }
}

export function desktopFreeVersionError(currentVersion: string, minimumVersion: string | null): DesktopFreeVersionError | null {
  const minimum = minimumVersion === null ? null : parseVersion(minimumVersion)
  if (!minimum || minimum.prerelease) return {
    code: "desktop_version_unavailable", currentVersion, minimumVersion: null,
    message: "The latest stable desktop version cannot be verified. Free Luna is temporarily unavailable.",
  }
  const current = parseVersion(currentVersion)
  let comparison = 0
  if (current) {
    for (let index = 0; index < 3; index += 1) {
      comparison = Math.sign(current.core[index] - minimum.core[index])
      if (comparison !== 0) break
    }
    if (comparison === 0 && current.prerelease) comparison = -1
  }
  if (!current || comparison < 0) return {
    code: "desktop_update_required", currentVersion, minimumVersion,
    message: `Update OpenWork Desktop to ${minimumVersion} or newer to use free Luna.`,
  }
  return null
}

// The default reads the official release publication pointer, never Den's
// compiled fallback. A custom Den URL is explicit operator policy authority,
// not a guarantee of fresh GitHub data. No gateway stale-cache fallback.
export function createDesktopFreeVersionSource(options: {
  url: string
  fetch?: typeof fetch
  now?: () => number
}) {
  const readTime = options.now ?? Date.now
  const fetcher = options.fetch ?? fetch
  let cached: { version: string; expiresAt: number } | null = null
  let pending: Promise<string | null> | null = null
  async function refresh() {
    const startedAt = readTime()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3_000)
    try {
      const url = new URL(options.url)
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return null
      const response = await fetcher(url, {
        redirect: "error", signal: controller.signal,
        headers: { accept: "application/json", "user-agent": "OpenWork-Desktop-Free-Access" },
      })
      if (!response.ok || response.redirected || response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        void response.body?.cancel().catch(() => undefined)
        return null
      }
      const reader = response.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        size += result.value.byteLength
        // GitHub release payloads include asset lists, unlike the small Den
        // metadata response. Keep the larger response bounded as well.
        if (size > 262_144) {
          void reader.cancel().catch(() => undefined)
          return null
        }
        chunks.push(result.value)
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null
      let version: string
      if (url.href === DESKTOP_FREE_RELEASE_URL || "tag_name" in value || "draft" in value || "prerelease" in value) {
        if (!("tag_name" in value) || typeof value.tag_name !== "string"
          || !("draft" in value) || value.draft !== false
          || !("prerelease" in value) || value.prerelease !== false
          || !("published_at" in value) || typeof value.published_at !== "string"
          || !Number.isFinite(Date.parse(value.published_at))) return null
        version = value.tag_name.replace(/^v/, "")
      } else {
        // Opting into a non-default URL trusts the operator's Den policy floor,
        // which may itself be a committed fallback. No claim of GitHub freshness.
        if (!("latestAppVersion" in value) || typeof value.latestAppVersion !== "string") return null
        version = value.latestAppVersion
      }
      const parsed = parseVersion(version)
      if (!parsed || parsed.prerelease || controller.signal.aborted) return null
      cached = { version, expiresAt: startedAt + 300_000 }
      return cached.version
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }
  return async () => {
    if (cached && cached.expiresAt > readTime()) return cached.version
    pending ??= refresh().finally(() => { pending = null })
    return pending
  }
}
