import { parseDesktopReleases, type DesktopRelease } from "@openwork/free-auto"

// GitHub's release list carries full notes and assets: 20 OpenWork releases were about 1.7 MB on 2026-09-24.
const MAX_RELEASE_LIST_BYTES = 8 * 1024 * 1024

/** Reads the published stable releases; caches 5 minutes and serves a stale list for up to a day if the source fails. */
export function createDesktopFreeReleaseSource(options: { url: string; fetch?: typeof fetch; now?: () => number; token?: string }) {
  const now = options.now ?? Date.now
  const fetcher = options.fetch ?? fetch
  let cached: { releases: DesktopRelease[]; expiresAt: number; staleAt: number } | null = null
  let pending: Promise<DesktopRelease[] | null> | null = null
  let retryAt = 0
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
        if (size > MAX_RELEASE_LIST_BYTES) { void reader.cancel().catch(() => undefined); return null }
        chunks.push(chunk.value)
      }
      const releases = parseDesktopReleases(JSON.parse(Buffer.concat(chunks).toString("utf8")))
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
