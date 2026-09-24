/** Delay real native requests on the wire; never replace an engine or model answer. */
export async function delayNativeSessionWrites(endpoint: string, delayMs = 21_000) {
  const socket = new WebSocket(endpoint);
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const held = new Map<string, ReturnType<typeof setTimeout>>();
  const samples: { kind: "create" | "prompt"; heldMs: number }[] = [];
  const seen = new Set<string>();
  let nextId = 1;
  let disposed = false;
  let failure: Error | undefined;
  const command = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Native write delay command timed out: ${method}`)), 10_000);
        socket.send(JSON.stringify({ id, method, params }));
      });
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  const fail = () => {
    if (disposed) return;
    failure = new Error("Native write delay lost its debugging connection");
    for (const call of pending.values()) call.reject(failure);
  };
  socket.addEventListener("close", fail);
  socket.addEventListener("error", fail);
  socket.addEventListener("message", event => {
    const message: unknown = JSON.parse(String(event.data));
    if (!record(message)) return;
    if (typeof message.id === "number") {
      const call = pending.get(message.id);
      if (message.error) call?.reject(new Error("Native write delay command failed"));
      else call?.resolve();
    }
    if (message.method !== "Fetch.requestPaused" || !record(message.params)) return;
    const { requestId, request } = message.params;
    if (typeof requestId !== "string" || !record(request) || typeof request.url !== "string") return;
    const path = new URL(request.url).pathname;
    const kind = /\/opencode2\/api\/session\/?$/.test(path) ? "create"
      : /\/opencode2\/api\/session\/[^/]+\/prompt$/.test(path) ? "prompt" : null;
    const release = () => command("Fetch.continueRequest", { requestId }).catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
    });
    if (!disposed && kind && request.method === "POST" && !seen.has(kind)) {
      seen.add(kind);
      const started = performance.now();
      held.set(requestId, setTimeout(() => {
        held.delete(requestId);
        samples.push({ kind, heldMs: Math.round(performance.now() - started) });
        void release();
      }, delayMs));
    } else void release();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native write delay could not connect")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Native write delay could not connect")); }, { once: true });
    });
    await command("Fetch.enable", { patterns: [{ urlPattern: "*/opencode2/api/session*", requestStage: "Request" }] });
  } catch (error) { disposed = true; socket.close(); throw error; }
  return {
    samples() { if (failure) throw failure; return samples.map(sample => ({ ...sample })); },
    async [Symbol.asyncDispose]() {
      disposed = true;
      for (const timer of held.values()) clearTimeout(timer);
      try {
        await Promise.all([...held.keys()].map(requestId => command("Fetch.continueRequest", { requestId })));
        await command("Fetch.disable");
      } finally { held.clear(); socket.close(); }
    },
  };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
