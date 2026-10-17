/** Private guest bridge. Bundled with the shared browser/computer implementation, never a provider credential. */
import { createServer } from "node:http";
import { connect } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { createCloudComputer } from "@openwork/computer-use/cloud";
import { createDesktopApplications } from "./desktop-apps.mjs";

const directory = process.env.WORKBOT_DESKTOP_STATE;
if (!directory) throw new Error("WORKBOT_DESKTOP_STATE is required");
const secret = (await readFile(`${directory}/token`, "utf8")).trim();
let until = 0;
const tickets = new Map();
const sockets = new Set();
const transports = new Map();
process.umask(0o077);
const computer = await createCloudComputer({ directory, display: ":99", enabled: async () => Date.now() < until,
  applications: createDesktopApplications({ directory: `${directory}/apps`, display: ":99" }),
});
const json = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
};
const authorized = request => {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const listening = port => new Promise(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.setTimeout(1000);
  const done = ready => { socket.destroy(); resolve(ready); };
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  socket.once("timeout", () => done(false));
});
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || !authorized(request)) return json(response, 404, { error: "not_found" });
  try {
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
      if (raw.length > 65536) return json(response, 413, { error: "too_large" });
    }
    const body = JSON.parse(raw);
    // Only the authenticated runner renews authority. An open VNC connection cannot renew itself.
    until = Date.now() + 90_000;
    if (request.url === "/health") {
      const browser = await fetch("http://127.0.0.1:9222/json/version", { signal: AbortSignal.timeout(1500) }).then(async result => { await result.body?.cancel(); return result.ok; }).catch(() => false);
      const ports = await Promise.all([5900, 5901, 5902, 5903].map(listening));
      return json(response, browser && ports.every(Boolean) ? 200 : 503, { ok: browser && ports.every(Boolean), version: process.env.WORKBOT_DESKTOP_VERSION ?? "unknown" });
    }
    if (request.url === "/viewer") {
      if (!["browser", "computer"].includes(body.view) || typeof body.origin !== "string") return json(response, 400, { error: "invalid_view" });
      if (body.control === true) await computer.interact({ action: "takeover" });
      const token = randomBytes(32).toString("base64url");
      const paused = (await computer.snapshot()).paused;
      for (const [key, ticket] of tickets) if (ticket.expiresAt <= Date.now()) tickets.delete(key);
      if (tickets.size >= 16) return json(response, 409, { error: "too_many_viewers" });
      tickets.set(token, { view: body.view, control: paused && body.control === true, origin: body.origin, expiresAt: Date.now() + 15_000 });
      return json(response, 200, { token, paused });
    }
    if (request.url === "/continue") {
      for (const socket of sockets) { transports.get(socket)?.destroy(); socket.terminate(); }
      await computer.interact({ action: "resume" });
      return json(response, 200, { ok: true });
    }
    if (request.url === "/stop") {
      // Pause first, including when Stop overtakes a not-yet-started task.
      // Only the person's existing Continue action can release input again.
      await computer.interact({ action: "stop" });
      return json(response, 200, { ok: true, paused: true });
    }
    if (["/browser/task", "/computer/task", "/computer/program"].includes(request.url)) {
      return json(response, 200, await computer.task(request.url, body));
    }
    return json(response, 404, { error: "not_found" });
  } catch (error) { json(response, 409, { error: error.code ?? "desktop_failed", message: error.message }); }
});
const websocket = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
server.on("upgrade", (request, socket, head) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const token = /^\/vnc\/([A-Za-z0-9_-]{43})$/.exec(path)?.[1];
  const ticket = tickets.get(token);
  tickets.delete(token);
  if (!ticket || ticket.expiresAt <= Date.now() || request.headers.origin !== ticket.origin || sockets.size >= 4) return socket.destroy();
  websocket.handleUpgrade(request, socket, head, ws => {
    // Read-only viewers use a separate x11vnc server that refuses input at the server, not only in noVNC.
    const port = ticket.view === "browser" ? (ticket.control ? 5901 : 5903) : (ticket.control ? 5900 : 5902);
    const tcp = connect({ host: "127.0.0.1", port });
    sockets.add(ws);
    transports.set(ws, tcp);
    const deadline = setTimeout(() => ws.close(1000, "Renew viewer access"), 60_000);
    const close = () => { clearTimeout(deadline); sockets.delete(ws); transports.delete(ws); tcp.destroy(); ws.close(); };
    tcp.on("data", data => { if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true }); });
    ws.on("message", (data, binary) => {
      if (!binary || Date.now() >= until) return close();
      tcp.write(data);
      if (tcp.writableLength > 2 * 1024 * 1024 || ws.bufferedAmount > 4 * 1024 * 1024) close();
    });
    tcp.on("error", close); tcp.on("close", close);
    ws.on("error", close); ws.on("close", close);
  });
});
server.listen(6080, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  for (const socket of sockets) socket.terminate();
  server.close(); void computer.close().finally(() => process.exit(0));
});
