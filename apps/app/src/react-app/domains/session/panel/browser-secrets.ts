import type { BrowserSecretKind } from "@openwork/types/desktop-ipc"

export const BROWSER_SECRET_KINDS: { kind: BrowserSecretKind; label: string }[] = [
  { kind: "password", label: "Password" },
  { kind: "code", label: "One-time code" },
  { kind: "token", label: "API key or token" },
]

export const BROWSER_SECRET_NAME_MAX = 80
export const BROWSER_SECRET_SITES_MAX = 10

export function browserSecretKindLabel(kind: BrowserSecretKind): string {
  return BROWSER_SECRET_KINDS.find((entry) => entry.kind === kind)?.label ?? "Secret"
}

export function secureOrigin(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === "https:" ? parsed.origin : null
  } catch {
    return null
  }
}

export function siteName(origin: string): string {
  return origin.replace(/^https:\/\//, "")
}

export type AllowedSites = { ok: true; origins: string[] } | { ok: false; error: string }

function shownEntry(entry: string): string {
  return entry.length > 60 ? `${entry.slice(0, 60)}…` : entry
}

function allowedSite(entry: string): { origin: string } | { error: string } {
  if (entry.includes("*")) return { error: `“${shownEntry(entry)}” covers more than one site. List each site's own address.` }
  let parsed: URL
  try {
    parsed = new URL(entry)
  } catch {
    return { error: `“${shownEntry(entry)}” isn't a site address. Start it with https://, like https://app.example.` }
  }
  if (parsed.protocol !== "https:") return { error: `“${shownEntry(entry)}” needs to start with https://. A secret is only sent over a secure connection.` }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return { error: `“${shownEntry(entry)}” has more than the site's address. Use ${parsed.origin}` }
  }
  return { origin: parsed.origin }
}

export function parseAllowedSites(text: string): AllowedSites {
  const origins: string[] = []
  for (const entry of text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    const site = allowedSite(entry)
    if ("error" in site) return { ok: false, error: site.error }
    if (!origins.includes(site.origin)) origins.push(site.origin)
  }
  if (!origins.length) return { ok: false, error: "List at least one site this secret can go to, like https://app.example." }
  if (origins.length > BROWSER_SECRET_SITES_MAX) return { ok: false, error: `A secret can go to ${BROWSER_SECRET_SITES_MAX} sites at most. Remove ${origins.length - BROWSER_SECRET_SITES_MAX}.` }
  return { ok: true, origins }
}

export function isBrowserSecretsDialogTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest("[data-browser-secrets-dialog]") !== null
}
