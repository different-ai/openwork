/** Private guest bridge. Bundled with the shared browser/computer implementation, never a provider credential. */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { WebSocketServer, WebSocket } from "ws";
import { createCloudComputer, browserEgressStatus } from "@openwork/computer-use/cloud";
import { createBrowserDemonstration } from "@openwork/computer-use/browser-demonstration";
import { createDesktopApplications } from "./desktop-apps.mjs";
import { ViewerTickets } from "./viewer-tickets.mjs";
import { streamBrowser } from "./browser-screencast.mjs";

const directory = process.env.WORKBOT_DESKTOP_STATE;
if (!directory) throw new Error("WORKBOT_DESKTOP_STATE is required");
const secret = (await readFile(`${directory}/token`, "utf8")).trim();
let until = 0;
const tickets = new ViewerTickets();
const sockets = new Set();
const transports = new Map();
process.umask(0o077);
// Set only by root's start command for operator diagnostics; never by the agent or a conversation.
const computer = await createCloudComputer({ directory, display: ":99", enabled: async () => Date.now() < until,
  privateBrowsing: process.env.WORKBOT_DESKTOP_PRIVATE_BROWSING === "1",
  applications: createDesktopApplications({ directory: `${directory}/apps`, display: ":99" }),
});
const teaching = createBrowserDemonstration({ path: `${directory}/browser-demonstration.json` });
const json = (response, status, payload) => {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(payload));
};
const authorized = request => {
  const actual = Buffer.from(request.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const viewerScript = "/usr/local/share/openwork-desktop/vnc-stdio.py";
const server = createServer(async (request, response) => {
  if (request.method !== "POST" || !authorized(request)) return json(response, 404, { error: "not_found" });
  const viewerGeneration = tickets.generation;
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
      const viewer = await Promise.all([access(viewerScript), access(`${directory}/browser-window`)]).then(() => true, () => false);
      return json(response, browser && viewer ? 200 : 503, { ok: browser && viewer, version: process.env.WORKBOT_DESKTOP_VERSION ?? "unknown", ...(body.diagnostics === true ? { egress: await browserEgressStatus() } : {}) });
    }
    if (request.url === "/browser/demonstration") {
      if (typeof body.sessionId !== "string" || !body.sessionId || body.sessionId.length > 256) return json(response, 400, { error: "invalid_session" });
      if (body.command?.action === "start" || body.command?.action === "resume") {
        try {
          const result = await tickets.run(viewerGeneration, async () => {
            await computer.interact({ action: "takeover" });
            return teaching.command(body.sessionId, body.command);
          });
          return json(response, 200, result);
        } catch (error) {
          await teaching.command(body.sessionId, { action: "pause" }).catch(() => {});
          throw error;
        }
      }
      return json(response, 200, await teaching.command(body.sessionId, body.command));
    }
    if (request.url === "/viewer") {
      if (!["browser", "computer"].includes(body.view) || typeof body.origin !== "string") return json(response, 400, { error: "invalid_view" });
      const result = await tickets.run(viewerGeneration, async () => {
        if (body.control === true) await computer.interact({ action: "takeover" });
        const paused = (await computer.snapshot()).paused;
        const token = tickets.issue({ view: body.view, control: paused && body.control === true, origin: body.origin }, viewerGeneration);
        return { token, paused };
      });
      return json(response, 200, result);
    }
    if (request.url === "/continue") {
      if (teaching.isTeaching()) return json(response, 409, { error: "teaching_active", message: "Finish or discard teaching before returning control to Workbot." });
      const generation = tickets.revoke();
      for (const socket of sockets) { transports.get(socket)?.destroy(); socket.terminate(); }
      await tickets.run(generation, () => computer.interact({ action: "resume" }));
      return json(response, 200, { ok: true });
    }
    if (request.url === "/stop") {
      // Pause first, including when Stop overtakes a not-yet-started task.
      // Only the person's existing Continue action can release input again.
      await tickets.run(tickets.generation, () => computer.interact({ action: "stop" }));
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
  const [, transport, token] = /^\/(vnc|screencast)\/([A-Za-z0-9_-]{43})$/.exec(path) ?? [];
  const ticket = tickets.consume(token, request.headers.origin);
  if (!ticket || Date.now() >= until || sockets.size >= 4) return socket.destroy();
  // The screencast shows only the browser; with control it also takes the person's input for the page.
  if (transport === "screencast" && ticket.view !== "browser") return socket.destroy();
  websocket.handleUpgrade(request, socket, head, ws => {
    if (ticket.generation !== tickets.generation || Date.now() >= until) return ws.terminate();
    if (transport === "screencast") {
      const deadline = setTimeout(() => ws.close(1000, "Renew viewer access"), 60_000);
      const stop = streamBrowser(ws, { control: ticket.control, onClose: () => { clearTimeout(deadline); sockets.delete(ws); transports.delete(ws); ws.close(); } });
      sockets.add(ws);
      transports.set(ws, { destroy: stop });
      return;
    }
    // Private stdio cannot be pre-bound by the command account. The VNC
    // process itself enforces view-only, independently of noVNC's controls.
    const viewer = spawn("/usr/bin/python3", ["-I", viewerScript, ticket.view, ticket.control ? "control" : "view"], { stdio: ["pipe", "pipe", "ignore"] });
    const vnc = { destroy: () => { viewer.stdin.destroy(); viewer.stdout.destroy(); viewer.kill("SIGTERM"); } };
    sockets.add(ws);
    transports.set(ws, vnc);
    const deadline = setTimeout(() => ws.close(1000, "Renew viewer access"), 60_000);
    const close = () => { clearTimeout(deadline); sockets.delete(ws); transports.delete(ws); vnc.destroy(); ws.close(); };
    viewer.stdout.on("data", data => { if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: true }); });
    ws.on("message", (data, binary) => {
      if (!binary || Date.now() >= until || ticket.generation !== tickets.generation) return close();
      viewer.stdin.write(data);
      if (viewer.stdin.writableLength > 2 * 1024 * 1024 || ws.bufferedAmount > 4 * 1024 * 1024) close();
    });
    viewer.on("error", close); viewer.on("close", close); viewer.stdin.on("error", close); viewer.stdout.on("error", close);
    ws.on("error", close); ws.on("close", close);
  });
});
server.listen(6080, "0.0.0.0");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
  for (const socket of sockets) socket.terminate();
  server.close(); void computer.close().finally(() => process.exit(0));
});
