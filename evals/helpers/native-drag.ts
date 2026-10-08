import type { Surface } from "@openwork/cdp";

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** Chromium's OS drag loop does not reliably drop on dispatchMouseEvent's
 * release. Capture the real drag payload and continue through CDP's native
 * drag API, as browser automation drivers do. No DOM events or invented data.
 */
export async function nativeDrag(surface: Surface, from: { x: number; y: number }, to: { x: number; y: number }, during?: () => Promise<unknown>) {
  const endpoint = surface.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Native drag requires a CDP endpoint");
  const socket = new WebSocket(endpoint);
  let nextId = 0;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let payload: Record<string, unknown> | null = null;
  socket.addEventListener("message", event => {
    const message: unknown = JSON.parse(String(event.data));
    if (!record(message)) return;
    if (typeof message.id === "number") {
      const callback = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) callback?.reject(new Error(`Native drag CDP error: ${JSON.stringify(message.error)}`));
      else callback?.resolve();
    }
    if (message.method === "Input.dragIntercepted" && record(message.params) && record(message.params.data)) payload = message.params.data;
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native drag connection timed out")), 10_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Native drag connection failed")); }, { once: true });
  });
  const send = (method: string, params: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native drag timed out: ${method}`)); }, 10_000);
    pending.set(id, { resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
  try {
    await send("Input.setInterceptDrags", { enabled: true });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...from });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", ...from, button: "left", buttons: 1, clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y + Math.sign(to.y - from.y) * 12, button: "left", buttons: 1 });
    const deadline = Date.now() + 10_000;
    while (!payload && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!payload) throw new Error("The row did not start a native drag");
    await send("Input.dispatchDragEvent", { type: "dragEnter", ...from, data: payload });
    for (let index = 1; index <= 20; index++) {
      await send("Input.dispatchDragEvent", { type: "dragOver", x: from.x + (to.x - from.x) * index / 20,
        y: from.y + (to.y - from.y) * index / 20, data: payload });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await during?.();
    await send("Input.dispatchDragEvent", { type: "drop", ...to, data: payload });
  } finally {
    try {
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...to, button: "left", buttons: 0, clickCount: 1 });
      await send("Input.setInterceptDrags", { enabled: false });
    } finally { socket.close(); }
  }
}
