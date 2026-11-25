import { relative } from "node:path"
import { serveStatic } from "@hono/node-server/serve-static"
import type { Hono } from "hono"
import type { AppEnv } from "./auth.js"

export function isRevalidatedFile(path: string) {
  return /\.(?:html|webmanifest)$/.test(path)
}

export function registerClientFiles(app: Hono<AppEnv>, clientDir: string) {
  const root = relative(process.cwd(), clientDir) || "."
  app.use("/assets/*", serveStatic({ root, onFound: (_path, c) => c.header("Cache-Control", "public, max-age=31536000, immutable") }))
  app.all("/assets/*", (c) => c.text("Not found", 404, { "Cache-Control": "no-store" }))
  app.use("*", serveStatic({ root, onFound: (path, c) => { if (isRevalidatedFile(path)) c.header("Cache-Control", "no-cache") } }))
  app.get("*", serveStatic({ root, path: "index.html", onFound: (_path, c) => c.header("Cache-Control", "no-cache") }))
}
