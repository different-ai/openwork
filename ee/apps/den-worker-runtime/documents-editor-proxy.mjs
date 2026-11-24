// Fronts the document editor inside a Cloud worker.
// Usage: node documents-editor-proxy.mjs <public port> <engine port>
//
// The provider's preview proxy rewrites Host to localhost and sends the
// signed public host in X-Forwarded-Host. The engine derives its page,
// discovery and websocket URLs (and its websocket Origin check) from Host
// alone, so this restores the public host before forwarding to the engine
// on loopback. Signed hosts change per session, so a fixed server_name can't.
import http from "node:http"
import net from "node:net"

const [publicPort, enginePort] = process.argv.slice(2).map(Number)
const hostPattern = /^[A-Za-z0-9.-]+(?::\d+)?$/

function publicHost(request) {
  // The nearest proxy appends its value last.
  const forwarded = String(request.headers["x-forwarded-host"] ?? "").split(",").pop().trim()
  return hostPattern.test(forwarded) ? forwarded : request.headers.host
}

function rawHeaders(request) {
  const lines = []
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== "host") lines.push([request.rawHeaders[index], request.rawHeaders[index + 1]])
  }
  return [["Host", publicHost(request)], ...lines]
}

const server = http.createServer((request, response) => {
  const upstream = http.request({ host: "127.0.0.1", port: enginePort, method: request.method, path: request.url, headers: rawHeaders(request).flat() }, reply => {
    response.writeHead(reply.statusCode ?? 502, reply.rawHeaders)
    reply.pipe(response)
  })
  upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end() })
  request.pipe(upstream)
})

server.on("upgrade", (request, socket, head) => {
  const upstream = net.connect(enginePort, "127.0.0.1", () => {
    const lines = [`${request.method} ${request.url} HTTP/1.1`, ...rawHeaders(request).map(([name, value]) => `${name}: ${value}`)]
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`)
    if (head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on("error", () => socket.destroy())
  socket.on("error", () => upstream.destroy())
})

server.listen(publicPort, "0.0.0.0")
