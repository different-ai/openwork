import { browserScript, evaluate } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { sessionArchivePressure } from "./session-archive-pressure.ts";

export function sendPressureMode() {
  const mode = process.env.OPENWORK_SEND_PRESSURE_MODE ?? "fixed";
  if (mode !== "baseline" && mode !== "fixed") throw new Error("OPENWORK_SEND_PRESSURE_MODE must be baseline or fixed");
  return mode;
}

export async function sessionSendPressure(seed: Seed, context: { place: Place }) {
  await using resources = new AsyncDisposableStack();
  const pressure = resources.use(await sessionArchivePressure(seed, context));
  const { app, selected } = pressure;
  const prompt = "Complete the isolated send pressure witness.";
  const newerDraft = "Keep this newer draft unsent.";
  const reply = "Archive fixture reply.";
  const server = await evaluate(app.client, async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.baseUrl || !info.running) throw new Error("Isolated fixture is not running");
    return { baseUrl: info.baseUrl, token: info.ownerToken ?? info.clientToken };
  }, { awaitPromise: true });
  const readMessages = async () => {
    const response = await fetch(`${server.baseUrl}/workspace/${selected.workspaceId}/opencode/session/${selected.sessionId}/message`, {
      headers: { Authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Fixture transcript read failed: ${response.status}`);
    const messages: { info: { id: string; role: string; parentID?: string; time: { completed?: number }; error?: unknown }; parts: { type: string; text?: string }[] }[] = await response.json();
    return messages.map(({ info, parts }) => ({ id: info.id, role: info.role, parentID: info.parentID,
      completed: info.time.completed, error: info.error,
      text: parts.filter(part => part.type === "text").map(part => part.text).join("\n") }));
  };
  await evaluate(app.client, browserScript((sessionId, prompt) => {
    const samples: { atMs: number; draft: string; text: string; status: string[]; action: string | null }[] = [];
    let started: number | null = null;
    let submittedAt: number | null = null;
    let startingMs: number | null = null;
    let messageMs: number | null = null;
    let trusted = false;
    const snapshot = () => {
      const surface = document.querySelector<HTMLElement>(`[data-session-surface-id="${sessionId}"]`);
      return {
        atMs: started === null ? 0 : performance.now() - started,
        draft: surface?.querySelector<HTMLElement>('[data-lexical-editor="true"]')?.innerText.trim() ?? "",
        text: surface?.innerText ?? "",
        status: [...(surface?.querySelectorAll<HTMLElement>("[data-loading-message]") ?? [])].map(node => node.innerText),
        action: surface?.querySelector("[data-composer-actions] button")?.getAttribute("aria-label") ?? null,
      };
    };
    const sample = () => {
      const state = snapshot();
      if (started !== null) {
        const surface = document.querySelector(`[data-session-surface-id="${sessionId}"]`);
        if (surface?.querySelector('[data-loading-message="starting"]')) startingMs ??= state.atMs;
        if ([...(surface?.querySelectorAll<HTMLElement>('[data-message-role="user"]') ?? [])].some(node => node.innerText.includes(prompt))) messageMs ??= state.atMs;
        const last = samples.at(-1);
        if (!last || last.draft !== state.draft || last.text !== state.text || last.action !== state.action) samples.push(state);
      }
      return state;
    };
    const capture = (event: KeyboardEvent) => {
      if (started !== null || event.key !== "Enter" || !event.isTrusted || !(event.target instanceof Element)
        || !event.target.closest(`[data-session-surface-id="${sessionId}"] [data-lexical-editor="true"]`)) return;
      started = performance.now();
      submittedAt = Date.now();
      trusted = true;
      sample();
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["aria-label", "data-loading-message"] });
    document.addEventListener("keydown", capture, true);
    window.__sendPressureUi = {
      read: () => ({ ...sample(), submittedAt, startingMs, messageMs, trusted, samples: [...samples] }),
      dispose: () => { observer.disconnect(); document.removeEventListener("keydown", capture, true); delete window.__sendPressureUi; },
    };
  }, [selected.sessionId, prompt]));
  resources.defer(() => evaluate(app.client, () => window.__sendPressureUi?.dispose()).then(() => undefined));
  const lifetime = resources.move();
  return {
    ...pressure, prompt, newerDraft, reply, readMessages,
    ui: () => evaluate(app.client, () => {
      if (!window.__sendPressureUi) throw new Error("Missing send UI observer");
      return window.__sendPressureUi.read();
    }),
    async [Symbol.asyncDispose]() { await lifetime.disposeAsync(); },
  };
}

declare global {
  interface Window {
    __sendPressureUi?: {
      read(): { atMs: number; draft: string; text: string; status: string[]; action: string | null; submittedAt: number | null; startingMs: number | null; messageMs: number | null; trusted: boolean;
        samples: { atMs: number; draft: string; text: string; status: string[]; action: string | null }[] };
      dispose(): void;
    };
  }
}
