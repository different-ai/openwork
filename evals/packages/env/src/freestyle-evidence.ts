import { createServer } from "node:http";
import { request } from "node:https";
import type { Duplex } from "node:stream";
import { attachSurface } from "@openwork/cdp";
import { trackResource } from "@openwork/world";
import { ensureEvidenceSnapshot } from "@openwork/freestyle/evidence-builder";
import { client, execChecked } from "@openwork/freestyle";
import { captureEvidenceCheckpoint, deleteEvidenceVm, launchEvidenceWorld, continueEvidenceStream } from "@openwork/freestyle/checkpoints";
import type { EvidenceSession } from "@openwork/freestyle/checkpoints";

/** Host-only relay: keeps the provider cookie out of CDP URLs and evidence logs. */
export async function evidenceCdpRelay(session: Pick<EvidenceSession, "cdpOrigin" | "cookie">) {
  const remote = new URL(session.cdpOrigin);
  if (remote.protocol !== "https:" || !/^cdp-[a-f0-9]{32}\.preview\.openwork\.software$/.test(remote.hostname)) throw new Error("Invalid evidence CDP origin");
  const peers = new Set<Duplex>();
  const server = createServer((req, res) => {
    // This loopback endpoint is for the Node controller, not arbitrary websites.
    if (req.headers.origin || req.headers["sec-fetch-site"]) { res.writeHead(403).end(); return; }
    const upstream = request({ hostname: remote.hostname, port: 443, path: req.url, method: req.method,
      headers: { cookie: session.cookie, host: remote.host, "content-type": "application/json" }, timeout: 30_000 }, (response) => {
      res.writeHead(response.statusCode ?? 502, { "content-type": "application/json", "cache-control": "no-store" }); response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.on("timeout", () => upstream.destroy()); req.pipe(upstream);
  });
  server.on("connection", (socket) => { peers.add(socket); socket.on("close", () => peers.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    if (req.headers.origin || req.headers["sec-fetch-site"]) { socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
    const upstream = request({ hostname: remote.hostname, port: 443, path: req.url,
      headers: { ...req.headers, host: remote.host, cookie: session.cookie } });
    upstream.on("upgrade", (response, peer, upstreamHead) => {
      peers.add(peer); peer.on("close", () => peers.delete(peer));
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
      if (head.length) peer.write(head); if (upstreamHead.length) socket.write(upstreamHead);
      socket.pipe(peer).pipe(socket); peer.on("error", () => socket.destroy()); socket.on("error", () => peer.destroy());
    });
    upstream.on("response", () => socket.destroy()); upstream.on("error", () => socket.destroy()); upstream.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("CDP relay did not bind");
  return { url: `http://127.0.0.1:${address.port}`, async [Symbol.asyncDispose]() {
    for (const peer of peers) peer.destroy();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  } };
}

export async function attachEvidenceBrowser(session: EvidenceSession) {
  const relay = await evidenceCdpRelay(session);
  try {
    const surface = await attachSurface({ name: "evidence-web", kind: "chrome", hostKind: "freestyle", cdpUrl: relay.url, sandboxId: session.id });
    const close = surface.stop.bind(surface);
    let stopped = false;
    surface.stop = async () => { if (stopped) return; stopped = true; await close(); await relay[Symbol.asyncDispose](); };
    surface[Symbol.asyncDispose] = surface.stop;
    return surface;
  } catch (error) { await relay[Symbol.asyncDispose](); throw error; }
}

/** Explicit web-only world; the CI controller still uses its local Blacksmith host. */
export async function freestyleEvidenceWeb(sourceSha: string) {
  const snapshot = await ensureEvidenceSnapshot(sourceSha);
  const session = await launchEvidenceWorld(snapshot, sourceSha);
  try {
    await trackResource({ kind: "freestyle-evidence", id: session.id, match: session.id, label: "evidence-web" });
    const app = await attachEvidenceBrowser(session);
    let stopped = false;
    const stop = async () => { if (stopped) return; try { await app.stop(); } finally { await deleteEvidenceVm(session.id); } stopped = true; };
    return { app, session,
      capture: ({ imageHash }: { imageHash: string }) => captureEvidenceCheckpoint({ vmId: session.id, sourceSha, imageHash }),
      continueStream: () => continueEvidenceStream(session.id),
      async streamState() {
        const text = await execChecked(client().vms.ref(session.id), "node /opt/openwork-preview/evidence-control.mjs state");
        const value: unknown = JSON.parse(text);
        if (typeof value !== "object" || value === null || !("held" in value) || typeof value.held !== "boolean"
          || !("complete" in value) || typeof value.complete !== "boolean" || !("streamCount" in value) || typeof value.streamCount !== "number") throw new Error("Invalid stream witness");
        return { held: value.held, complete: value.complete, streamCount: value.streamCount };
      },
      stop, [Symbol.asyncDispose]: stop,
    };
  } catch (error) { await deleteEvidenceVm(session.id); throw error; }
}
