import { createServer } from "node:http"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { getRequestListener } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { isRevalidatedFile } from "./static-cache.js"
import { Hono } from "hono"
import { createAuth, type AppEnv } from "./auth.js"
import { loadConfig } from "./config.js"
import { createDen } from "./den.js"
import { closeErrorReporting, initErrorReporting } from "./error-reporting.js"
import { registerWorkbotRoutes } from "./routes.js"
import { registerReadinessRoute } from "./readiness.js"

const config = loadConfig()
await initErrorReporting(config.errorReporting)
const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl, serviceToken: config.runner.token })
const auth = createAuth({ config, den })

const app = new Hono<AppEnv>()
app.use("*", async (c, next) => {
  await next()
  c.header("X-Content-Type-Options", "nosniff")
  c.header("Referrer-Policy", "strict-origin-when-cross-origin")
  c.header("X-Frame-Options", "DENY")
})
app.onError(auth.onError)
app.get("/healthz", (c) => c.json({ ok: true }))
registerReadinessRoute(app, config)
auth.register(app)
registerWorkbotRoutes(app, { config, den, member: auth.member, sameOrigin: auth.sameOrigin })
app.all("/v1/*", (c) => c.json({ error: "not_found" }, 404))
app.all("/auth/*", (c) => c.json({ error: "not_found" }, 404))

const clientDir = join(dirname(fileURLToPath(import.meta.url)), config.dev ? "../client" : "client")
const isApi = (path: string) => path === "/healthz" || path.startsWith("/internal/") || path.startsWith("/v1/") || path === "/v1" || path.startsWith("/auth/")

let server: ReturnType<typeof createServer>
if (config.dev) {
  // One port in development: the API through Hono, everything else through Vite with hot reload.
  const { createServer: createVite } = await import("vite")
  server = createServer()
  const vite = await createVite({
    configFile: join(clientDir, "../../vite.config.ts"),
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  })
  const api = getRequestListener(app.fetch)
  server.on("request", (request, response) => {
    if (isApi(new URL(request.url ?? "/", "http://localhost").pathname)) void api(request, response)
    else vite.middlewares(request, response)
  })
} else {
  const root = relative(process.cwd(), clientDir) || "."
  app.use("/assets/*", serveStatic({ root, onFound: (_path, c) => c.header("Cache-Control", "public, max-age=31536000, immutable") }))
  // The page itself ("/" serves index.html here) and the manifest are revalidated on every load. Without a
  // Cache-Control header, browsers cache "/" heuristically from its Last-Modified, and a phone could keep opening the
  // previous release's page (and its previous hashed script) after a deploy.
  app.use("*", serveStatic({ root, onFound: (path, c) => { if (isRevalidatedFile(path)) c.header("Cache-Control", "no-cache") } }))
  // Any other page path is the app itself.
  app.get("*", serveStatic({ root, path: "index.html", onFound: (_path, c) => c.header("Cache-Control", "no-cache") }))
  server = createServer(getRequestListener(app.fetch))
}

server.listen(config.port, () => {
  console.log(`[workbot] listening on :${config.port} (${config.publicUrl}, den ${config.denApiUrl}, runner ${config.runner.url}${config.dev ? ", dev" : ""})`)
})
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close()
    void closeErrorReporting().finally(() => process.exit(0))
  })
}
