import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { DEN_CONNECTOR_SETUP_PATH, DEN_DASHBOARD_LINKS, denConnectorSetupUrl, denDashboardUrl } from "../src/app/lib/den-dashboard-links"

const appSrc = resolve(import.meta.dir, "../src")
const denWebApp = resolve(import.meta.dir, "../../../ee/apps/den-web/app")

// The desktop's own router also uses /dashboard/apps/...; those are not Den links.
const DESKTOP_ROUTE_PREFIXES = ["/dashboard/apps/"]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

/** Next.js app router: (group) folders add no URL segment; [param] folders match any segment. */
function denWebHasPage(dir: string, segments: string[]): boolean {
  if (segments.length === 0 && existsSync(join(dir, "page.tsx"))) return true
  const children = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory())
  for (const child of children) {
    const path = join(dir, child)
    if (/^\(.+\)$/.test(child) && denWebHasPage(path, segments)) return true
    if (segments.length > 0 && (child === segments[0] || /^\[[^.\]]+\]$/.test(child)) && denWebHasPage(path, segments.slice(1))) return true
  }
  return false
}

function denPathSegments(path: string): string[] {
  return new URL(path, "https://den.example.test").pathname.split("/").filter(Boolean)
}

/** Every /dashboard/... address written in desktop source, with template parts and query dropped. */
function desktopDashboardLinks(): Array<{ file: string; path: string }> {
  const links: Array<{ file: string; path: string }> = []
  for (const file of sourceFiles(appSrc)) {
    for (const match of readFileSync(file, "utf8").matchAll(/["'`](\/dashboard\/[^"'`$?#]*)/g)) {
      const path = match[1]?.replace(/\/+$/, "")
      if (!path || DESKTOP_ROUTE_PREFIXES.some((prefix) => `${path}/`.startsWith(prefix))) continue
      links.push({ file: relative(appSrc, file), path })
    }
  }
  return links
}

test("the gateway and model links open pages that exist in den-web", () => {
  for (const path of Object.values(DEN_DASHBOARD_LINKS)) {
    expect({ path, exists: denWebHasPage(denWebApp, denPathSegments(path)) }).toEqual({ path, exists: true })
  }
  expect(denDashboardUrl("https://den.example.test", "gatewayProviders")).toBe("https://den.example.test/dashboard/ai-gateway?tab=ai-providers")
  expect(denDashboardUrl("https://den.example.test/", "modelConnections")).toBe("https://den.example.test/dashboard/library?show=models")
})

test("the desktop links to real pages, not to Den's compatibility redirects", () => {
  // Den keeps these addresses only so installed desktops land somewhere; not every Den version has them.
  const redirects = ["/dashboard/gateway-providers", "/dashboard/model-connections"]
  for (const path of redirects) expect({ path, exists: denWebHasPage(denWebApp, denPathSegments(path)) }).toEqual({ path, exists: true })
  expect(desktopDashboardLinks().filter((link) => redirects.includes(link.path))).toEqual([])
})

test("every Den dashboard address in desktop source is a den-web page", () => {
  const links = desktopDashboardLinks()
  expect(links.length).toBeGreaterThan(5)
  const missing = links.filter((link) => !denWebHasPage(denWebApp, denPathSegments(link.path)))
  expect(missing).toEqual([])
})

test("the connector setup link opens Den's admin setup for one catalog entry", () => {
  const path = new URL(denConnectorSetupUrl("https://den.example.test", "slack") ?? "").pathname
  expect(path).toBe(`${DEN_CONNECTOR_SETUP_PATH}slack`)
  expect({ path, exists: denWebHasPage(denWebApp, denPathSegments(path)) }).toEqual({ path, exists: true })
})
