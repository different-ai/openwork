/**
 * A static picture of what an App built in OpenWork last showed, painted on
 * the next open while the live App starts behind it. The App sends it as an
 * `openwork/snapshot` notification once the host advertises the flag below.
 *
 * The App is untrusted, so the picture is cleaned again here and only ever
 * painted in a frame with no scripts, an opaque origin and a policy that
 * loads nothing but inline styles and data images.
 */
export const MCP_APP_SNAPSHOT_METHOD = "openwork/snapshot"
export const MCP_APP_SNAPSHOT_MAX_BYTES = 200_000

const SNAPSHOT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"
const DROPPED_ELEMENTS = new Set(["script", "noscript", "template", "iframe", "frame", "frameset", "object", "embed",
  "applet", "portal", "link", "meta", "base", "xmp", "noembed", "noframes", "plaintext",
  "animate", "animatemotion", "animatetransform", "set", "discard"])
const URL_ATTRIBUTES = new Set(["href", "xlink:href", "src", "srcset", "srcdoc", "action", "formaction", "poster",
  "ping", "cite", "data", "background", "lowsrc", "longdesc", "codebase", "manifest", "usemap"])

function keepsAttribute(name: string, value: string): boolean {
  if (name.startsWith("on")) return false
  const plain = value.replace(/[\u0000- \u007f-\u009f]/gu, "").toLowerCase()
  if (plain.includes("javascript:") || plain.includes("vbscript:")) return false
  if (!URL_ATTRIBUTES.has(name)) return true
  return plain.startsWith("#")
    || (["src", "href", "xlink:href"].includes(name) && /^data:image\/(?:png|gif|jpe?g|webp|avif);/u.test(plain))
}

// Style text can never close its element in the painted copy.
function cssText(text: string): string {
  return text.replace(/</gu, "\\3c ")
}

function clean(node: Node) {
  for (const item of Array.from(node.childNodes)) {
    if (item.nodeType !== Node.ELEMENT_NODE) {
      if (item.nodeType !== Node.TEXT_NODE) item.remove()
      continue
    }
    const child = item as Element
    const name = child.localName.toLowerCase()
    if (DROPPED_ELEMENTS.has(name)) {
      child.remove()
      continue
    }
    for (const attribute of Array.from(child.attributes)) {
      if (!keepsAttribute(attribute.name.toLowerCase(), attribute.value)) child.removeAttributeNode(attribute)
    }
    if (name === "style") child.textContent = cssText(child.textContent ?? "")
    else clean(child)
  }
}

/** The cleaned picture, or null when it is not a bounded string. Parsed in an inert document, never the host's. */
export function sanitizeMcpAppSnapshot(html: unknown): string | null {
  if (typeof html !== "string" || !html.trim() || new TextEncoder().encode(html).byteLength > MCP_APP_SNAPSHOT_MAX_BYTES) return null
  const parsed = new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, "text/html")
  clean(parsed.body)
  const cleaned = parsed.body.innerHTML
  return cleaned.trim() && new TextEncoder().encode(cleaned).byteLength <= MCP_APP_SNAPSHOT_MAX_BYTES ? cleaned : null
}

/**
 * The `srcdoc` for a script-less frame that paints the picture with the
 * host's current theme, the way the App's runtime applies it.
 */
export function mcpAppSnapshotDocument(html: string, theme: "light" | "dark", variables: Readonly<Record<string, string | undefined>>): string | null {
  const body = sanitizeMcpAppSnapshot(html)
  if (!body) return null
  const declarations = Object.entries(variables)
    .flatMap(([name, value]) => typeof value === "string" && /^--[a-z0-9-]+$/u.test(name) ? [[name, value]] : [])
    .map(([name, value]) => `${name}:${cssText(value).replace(/[;{}]/gu, "")};`)
    .join("")
  const root = `:root{${declarations}color-scheme:${theme};color:var(--color-text-primary, CanvasText);`
    + "background-color:var(--color-background-primary, Canvas);font-family:var(--font-sans, system-ui, sans-serif);}"
  return `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" content="${SNAPSHOT_CSP}">`
    + `<style>${root}</style></head><body>${body}</body></html>`
}
