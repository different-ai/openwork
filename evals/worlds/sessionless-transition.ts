import { captureBrowserFilm } from "@openwork/cdp";
import type { AppWeb, Seed } from "@openwork/env";
import { join } from "node:path";

type Sample = { index: number; submitted: boolean; submissionIndex: number | null; submittedAt: number | null; elapsed: number; source: string; route: string; hero: boolean; persisted: string[]; totalUsers: number; top: number; left: number; width: number; height: number; starting: boolean; working: boolean; preparing: boolean; users: number };
declare global {
  interface Window {
    __sessionlessTransition?: { samples: Sample[]; stop(): void };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function sessionlessTransition(seed: Seed, app: AppWeb, workspaceId: string, engine: string, evidenceDirectory: string) {
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
  const filmPath = join(evidenceDirectory, `sessionless-transition-${engine}-film-${Date.now()}`);
  setup.use(await captureBrowserFilm(app, filmPath));
  await seed.evalIn(app, () => {
    const samples: Sample[] = [];
    const start = performance.now();
    let frame = 0;
    let submissionIndex: number | null = null;
    let submittedAt: number | null = null;
    const sample = (source: string) => {
      if (samples.length >= 6000) return;
      const visible = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight
          && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
      };
      const heading = [...document.querySelectorAll<HTMLElement>("h2")]
        .find((node) => node.textContent?.trim() === "What do you need done?" && visible(node));
      const hero = heading?.closest("main");
      const editor = hero?.querySelector<HTMLElement>('[data-lexical-editor="true"]');
      const rect = editor?.getBoundingClientRect();
      const rows = [...document.querySelectorAll<HTMLElement>('[data-message-role="user"]')].filter(visible);
      samples.push({ index: samples.length, submitted: submissionIndex !== null, submissionIndex, submittedAt,
        elapsed: performance.now() - start, source, route: location.hash || `#${location.pathname}`,
        hero: Boolean(hero), users: rows.filter((node) => hero?.contains(node)).length, totalUsers: rows.length,
        persisted: [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")].filter(visible)
          .flatMap((node) => node.dataset.sessionSurfaceId ? [node.dataset.sessionSurfaceId] : []),
        top: rect?.top ?? -1, left: rect?.left ?? -1, width: rect?.width ?? 0, height: rect?.height ?? 0,
        starting: [...document.querySelectorAll<HTMLElement>('[data-loading-message="starting"], [role="status"]')].some((node) => visible(node) && node.textContent?.includes("Starting")),
        working: [...document.querySelectorAll<HTMLElement>('[data-loading-message="working"], [role="status"]')].some((node) => visible(node) && node.textContent?.includes("Working")),
        preparing: [...(hero?.querySelectorAll<HTMLElement>('button[aria-label="Creating conversation..."][aria-busy="true"]') ?? [])]
          .some((node) => visible(node) && Boolean(node.querySelector('.animate-spin'))) });
    };
    const submit = (event: Event) => {
      if (!event.isTrusted || submissionIndex !== null || !(event.target instanceof Element)) return;
      const editor = event.target.closest('[data-lexical-editor="true"]');
      const button = event.target.closest("button");
      const enter = event instanceof KeyboardEvent && event.key === "Enter" && !event.isComposing
        && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && Boolean(editor);
      const click = event.type === "click" && button instanceof HTMLButtonElement && !button.disabled
        && (button.getAttribute("aria-label") ?? button.textContent)?.trim() === "Run task";
      if (!enter && !click) return;
      submissionIndex = samples.length;
      submittedAt = performance.now() - start;
      sample(enter ? "trusted-submit-enter" : "trusted-submit-click");
    };
    window.addEventListener("keydown", submit, true);
    window.addEventListener("click", submit, true);
    const observer = new MutationObserver(() => sample("mutation"));
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    const tick = () => { sample("raf"); frame = requestAnimationFrame(tick); };
    sample("baseline");
    frame = requestAnimationFrame(tick);
    const stop = () => {
      observer.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("keydown", submit, true);
      window.removeEventListener("click", submit, true);
    };
    setTimeout(stop, 60_000);
    window.__sessionlessTransition = { samples, stop };
  });
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
