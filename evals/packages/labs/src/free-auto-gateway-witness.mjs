// Loopback-only stand-in for the free Auto Gateway's status route. It answers "ready" and records, per request,
// only the path and whether the analytics journey header was present (with its value, for unlinkability checks).
import { createServer } from "node:http";

const port = Number(process.argv[2]);
const requests = [];
const ready = () => ({
  state: "ready", code: null,
  allowance: { limitUsd: 1, usedUsd: 0, remainingUsd: 1, resetsAt: new Date(Date.now() + 86_400_000).toISOString() },
});

createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const send = (status, body) => response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
  if (path === "/health") return send(200, { ok: true });
  if (path === "/requests") return send(200, requests);
  if (path === "/api/anonymous/status" || path === "/api/v1/auto/status") {
    const journey = request.headers["x-openwork-free-journey"];
    requests.push({ path, journey: typeof journey === "string" ? journey : null, at: Date.now() });
    return send(200, ready());
  }
  return send(404, { error: "not_found" });
}).listen(port, "127.0.0.1");
