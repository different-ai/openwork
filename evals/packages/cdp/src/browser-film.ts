import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Surface } from "./surface.ts";

// Passive CDP capture. Frame timestamps are Chrome epoch seconds; receivedAt
// records transport latency separately. No sleeps or changes to user actions.
export async function captureBrowserFilm(surface: Surface, directory: string) {
  await mkdir(join(directory, "frames"), { recursive: true });
  const url = surface.client.webSocketDebuggerUrl;
  if (!url) throw new Error("Capture needs an attached browser socket");
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("Film CDP connection failed")); });
  const version = await (await fetch(`${surface.handle.cdpUrl}/json/version`)).json();
  const browserUrl = new URL(version.webSocketDebuggerUrl);
  const baseUrl = new URL(surface.handle.cdpUrl);
  browserUrl.protocol = baseUrl.protocol === "https:" ? "wss:" : "ws:";
  browserUrl.host = baseUrl.host;
  const browser = new WebSocket(browserUrl);
  await new Promise<void>((resolve, reject) => { browser.onopen = () => resolve(); browser.onerror = () => reject(new Error("Download observer connection failed")); });
  let id = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const frames: Array<{ file: string; timestamp: number; receivedAt: number }> = [];
  const downloads: Array<Record<string, unknown>> = [];
  const writes: Promise<void>[] = [];
  const sendOn = (socket: WebSocket, method: string, params: Record<string, unknown> = {}) => new Promise<unknown>((resolve, reject) => {
    const key = ++id; pending.set(key, { resolve, reject }); socket.send(JSON.stringify({ id: key, method, params }));
  });
  const send = (method: string, params: Record<string, unknown> = {}) => sendOn(ws, method, params);
  ws.onmessage = browser.onmessage = ({ data }) => {
    const event = JSON.parse(String(data));
    if (event.id) { const request = pending.get(event.id); pending.delete(event.id); if (event.error) request?.reject(new Error(JSON.stringify(event.error))); else request?.resolve(event.result); }
    if (event.method === "Page.screencastFrame") {
      const { metadata, sessionId, data: jpeg } = event.params;
      const file = `frames/${String(frames.length).padStart(7, "0")}.jpg`;
      frames.push({ file, timestamp: metadata.timestamp, receivedAt: Date.now() });
      writes.push(writeFile(join(directory, file), Buffer.from(jpeg, "base64")));
      ws.send(JSON.stringify({ id: ++id, method: "Page.screencastFrameAck", params: { sessionId } }));
    }
    if (event.method?.startsWith("Browser.download")) {
      downloads.push({ ...event.params, event: event.method, receivedAt: Date.now() });
      writes.push(writeFile(join(directory, "downloads.json"), JSON.stringify(downloads, null, 2)));
    }
  };
  await sendOn(browser, "Browser.setDownloadBehavior", { behavior: "allow", downloadPath: "/tmp/openwork-film-downloads", eventsEnabled: true });
  await send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
  const startedAt = Date.now();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    const stoppedAt = Date.now();
    await send("Page.stopScreencast");
    await Promise.all(writes);
    await writeFile(join(directory, "capture.json"), JSON.stringify({ format: "cdp-screencast", startedAt, stoppedAt, clock: "Chrome epoch seconds", surface: surface.handle.name, platform: surface.handle.hostKind, frames, downloads }, null, 2));
    ws.close();
    browser.close();
  };
  return { downloads, stop, [Symbol.asyncDispose]: stop };
}
