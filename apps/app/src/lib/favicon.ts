/**
 * Paper rule "Pasted links get favicons": any http(s) URL in user or
 * assistant text renders with the site's favicon next to it.
 */
export function faviconUrlForHref(href: string): string | null {
  try {
    const url = new URL(href)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    if (!url.hostname || url.hostname === "localhost") return null
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=32`
  } catch {
    return null
  }
}
