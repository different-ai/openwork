import { addInitScript, browserScript, evaluate } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import type { StreamFeedbackDisclosure, StreamFeedbackSample } from "./stream-feedback-summary.ts";

export const streamFeedbackPrompt = "Prepare a short progress note. STREAM_FEEDBACK_NOTE";
// Leave enough real streamed chunks after the collapsed screenshot and trusted disclosure.
export const streamFeedbackReasoning = Array.from({ length: 96 }, (_, i) => `r${String(i).padStart(2, "0")} `);
export const streamFeedbackText = Array.from({ length: 24 }, (_, i) => `t${String(i).padStart(2, "0")} `);
export const streamFeedbackTail = "The progress note is complete.";

type FeedbackState = {
  sessionId: string | null;
  trustedSendAt: number | null;
  promptPostAt: number | null;
  firstDeltaAt: number | null;
  disclosureAt: number | null;
  disclosureReadyAt: number | null;
  terminalAt: number | null;
  streams: number;
  errors: number;
  preIntentReasoning: Array<{ token: string; receivedAt: number }>;
  preIntentDisclosure: StreamFeedbackDisclosure[];
  disclosureTraceOverflow: boolean;
  frames: number;
  observedAt: number;
  samples: StreamFeedbackSample[];
};

declare global {
  interface Window {
    __streamFeedback?: { state: FeedbackState; arm(sessionId: string): void; stop(): void };
  }
}

