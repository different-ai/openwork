import { parsePrivatePreview } from "../../evals/packages/hosts/src/private-web-preview.ts";

async function rfb(url: string, expectOpen: boolean): Promise<void> {
  const endpoint = new URL("/websockify", url);
  endpoint.protocol = "wss:";
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(endpoint, ["binary"]);
    socket.binaryType = "arraybuffer";
    const timer = setTimeout(() => finish(new Error("Viewer WebSocket probe timed out.")), 15_000);
    const finish = (error?: Error) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
    socket.onmessage = (event) => {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data);
      finish(expectOpen && text.startsWith("RFB 003.") ? undefined : new Error("Viewer RFB authentication check failed."));
    };
    socket.onopen = () => { if (!expectOpen) finish(new Error("Unsigned viewer WebSocket unexpectedly opened.")); };
    socket.onerror = () => finish(expectOpen ? new Error("Signed viewer WebSocket failed.") : undefined);
  });
}

export async function verifyViewer(signed: string, sandboxId: string): Promise<void> {
  const origins = parsePrivatePreview(new URL(signed).origin, sandboxId, 6080);
  const get = (url: string) => fetch(url, { redirect: "error", headers: { "X-Daytona-Skip-Preview-Warning": "true" }, signal: AbortSignal.timeout(30_000) });
  const unsigned = await get(origins.unsignedOrigin);
  if (![401, 403].includes(unsigned.status)) throw new Error("Unsigned viewer HTTP access was not denied.");
  const response = await get(signed);
  if (!response.ok || !/novnc|vnc/i.test(await response.text())) throw new Error("Signed noVNC viewer unavailable.");
  await rfb(origins.unsignedOrigin, false);
  await rfb(signed, true);
}
