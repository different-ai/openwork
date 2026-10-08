import { createServer } from "node:http"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { getRequestListener } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { buildMcpAppSandboxCsp, MCP_APP_SANDBOX_PROXY_HTML, parseMcpAppSandboxCsp } from "../../../../../apps/server/src/mcp-app-sandbox.js"
import { createAuth, type AppEnv } from "./auth.js"
import { loadConfig } from "./config.js"
import { createDen } from "./den.js"
import { registerWorkbotRoutes } from "./routes.js"

const config = loadConfig()
const den = createDen({ apiUrl: config.denApiUrl, publicUrl: config.publicUrl })
const auth = createAuth({ config, den })

/** Where an App's page runs: the MCP Apps sandbox proxy the desktop app and Den's gateway serve too. */
const APP_SANDBOX_PATH = "/mcp-apps/sandbox.html"

const app = new Hono<AppEnv>()
app.use("*", async (c, next) => {
  await next()
  c.header("X-Content-Type-Options", "nosniff")
  c.header("Referrer-Policy", "strict-origin-when-cross-origin")
  // Only the App sandbox may be framed, and only by Workbot's own page.
  c.header("X-Frame-Options", c.req.path === APP_SANDBOX_PATH ? "SAMEORIGIN" : "DENY")
})
app.onError((error, c) => {
  console.error("[workbot] request failed", { path: c.req.path, error: error.message })
  return c.json({ error: "internal_error" }, 500)
})
app.get("/healthz", (c) => c.json({ ok: true }))
// The page frames it without same-origin access, so the App runs in an origin of its own, under the policy it declared.
app.get(APP_SANDBOX_PATH, (c) => new Response(MCP_APP_SANDBOX_PROXY_HTML, {
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": `${buildMcpAppSandboxCsp(parseMcpAppSandboxCsp(c.req.query("csp") ?? null))}; frame-ancestors 'self'`,
    "Cache-Control": "no-store",
  },
}))
auth.register(app)
registerWorkbotRoutes(app, { config, den, member: auth.member, sameOrigin: auth.sameOrigin })
app.all("/v1/*", (c) => c.json({ error: "not_found" }, 404))
app.all("/auth/*", (c) => c.json({ error: "not_found" }, 404))

const clientDir = join(dirname(fileURLToPath(import.meta.url)), config.dev ? "../client" : "client")
const isApi = (path: string) => path === "/healthz" || path === APP_SANDBOX_PATH || path.startsWith("/v1/") || path === "/v1" || path.startsWith("/auth/")

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
  app.use("*", serveStatic({ root }))
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
    process.exit(0)
  })
}
