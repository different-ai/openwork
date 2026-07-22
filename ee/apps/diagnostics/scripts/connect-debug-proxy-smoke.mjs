import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

const packageDirectory = fileURLToPath(new URL("../", import.meta.url))
const accessKey = "local-smoke-access-key"
let upstreamOrigin = ""
let observedBrowserCookie = ""

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject)
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Server did not expose a TCP port."))
      resolve(address.port)
    })
  })
}

async function freePort() {
  const server = createServer()
  const port = await listen(server)
  server.close()
  await once(server, "close")
  return port
}

async function body(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf8")
}

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { "content-type": "application/json", ...headers })
  response.end(JSON.stringify(payload))
}

const upstream = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  if (url.pathname === "/health") return json(response, 200, { ok: true })
  if (url.pathname === "/" && request.method === "GET") {
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "den-session=browser-session; Path=/; HttpOnly",
    })
    return response.end('<html><script src="/_next/static/den.js"></script></html>')
  }
  if (url.pathname === "/_next/static/den.js" && request.method === "GET") {
    response.writeHead(200, { "content-type": "application/javascript" })
    return response.end('globalThis.denLoaded = true;')
  }
  if (url.pathname === "/api/den/v1/auth/desktop-handoff" && request.method === "POST") {
    observedBrowserCookie = request.headers.cookie ?? ""
    const openworkUrl = new URL("openwork://den-auth")
    openworkUrl.searchParams.set("grant", "one-time-smoke-grant")
    openworkUrl.searchParams.set("denBaseUrl", `${upstreamOrigin}/api/den`)
    return json(response, 200, { openworkUrl: openworkUrl.toString() })
  }
  if (url.pathname !== "/api/den/mcp/agent" || request.method !== "POST") return json(response, 404, { error: "not_found" })
  if (request.headers.authorization !== "Bearer fake-smoke-token") return json(response, 401, { error: "invalid_token" })
  const payload = JSON.parse(await body(request))
  if (payload.method === "initialize") {
    return json(response, 200, {
      jsonrpc: "2.0",
      id: payload.id,
      result: { capabilities: { tools: {} }, protocolVersion: "2025-06-18", serverInfo: { name: "connect-debug-proxy-smoke", version: "1.0.0" } },
    }, { "mcp-protocol-version": "2025-06-18", "mcp-session-id": "smoke-session" })
  }
  if (payload.method === "notifications/initialized") {
    response.writeHead(202)
    return response.end()
  }
  if (payload.method === "tools/list") {
    return json(response, 200, {
      jsonrpc: "2.0",
      id: payload.id,
      result: { tools: [{ name: "search_capabilities" }, { name: "execute_capability" }] },
    })
  }
  return json(response, 400, { error: "unexpected_method" })
})

let child
let output = ""

async function stop() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))])
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  upstream.close()
  if (upstream.listening) await once(upstream, "close")
}

async function waitForReady(url) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // Next is still compiling.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Connect debug proxy did not become ready.\n${output}`)
}