/** Real native v2 + loopback HTTP/SSE provider + trusted input in headless appWeb. */
export async function streamFeedback(seed: Seed) {
  const mock = seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
    promptMarker: streamFeedbackPrompt, latestUserTurn: true, steps: [],
    finalReasoning: streamFeedbackReasoning.join(""), finalReasoningChunks: streamFeedbackReasoning,
    finalReply: streamFeedbackText.join("") + streamFeedbackTail,
    finalReplyChunks: [...streamFeedbackText, streamFeedbackTail], finalReplyInitiallyReleasedChunks: 0,
  }] });
  const workspacePath = seed.tmpPath("stream-feedback");
  // An operator can reuse a previously verified cached pin without another download.
  // The live health identity is still asserted; an override is not itself evidence.
  const binary = process.env.OPENWORK_OPENCODE2_BIN;
  const app = await seed.appWeb({ name: "stream-feedback", engine: "v2", workspacePath, mocks: { agent: mock },
    ...(binary ? { env: { OPENWORK_OPENCODE2_BIN: binary } } : {}),
  });
  const provider = app.mocks.agent;
  if (!provider) throw new Error("Stream feedback provider was not started");
  const workspace = await seed.workspace(app, workspacePath);

  // Test-only read-only tee. The original Response, bytes and app reader are unchanged.
  // This is native delta receipt at the browser, NOT provider token generation,
  // adapter-internal acceptance, compositor presentation, or display-device paint.
  const registration = await addInitScript(app.client, browserScript((reasoning, text) => {
    if (window.top !== window) return;
    const state: FeedbackState = {
      sessionId: null, trustedSendAt: null, promptPostAt: null, firstDeltaAt: null,
      disclosureAt: null, disclosureReadyAt: null, terminalAt: null, streams: 0, errors: 0,
      preIntentReasoning: [], preIntentDisclosure: [], disclosureTraceOverflow: false,
      frames: 0, observedAt: performance.now(), samples: [],
    };
    const seen = new Set<string>();
    const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
    const root = () => [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"] [data-session-surface-id]')]
      .find(node => node.dataset.sessionSurfaceId === state.sessionId);
    const tokenVisible = (token: string, kind: "reasoning" | "text") => {
      const surface = root();
      const viewport = surface?.querySelector<HTMLElement>("[data-thread-scroll]")?.getBoundingClientRect();
      if (!surface || !viewport || document.visibilityState !== "visible") return false;
      for (const message of surface.querySelectorAll<HTMLElement>('[data-message-role="assistant"]')) {
        const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const index = node.textContent?.indexOf(token) ?? -1;
          const parent = node.parentElement;
          if (index < 0 || !parent || Boolean(parent.closest("[data-reasoning-block]")) !== (kind === "reasoning")) continue;
          const style = getComputedStyle(parent);
          if (style.visibility === "hidden" || style.display === "none" || parent.closest('[hidden], [aria-hidden="true"]')) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + token.length);
          const rect = range.getBoundingClientRect();
          const disclosure = parent.closest("[data-reasoning-block]")?.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, viewport.top)
            && rect.top < Math.min(innerHeight, viewport.bottom) && rect.right > Math.max(0, viewport.left)
            && rect.left < Math.min(innerWidth, viewport.right)
            && (!disclosure || (rect.bottom > disclosure.top && rect.top < disclosure.bottom))) return true;
        }
      }
      return false;
    };
    const traceDisclosure = (source: StreamFeedbackDisclosure["source"], expandedOverride?: boolean) => {
      if (state.disclosureAt !== null || state.trustedSendAt === null) return;
      const button = root()?.querySelector('[data-reasoning-block] button[aria-expanded]');
      if (!button) return;
      if (state.preIntentDisclosure.length >= 5000) { state.disclosureTraceOverflow = true; return; }
      const expanded = button.getAttribute("aria-expanded");
      state.preIntentDisclosure.push({
        at: performance.now(), source,
        expanded: expandedOverride ?? (expanded === "true" ? true : expanded === "false" ? false : null),
        bodyVisible: tokenVisible(reasoning[0].trim(), "reasoning"),
        receivedReasoning: state.preIntentReasoning.length,
      });
    };
    const sample = (source: "dom" | "frame") => {
      if (!state.sessionId) return;
      if (source === "frame") state.frames++;
      const now = performance.now();
      state.observedAt = now;
      traceDisclosure(source === "frame" ? "frame" : "mutation");
      if (state.disclosureAt !== null && state.disclosureReadyAt === null && tokenVisible(reasoning[0].trim(), "reasoning")) state.disclosureReadyAt = now;
      for (const item of state.samples) {
        if (item.frameAt !== null || !tokenVisible(item.token, item.kind)) continue;
        item.domAt ??= now;
        if (source === "frame") { item.frameAt = now; item.terminalAtFrame = state.terminalAt !== null; }
      }
    };
    const receive = (line: string) => {
      if (!line.startsWith("data:") || !state.sessionId) return;
      let event: unknown;
      try { event = JSON.parse(line.slice(5).trim()); if (typeof event === "string") event = JSON.parse(event); } catch { return; }
      if (!record(event)) return;
      const props = record(event.data) ? event.data : record(event.properties) ? event.properties : event;
      if ((props.sessionID ?? props.sessionId) !== state.sessionId) return;
      if (typeof event.type !== "string") return;
      if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) state.terminalAt ??= performance.now();
      const kind = /^session\.(?:next\.)?reasoning\.delta$/.test(event.type) ? "reasoning"
        : /^session\.(?:next\.)?text\.delta$/.test(event.type) ? "text" : null;
      if (!kind || typeof props.delta !== "string") return;
      const receivedAt = performance.now();
      state.firstDeltaAt ??= receivedAt;
      for (const chunk of kind === "reasoning" ? reasoning : text) {
        const token = chunk.trim();
        if (!props.delta.includes(token) || seen.has(token)) continue;
        seen.add(token);
        if (kind === "reasoning" && state.disclosureAt === null) {
          state.preIntentReasoning.push({ token, receivedAt });
          continue;
        }
        // Retain EVERY post-intent arrival, even while opening is slow or never succeeds.
        state.samples.push({ kind, token, receivedAt, domAt: null, frameAt: null, terminalAtFrame: null });
      }
      traceDisclosure("arrival");
    };
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (state.sessionId && method === "POST" && url.pathname.includes(`/session/${encodeURIComponent(state.sessionId)}/`)
        && /\/(?:prompt|prompt_async)$/.test(url.pathname)) state.promptPostAt ??= performance.now();
      const response = await originalFetch.call(window, input, init);
      if (method === "GET" && /\/opencode2\/api\/event$/.test(url.pathname) && response.headers.get("content-type")?.includes("text/event-stream")) {
        const reader = response.clone().body?.getReader();
        if (reader) {
          state.streams++;
          void (async () => {
            const decoder = new TextDecoder();
            let pending = "";
            try {
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                pending += decoder.decode(chunk.value, { stream: true });
                const lines = pending.split(/\r?\n/);
                pending = lines.pop() ?? "";
                for (const line of lines) receive(line);
              }
            } catch { state.errors++; }
            finally { reader.releaseLock(); }
          })();
        }
      }
      return response;
    };
    const click = (event: MouseEvent) => {
      if (!event.isTrusted || !state.sessionId) return;
      const surface = root();
      const button = event.composedPath().find((node): node is HTMLButtonElement => node instanceof HTMLButtonElement);
      if (!button || !surface?.contains(button)) return;
      if (button.closest("[data-reasoning-block]") && state.disclosureAt === null) {
        traceDisclosure("intent");
        state.disclosureAt = performance.now();
      }
      if ((button.textContent?.trim() === "Run task" || button.getAttribute("aria-label") === "Run task") && state.trustedSendAt === null) state.trustedSendAt = performance.now();
    };
    window.addEventListener("click", click, true);
    const observer = new MutationObserver(records => {
      // Preserve an open -> closed transition even when both attribute writes share a callback.
      for (const mutation of records) {
        if (mutation.type === "attributes" && mutation.attributeName === "aria-expanded" && mutation.oldValue === "true"
          && mutation.target instanceof Element && mutation.target.closest("[data-reasoning-block]")
          && root()?.contains(mutation.target)) traceDisclosure("attribute-history", true);
      }
      sample("dom");
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeOldValue: true });
    let frame = 0;
    const tick = () => { sample("frame"); frame = requestAnimationFrame(tick); };
    frame = requestAnimationFrame(tick);
    window.__streamFeedback = {
      state,
      arm(sessionId) { if (state.sessionId) throw new Error("Stream feedback is already armed"); state.sessionId = sessionId; },
      stop() { cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener("click", click, true); window.fetch = originalFetch; },
    };
  }, [streamFeedbackReasoning, streamFeedbackText]));

  await configureProvider(seed, app, workspace.workspaceId, "stream-feedback-mock", "stream-feedback-model", {
    provider: { "stream-feedback-mock": {
      npm: "@ai-sdk/openai-compatible", name: "Stream feedback model",
      options: { baseURL: `${provider.url}/v1`, apiKey: "sk-stream-feedback-fixture" },
      models: { "stream-feedback-model": { name: "Stream feedback model", reasoning: true } },
    } },
  }, "v2");
  const session = await seed.session(app, { title: "Stream feedback note" });
  await evaluate(app.client, browserScript(sessionId => {
    if (!window.__streamFeedback) throw new Error("Stream feedback observer missing");
    window.__streamFeedback.arm(sessionId);
  }, [session.sessionId]));
  return {
    app, workspace, session,
    feedback: () => evaluate(app.client, () => {
      if (!window.__streamFeedback) throw new Error("Stream feedback observer lost its document");
      return { ...window.__streamFeedback.state, observedAt: performance.now() };
    }),
    runtime: () => evaluate(app.client, async () => {
      const base = `http://127.0.0.1:${localStorage.getItem("openwork.server.port")}`;
      const response = await fetch(`${base}/experimental/engine-v2-preview/status`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("openwork.server.token")}` },
        signal: AbortSignal.timeout(15_000),
      });
      const value: unknown = await response.json();
      const status = typeof value === "object" && value !== null ? value : {};
      // Safe runtime identity only: never serialize environment, binary paths, errors or credentials.
      return {
        httpStatus: response.status,
        running: "running" in status && status.running === true,
        chatRouting: "chatRouting" in status && status.chatRouting === true,
        version: "version" in status && typeof status.version === "string" && /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(status.version) ? status.version : null,
        pid: "pid" in status && typeof status.pid === "number" && Number.isSafeInteger(status.pid) && status.pid > 0 ? status.pid : null,
        binSource: "binSource" in status && ["env", "path", "cache"].includes(String(status.binSource)) ? String(status.binSource) : null,
      };
    }),
    providerState: () => provider.agentReplyState(streamFeedbackPrompt),
    releaseText: (count = 1) => provider.releaseAgentReply(streamFeedbackPrompt, count),
    async [Symbol.asyncDispose]() {
      await evaluate(app.client, () => window.__streamFeedback?.stop());
      await registration.dispose();
    },
  };
}
