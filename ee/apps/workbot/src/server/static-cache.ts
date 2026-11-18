import { relative } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import type { Hono } from "hono"
import type { AppEnv } from "./auth.js"

/**
 * Files that must be revalidated on every load (`Cache-Control: no-cache`): the page itself and the web app manifest.
 * Hashed files under /assets are immutable instead; everything else keeps the default.
 */
export function isRevalidatedFile(path: string) {
  return /\.(?:html|webmanifest)$/.test(path)
}

/** The built page (dist/client): its hashed files, the page itself, and the page again for every path the app routes. */
export function registerClientFiles(app: Hono<AppEnv>, clientDir: string) {
  const root = relative(process.cwd(), clientDir) || "."
  app.use("/assets/*", serveStatic({ root, onFound: (_path, c) => c.header("Cache-Control", "public, max-age=31536000, immutable") }))
  // A hashed file that is not here belongs to another release: a tab left open across a deploy asks for the script it
  // was built with. Answer that it is gone, never with the page (HTML under a script's name, and a 200), so the tab
  // can tell and load the current release.
  app.all("/assets/*", (c) => c.text("Not found", 404, { "Cache-Control": "no-store" }))
  // The page itself ("/" serves index.html here) and the manifest are revalidated on every load. Without a
  // Cache-Control header, browsers cache "/" heuristically from its Last-Modified, and a phone could keep opening the
  // previous release's page (and its previous hashed script) after a deploy.
  app.use("*", serveStatic({ root, onFound: (path, c) => { if (isRevalidatedFile(path)) c.header("Cache-Control", "no-cache") } }))
  // Any other page path is the app itself.
  app.get("*", serveStatic({ root, path: "index.html", onFound: (_path, c) => c.header("Cache-Control", "no-cache") }))
}
