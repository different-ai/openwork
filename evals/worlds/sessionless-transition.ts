import { browserScript, captureBrowserFilm } from "@openwork/cdp";
import type { AppWeb, Seed } from "@openwork/env";

type Sample = { elapsed: number; source: string; route: string; top: number; left: number; width: number; height: number; starting: boolean; users: number };
declare global {
  interface Window {
    __sessionlessTransition?: { samples: Sample[]; stop(): void };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function sessionlessTransition(seed: Seed, app: AppWeb, workspaceId: string, engine: string) {
  await using setup = new AsyncDisposableStack();
  const endpoint = app.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Sessionless transition requires browser CDP");
  const base = `/workspace/${encodeURIComponent(workspaceId)}/${engine === "v2" ? "opencode2/api" : "opencode"}/session`;
  const socket = new WebSocket(endpoint);
  setup.defer(() => socket.close());
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  let id = 0;
  let creation = 0;
  let prompt = 0;
  let released = false;
  let expired = false;
  let failure: Error | undefined;
  const held = new Set<string>();
  const command = async (method: string, params: Record<string, unknown> = {}) => {
    const key = ++id;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        pending.set(key, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`CDP gate timeout: ${method}`)), 15_000);
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    } finally { clearTimeout(timer); pending.delete(key); }
  };
  socket.addEventListener("message", ({ data }) => {
    const message: unknown = JSON.parse(String(data));
    if (!record(message)) return;
    if (typeof message.id === "number") {
      if (message.error) pending.get(message.id)?.reject(new Error("CDP gate command failed"));
      else pending.get(message.id)?.resolve();
    }
    if (message.method !== "Fetch.requestPaused" || !record(message.params)) return;
    const { requestId, request } = message.params;
    if (typeof requestId !== "string" || !record(request) || typeof request.url !== "string") return;
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === base) {
      creation++;
      if (!released) { held.add(requestId); return; }
    }
    if (request.method === "POST" && path.startsWith(`${base}/`) && /\/(prompt_async|prompt)$/.test(path)) prompt++;
    void command("Fetch.continueRequest", { requestId }).catch((error: Error) => { failure = error; });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP gate connection timeout")), 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP gate connection failed")); }, { once: true });
  });
  await command("Fetch.enable", { patterns: [{ urlPattern: `${new URL(app.openworkUrl).origin}${base}*`, requestStage: "Request" }] });
  const release = async (reject = false) => {
    released = true;
    await Promise.all([...held].map((requestId) => command(reject ? "Fetch.fulfillRequest" : "Fetch.continueRequest", reject ? {
      requestId, responseCode: 400,
      responseHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "Access-Control-Allow-Origin", value: new URL(app.webUrl).origin },
        { name: "Access-Control-Allow-Credentials", value: "true" },
      ],
      body: Buffer.from(JSON.stringify("Session creation rejected by OPE-51 fixture.")).toString("base64"),
    } : { requestId })));
    held.clear();
  };
  setup.defer(async () => { await release(); await command("Fetch.disable"); });
  const timer = setTimeout(() => { expired = true; void release().catch((error: Error) => { failure = error; }); }, 30_000);
  setup.defer(() => clearTimeout(timer));
  const filmPath = seed.tmpPath(`sessionless-transition-${engine}-film`);
  setup.use(await captureBrowserFilm(app, filmPath));
  await seed.evalIn(app, browserScript((workspaceId) => {
    const samples: Sample[] = [];
    const start = performance.now();
    let frame = 0;
    const sample = (source: string) => {
      if (location.hash !== `#/workspace/${workspaceId}/session` || samples.length >= 2000) return;
      const editor = document.querySelector<HTMLElement>('[data-lexical-editor="true"]');
      const rect = editor?.getBoundingClientRect();
      samples.push({ elapsed: performance.now() - start, source, route: location.hash,
        top: rect?.top ?? -1, left: rect?.left ?? -1, width: rect?.width ?? 0, height: rect?.height ?? 0,
        starting: [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent?.includes("Starting")),
        users: document.querySelectorAll('[data-message-role="user"]').length });
    };
    const observer = new MutationObserver(() => sample("mutation"));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    const tick = () => { sample("raf"); frame = requestAnimationFrame(tick); };
    sample("baseline");
    frame = requestAnimationFrame(tick);
    const stop = () => { observer.disconnect(); cancelAnimationFrame(frame); };
    setTimeout(stop, 30_000);
    window.__sessionlessTransition = { samples, stop };
  }, [workspaceId]));
  setup.defer(async () => {
    await seed.evalIn(app, () => { window.__sessionlessTransition?.stop(); delete window.__sessionlessTransition; });
  });
  const resources = setup.move();
  return {
    filmPath,
    release: () => release(),
    fail: () => release(true),
    read() { if (failure) throw failure; return { creation, prompt, held: held.size, expired }; },
    samples: () => seed.evalIn(app, () => window.__sessionlessTransition?.samples ?? []),
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}
