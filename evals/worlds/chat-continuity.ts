import { browserScript, evaluate, type Surface } from "@openwork/cdp";

type SurfaceExpectation = {
  sessionId?: string;
  pane: "primary" | "secondary";
  required?: string[];
  forbidden?: string[];
};
type SurfaceObservation = {
  frames: number;
  mutations: number;
  shortSamples: number;
  longSamples: number;
  elapsedMs: number;
  loaderSeen: boolean;
  text: string;
  violations: string[];
  expired: boolean;
};

declare global {
  interface Window {
    __chatContinuity?: { state: SurfaceObservation; stop(): void };
    __chatCreation?: {
      workspaceLists: number; creates: number; reblocked: boolean; expired: boolean;
      lastCreateAt: number | null; restore(): void;
    };
  }
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Faults and observers only; navigation and creation remain trusted user actions. */
export function chatContinuity(app: Surface, workspaceId: string) {
  return {
    async observeSurface(expected: SurfaceExpectation) {
      await evaluate(app.client, browserScript((workspaceId, expected) => {
        if (window.__chatContinuity) throw new Error("A chat continuity observer is already active");
        const state: SurfaceObservation = {
          frames: 0, mutations: 0, shortSamples: 0, longSamples: 0, elapsedMs: 0,
          loaderSeen: false, text: "", violations: [], expired: false,
        };
        let selectedAt: number | undefined;
        let frame = 0;
        const visible = (node: HTMLElement) => node.getClientRects().length > 0
          && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none";
        const sample = () => {
          const pane = document.querySelector<HTMLElement>('[data-workbench-pane="' + expected.pane + '"]');
          const surface = pane?.querySelector<HTMLElement>('[data-session-surface-id]');
          // Arm before the click. Inspect the pane as soon as the route OR its
          // surface adopts the destination, including stale content in that pane.
          const selected = surface && (!expected.sessionId || surface.dataset.sessionSurfaceId === expected.sessionId)
            && surface.dataset.sessionSurfaceWorkspaceId === workspaceId;
          if (selectedAt === undefined && !selected
            && !(expected.pane === "primary" && expected.sessionId && location.hash.includes(expected.sessionId))) return;
          selectedAt ??= performance.now();
          state.elapsedMs = performance.now() - selectedAt;
          if (state.elapsedMs < 1500) state.shortSamples++;
          if (state.elapsedMs > 2200) state.longSamples++;
          state.text = [...(pane?.querySelectorAll<HTMLElement>('[data-message-role]') ?? [])]
            .filter(visible).map(node => node.innerText).join("\n");
          const text = pane?.innerText ?? "";
          const starters = ["Try one of these:", "Try one of your organization's prompts:", "Connect a model provider to get started:"]
            .some(label => text.includes(label));
          const loader = text.includes("Opening session") || text.includes("Switching session");
          state.loaderSeen ||= loader;
          const violations = [
            ...(starters ? ["starters in pending or historical conversation"] : []),
            ...(loader && state.elapsedMs < 1500 ? ["loader appeared before its own delay"] : []),
            ...(expected.forbidden ?? []).filter(text => state.text.includes(text)).map(text => "foreign message: " + text),
            ...(expected.required ?? []).filter(text => !state.text.includes(text)).map(text => "cached message missing: " + text),
          ];
          for (const violation of violations) {
            if (!state.violations.includes(violation)) state.violations.push(violation);
          }
        };
        const paint = () => { state.frames++; sample(); frame = requestAnimationFrame(paint); };
        const observer = new MutationObserver(() => { state.mutations++; sample(); });
        observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        frame = requestAnimationFrame(paint);
        sample();
        const timer = setTimeout(() => { state.expired = true; stop(); }, 60000);
        function stop() { clearTimeout(timer); observer.disconnect(); cancelAnimationFrame(frame); }
        window.__chatContinuity = { state, stop };
      }, [workspaceId, expected]));
      let disposed = false;
      return {
        read: () => evaluate(app.client, () => {
          if (!window.__chatContinuity) throw new Error("Chat observer lost its document");
          return window.__chatContinuity.state;
        }),
        async [Symbol.asyncDispose]() {
          if (disposed) return;
          disposed = true;
          await evaluate(app.client, () => { window.__chatContinuity?.stop(); delete window.__chatContinuity; });
        },
      };
    },

    async surfaceState(pane: "primary" | "secondary") {
      return evaluate(app.client, browserScript((pane) => {
        const root = document.querySelector<HTMLElement>('[data-workbench-pane="' + pane + '"]');
        return {
          sessionId: root?.querySelector<HTMLElement>('[data-session-surface-id]')?.dataset.sessionSurfaceId,
          starters: (root?.innerText ?? "").includes("Try one of these:"),
          messages: root?.querySelectorAll('[data-message-role]').length ?? 0,
        };
      }, [pane]));
    },

    async observeCreation() {
      await evaluate(app.client, () => {
        if (window.__chatCreation) throw new Error("A creation observer is already active");
        const originalFetch = window.fetch;
        let frame = 0;
        const state: NonNullable<Window["__chatCreation"]> = {
          workspaceLists: 0, creates: 0, reblocked: false, expired: false, lastCreateAt: null,
          restore() { window.fetch = originalFetch; observer.disconnect(); cancelAnimationFrame(frame); clearTimeout(timer); },
        };
        const sample = () => {
          if (state.creates > 0 && document.body.innerText.includes("Pulling in the latest messages for this task.")) state.reblocked = true;
        };
        const paint = () => { sample(); frame = requestAnimationFrame(paint); };
        const observer = new MutationObserver(sample);
        observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
        frame = requestAnimationFrame(paint);
        const timer = setTimeout(() => { state.expired = true; state.restore(); }, 60000);
        window.fetch = function (...args) {
          const request = args[0];
          const path = new URL(request instanceof Request ? request.url : String(request), location.href).pathname;
          const method = args[1]?.method ?? (request instanceof Request ? request.method : "GET");
          if (method === "GET" && path === "/workspaces") state.workspaceLists++;
          if (method === "POST" && /\/(?:opencode|opencode2\/api)\/session$/.test(path)) {
            state.creates++;
            state.lastCreateAt = performance.now();
          }
          return originalFetch.apply(this, args);
        };
        window.__chatCreation = state;
      });
      let disposed = false;
      return {
        read: () => evaluate(app.client, () => {
          const state = window.__chatCreation;
          if (!state) throw new Error("Creation observer lost its document");
          return { workspaceLists: state.workspaceLists, creates: state.creates, reblocked: state.reblocked, expired: state.expired,
            elapsedMs: state.lastCreateAt === null ? 0 : performance.now() - state.lastCreateAt };
        }),
        async [Symbol.asyncDispose]() {
          if (disposed) return;
          disposed = true;
          await evaluate(app.client, () => { window.__chatCreation?.restore(); delete window.__chatCreation; });
        },
      };
    },

    async holdHistory(sessionId: string, ...otherSessionIds: string[]) {
      const endpoint = app.client.webSocketDebuggerUrl;
      if (!endpoint) throw new Error("History fault requires the desktop CDP endpoint");
      const origin = await evaluate(app.client, () => "http://127.0.0.1:" + localStorage.getItem("openwork.server.port"));
      const sessionIds = [sessionId, ...otherSessionIds];
      const paths = sessionIds.flatMap(id => ["workspace", "w"].flatMap(mount => ["opencode", "opencode2/api"].map(engine =>
        `/${mount}/${encodeURIComponent(workspaceId)}/${engine}/session/${encodeURIComponent(id)}/message`)));
      const socket = new WebSocket(endpoint);
      const ready = deferred();
      const commands = new Map<number, ReturnType<typeof deferred>>();
      const held = new Map<string, { networkId: string; startedAt: number; snapshot: boolean; sessionId: string }>();
      const ended = new Set<string>();
      let nextId = 1;
      let released = false;
      let disposed = false;
      let failure: Error | undefined;
      const command = async (method: string, params = {}) => {
        const id = nextId++;
        const result = deferred();
        commands.set(id, result);
        const timer = setTimeout(() => result.reject(new Error(`History fault timed out: ${method}`)), 15000);
        try { socket.send(JSON.stringify({ id, method, params })); await result.promise; }
        finally { clearTimeout(timer); commands.delete(id); }
      };
      const fail = () => {
        if (disposed) return;
        failure = new Error("History fault lost its CDP connection");
        ready.reject(failure);
        for (const result of commands.values()) result.reject(failure);
      };
      socket.addEventListener("open", () => ready.resolve());
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      socket.addEventListener("message", event => {
        const message: unknown = JSON.parse(String(event.data));
        if (!message || typeof message !== "object") return;
        if ("id" in message && typeof message.id === "number") {
          const result = commands.get(message.id);
          if ("error" in message) result?.reject(new Error("History fault CDP command failed"));
          else result?.resolve();
        }
        if (!("method" in message) || !("params" in message) || !message.params || typeof message.params !== "object") return;
        const params = message.params;
        if (!("requestId" in params) || typeof params.requestId !== "string") return;
        if (message.method === "Network.loadingFailed" || message.method === "Network.loadingFinished") ended.add(params.requestId);
        if (message.method !== "Fetch.requestPaused") return;
        const request = "request" in params ? params.request : null;
        if (!released && request && typeof request === "object" && "method" in request && request.method === "GET"
          && "url" in request && typeof request.url === "string" && paths.includes(new URL(request.url).pathname)) {
          if (!("networkId" in params) || typeof params.networkId !== "string") { fail(); return; }
          const path = new URL(request.url).pathname;
          const heldSessionId = sessionIds.find(id => path.endsWith(`/${encodeURIComponent(id)}/message`));
          if (!heldSessionId) { fail(); return; }
          // Distinguish the surface snapshot (140) from background sync reads (20).
          held.set(params.requestId, { networkId: params.networkId, startedAt: performance.now(), sessionId: heldSessionId,
            snapshot: new URL(request.url).searchParams.get("limit") === "140" });
        } else void command("Fetch.continueRequest", { requestId: params.requestId }).catch((error: Error) => { failure = error; });
      });
      const timer = setTimeout(() => ready.reject(new Error("History fault could not connect")), 15000);
      try {
        await ready.promise;
        await command("Network.enable");
        await command("Fetch.enable", { patterns: paths.map(path => ({ urlPattern: origin + path + "*", requestStage: "Request" })) });
      } catch (error) { disposed = true; socket.close(); throw error; }
      finally { clearTimeout(timer); }
      return {
        read(id = sessionId) {
          if (failure) throw failure;
          const snapshots = [...held.values()].filter(item => item.sessionId === id && item.snapshot && !ended.has(item.networkId));
          return { held: held.size, pending: !released && snapshots.length > 0,
            elapsedMs: snapshots.length ? Math.max(...snapshots.map(item => performance.now() - item.startedAt)) : 0 };
        },
        async release() {
          released = true;
          await Promise.all([...held].filter(([, item]) => !ended.has(item.networkId))
            .map(([requestId]) => command("Fetch.continueRequest", { requestId })));
        },
        async [Symbol.asyncDispose]() {
          try { await command("Fetch.disable"); }
          finally { disposed = true; socket.close(); }
        },
      };
    },
  };
}