async function mcp(baseUrl, payload) {
  return fetch(`${baseUrl}/api/den/mcp/agent`, {
    body: JSON.stringify(payload),
    headers: { accept: "application/json, text/event-stream", authorization: "Bearer fake-smoke-token", "content-type": "application/json" },
    method: "POST",
  })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

try {
  const upstreamPort = await listen(upstream)
  const proxyPort = await freePort()
  upstreamOrigin = `http://127.0.0.1:${upstreamPort}`
  const proxyOrigin = `http://127.0.0.1:${proxyPort}`
  child = spawn("pnpm", ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(proxyPort)], {
    cwd: packageDirectory,
    env: {
      ...process.env,
      DEBUG_PROXY_ACCESS_KEY: accessKey,
      DEBUG_PROXY_ALLOWED_UPSTREAMS: upstreamOrigin,
      DEBUG_PROXY_DEFAULT_UPSTREAM: upstreamOrigin,
      NEXT_PUBLIC_DIAGNOSTICS_ORIGIN: proxyOrigin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = `${output}${chunk.toString("utf8")}`.slice(-20_000) })
  }
  const defaultBase = `${proxyOrigin}/via/default/${accessKey}`
  await waitForReady(`${defaultBase}/health`)
  const controlPage = await fetch(`${proxyOrigin}/debug-proxy/${accessKey}`)
  const controlPageHtml = await controlPage.text()
  assert(controlPage.ok, `Control UI returned HTTP ${controlPage.status}.`)
  assert(controlPageHtml.includes("Connect debug proxy") && controlPageHtml.includes(`${proxyOrigin}/via/auth-expired/${accessKey}`), "Control UI did not render the scenario matrix and deployment-specific URLs.")

  const browserPage = await fetch(`${defaultBase}?desktopAuth=1`, { headers: { accept: "text/html" } })
  const browserCookies = browserPage.headers.getSetCookie()
  const routeCookie = browserCookies.find((cookie) => cookie.startsWith("openwork_connect_debug_route="))?.split(";", 1)[0]
  const denCookie = browserCookies.find((cookie) => cookie.startsWith("den-session="))?.split(";", 1)[0]
  assert(browserPage.ok && routeCookie && denCookie, "Browser sign-in bootstrap did not return Den HTML and both routing/session cookies.")
  const browserCookie = `${routeCookie}; ${denCookie}`
  const browserAsset = await fetch(`${proxyOrigin}/_next/static/den.js`, { headers: { cookie: browserCookie } })
  assert(browserAsset.ok && (await browserAsset.text()).includes("denLoaded"), "Root-relative Den browser assets did not remain on the scenario route.")
  const handoff = await fetch(`${proxyOrigin}/api/den/v1/auth/desktop-handoff`, {
    body: "{}",
    headers: { accept: "application/json", cookie: browserCookie, "content-type": "application/json", origin: proxyOrigin },
    method: "POST",
  })
  const handoffPayload = await handoff.json()
  const handoffDenBaseUrl = new URL(handoffPayload.openworkUrl).searchParams.get("denBaseUrl")
  const handoffDenUrl = new URL(handoffDenBaseUrl)
  assert(
    handoff.ok
      && handoffDenUrl.port === String(proxyPort)
      && handoffDenUrl.pathname === `/via/default/${accessKey}/api/den`,
    `Desktop handoff did not preserve the selected scenario base (received ${handoffDenBaseUrl}).`,
  )
  assert(observedBrowserCookie === denCookie, "The private browser routing cookie was forwarded to Den.")

  const initialized = await mcp(defaultBase, { jsonrpc: "2.0", id: 1, method: "initialize", params: { capabilities: {}, clientInfo: { name: "smoke", version: "1" }, protocolVersion: "2025-06-18" } })
  assert(initialized.ok, `Default initialize failed with HTTP ${initialized.status}.`)
  const initializedPayload = await initialized.json()
  assert(initializedPayload.result?.protocolVersion === "2025-06-18", "Default initialize did not pass through the protocol version.")

  const listed = await mcp(defaultBase, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  const listedPayload = await listed.json()
  assert(listedPayload.result?.tools?.some((tool) => tool.name === "execute_capability"), "Default tools/list lost execute_capability.")

  const expired = await mcp(`${proxyOrigin}/via/auth-expired/${accessKey}`, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  assert(expired.status === 401, `auth-expired returned HTTP ${expired.status}, expected 401.`)

  const missing = await mcp(`${proxyOrigin}/via/missing-tools/${accessKey}`, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
  const missingPayload = await missing.json()
  assert(!missingPayload.result?.tools?.some((tool) => tool.name === "execute_capability"), "missing-tools did not remove execute_capability.")
  assert(missingPayload.result?.tools?.some((tool) => tool.name === "search_capabilities"), "missing-tools removed search_capabilities.")

  process.stdout.write("Connect debug proxy smoke passed: browser auth routing, desktop handoff, default pass-through, auth-expired, and missing-tools.\n")
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n${output}`)
  process.exitCode = 1
} finally {
  await stop()
}
