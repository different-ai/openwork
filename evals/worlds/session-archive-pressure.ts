import { browserScript, evaluate, type Surface } from "@openwork/cdp";
import { SkipError, type Place, type Seed } from "@openwork/env";
import { archiveActiveSessions } from "./session-shell.ts";

export function archivePressureMode(): "baseline" | "fixed" {
  const mode = process.env.OPENWORK_ARCHIVE_PRESSURE_MODE ?? "fixed";
  if (mode !== "baseline" && mode !== "fixed") {
    throw new Error("OPENWORK_ARCHIVE_PRESSURE_MODE must be baseline or fixed");
  }
  return mode;
}

type Phase = "control" | "pressure" | "sidebar" | "recovery";
type Reason = { name: string; message: string };
type FetchMetadata = {
  sequence: number;
  phase: Phase;
  method: string;
  path: string;
  fixtureKey: string | null;
  elapsedMs: number | null;
  status: number | null;
  abortReason: Reason | null;
  error: Reason | null;
};
type StreamMetadata = {
  key: string;
  path: string;
  status: number | null;
  contentType: string | null;
  chunks: number;
  established: boolean;
  closed: boolean;
  error: Reason | null;
};
type UiMeasurement = {
  trustedClick: boolean;
  clickedAt: number | null;
  failureMs: number | null;
  timeoutDescription: boolean;
  successMs: number | null;
  ticks: number;
  frames: number;
  maxTickGapMs: number;
};
type PressureSnapshot = {
  phase: Phase;
  streams: StreamMetadata[];
  requests: FetchMetadata[];
  released: boolean;
  expired: boolean;
  ticks: number;
  frames: number;
  maxTickGapMs: number;
  ui: UiMeasurement;
  activeRows: string[];
  hash: string;
};

declare global {
  interface Window {
    __sessionArchivePressure?: {
      read(): PressureSnapshot;
      phase(value: Phase): void;
      start(): void;
      canary(): Promise<FetchMetadata & { bodyComplete: boolean }>;
      release(): Promise<void>;
      dispose(): Promise<void>;
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type NetworkMetadata = {
  requestId: string;
  phase: Phase;
  method: string;
  path: string;
  fixtureKey: string | null;
  startedAt: number;
  wireRequestObserved: boolean;
  status: number | null;
  protocol: string | null;
  connectionId: number | null;
  responseMs: number | null;
  elapsedMs: number | null;
  finished: boolean;
  failure: string | null;
  canceled: boolean;
};

async function observeNetwork(app: Surface, origin: string, mounts: string[]) {
  const endpoint = app.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Pressure witness requires its fixture renderer CDP endpoint");
  const socket = new WebSocket(endpoint);
  const requests = new Map<string, NetworkMetadata>();
  const wireRequests = new Set<string>();
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  let phase: Phase = "control";
  let sequence = 0;
  let disposed = false;
  let failure: Error | null = null;
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Pressure network observer connection timed out")), 5_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Pressure network observer connection failed")); }, { once: true });
    socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Pressure network observer closed before connecting")); }, { once: true });
  });
  const disconnected = () => {
    if (disposed) return;
    failure = new Error("Pressure network observer disconnected");
    for (const call of pending.values()) call.reject(failure);
  };
  socket.addEventListener("error", disconnected);
  socket.addEventListener("close", disconnected);
  socket.addEventListener("message", event => {
    const message: unknown = JSON.parse(String(event.data));
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const call = pending.get(message.id);
      if (message.error) call?.reject(new Error("Pressure network observer command failed"));
      else call?.resolve();
      return;
    }
    const params = message.params;
    if (!isRecord(params) || typeof params.requestId !== "string") return;
    if (message.method === "Network.requestWillBeSentExtraInfo") {
      wireRequests.add(params.requestId);
      const request = requests.get(params.requestId);
      if (request) request.wireRequestObserved = true;
      return;
    }
    if (message.method === "Network.requestWillBeSent") {
      const request = params.request;
      if (!isRecord(request) || typeof request.url !== "string" || typeof request.method !== "string"
        || typeof params.timestamp !== "number") return;
      const url = new URL(request.url);
      if (url.origin !== origin || !mounts.some(mount => url.pathname.startsWith(`${mount}/`))) return;
      const key = url.searchParams.get("archive_pressure");
      requests.set(params.requestId, {
        requestId: params.requestId, phase, method: request.method, path: url.pathname,
        fixtureKey: key && /^(stream|canary)-\d+$/.test(key) ? key : null,
        startedAt: params.timestamp, wireRequestObserved: wireRequests.has(params.requestId), status: null, protocol: null, connectionId: null,
        responseMs: null, elapsedMs: null, finished: false, failure: null, canceled: false,
      });
      return;
    }
    const request = requests.get(params.requestId);
    if (!request) return;
    if (message.method === "Network.responseReceived" && isRecord(params.response)) {
      const response = params.response;
      request.status = typeof response.status === "number" ? response.status : null;
      request.protocol = typeof response.protocol === "string" ? response.protocol : null;
      request.connectionId = typeof response.connectionId === "number" ? response.connectionId : null;
      request.responseMs = typeof params.timestamp === "number" ? (params.timestamp - request.startedAt) * 1_000 : null;
    }
    if (message.method === "Network.loadingFinished" || message.method === "Network.loadingFailed") {
      request.finished = true;
      request.elapsedMs = typeof params.timestamp === "number" ? (params.timestamp - request.startedAt) * 1_000 : null;
      request.failure = typeof params.errorText === "string" && /^net::[A-Z_]+$/.test(params.errorText) ? params.errorText : null;
      request.canceled = params.canceled === true;
    }
  });
  const send = async (method: string) => {
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(`Pressure network observer timed out: ${method}`)), 5_000);
        socket.send(JSON.stringify({ id, method }));
      });
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  try {
    await connected;
    await send("Network.enable");
  } catch (error) {
    disposed = true;
    socket.close();
    throw error;
  }
  return {
    phase(value: Phase) { phase = value; },
    read() {
      if (failure) throw failure;
      return [...requests.values()].map(request => ({ ...request }));
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      try { if (!failure) await send("Network.disable"); }
      finally { disposed = true; socket.close(); }
    },
  };
}

export async function sessionArchivePressure(seed: Seed, context: { place: Place }) {
  if (context.place.kind !== "local") {
    throw new SkipError("pressure readback requires runner-reachable fixture loopback; use --local --engine v1 --surface electron");
  }
  if (process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()) {
    throw new SkipError("pressure witness requires the source-built fixture app; unset OPENWORK_EVAL_ELECTRON_BINARY");
  }
  await using resources = new AsyncDisposableStack();
  const fixture = resources.use(await archiveActiveSessions(seed, context));
  const { app, a1, a2, b1, child, faultCandidate, workspaceA, workspaceB } = fixture;
  const targets = [a1, a2, b1, child, faultCandidate];
  const workspaceIds = [workspaceA.workspaceId, workspaceB.workspaceId];
  const mount = (workspaceId: string) => `/workspace/${encodeURIComponent(workspaceId)}/opencode`;
  const mounts = workspaceIds.map(mount);
  const targetPath = `${mount(a2.workspaceId)}/session/${encodeURIComponent(a2.sessionId)}`;
  const server = await evaluate(app.client, async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl) throw new Error("Pressure fixture server unavailable");
    return { baseUrl: info.baseUrl, token: info.ownerToken ?? info.clientToken };
  }, { awaitPromise: true, timeoutMs: 5_000 });
  if (!server.token) throw new Error("Pressure fixture server credential unavailable");
  const baseUrl = new URL(server.baseUrl);
  if (baseUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(baseUrl.hostname)
    || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash) {
    throw new Error("Pressure witness only accepts the isolated HTTP loopback fixture server");
  }
  const network = resources.use(await observeNetwork(app, baseUrl.origin, mounts));
  resources.defer(async () => {
    await evaluate(app.client, async () => {
      await window.__sessionArchivePressure?.dispose();
    }, { awaitPromise: true, timeoutMs: 8_000 });
  });
  await evaluate(app.client, browserScript(async (origin, mounts, targetSessionId, targetTitle) => {
    if (window.__sessionArchivePressure) throw new Error("Pressure witness already installed");
    if (window.__archiveNetwork.mode !== "none" || window.__archiveNetwork.release) {
      throw new Error("Pressure witness refuses synthetic archive faults");
    }
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl || new URL(info.baseUrl).origin !== origin) {
      throw new Error("Pressure witness server identity changed");
    }
    const token = info.ownerToken ?? info.clientToken;
    if (!token) throw new Error("Pressure renderer credential unavailable");
    const delegate = window.fetch;
    const requests: FetchMetadata[] = [];
    const streams: StreamMetadata[] = [];
    const controllers: AbortController[] = [];
    const tasks: Promise<void>[] = [];
    let phase: Phase = "control";
    let released = false;
    let expired = false;
    let started = false;
    let ticks = 0;
    let frames = 0;
    let maxTickGapMs = 0;
    let lastTick = performance.now();
    let frame = 0;
    let expiry = 0;
    let canarySequence = 0;
    let releasePromise: Promise<void> | null = null;
    const ui: UiMeasurement = {
      trustedClick: false, clickedAt: null, failureMs: null, timeoutDescription: false,
      successMs: null, ticks: 0, frames: 0, maxTickGapMs: 0,
    };
    const reason = (error: unknown): Reason => {
      const exception = error instanceof Error || error instanceof DOMException ? error : null;
      const name = exception ? exception.name : typeof error;
      const message = exception ? exception.message : typeof error === "string" ? error : "";
      return {
        name: ["Error", "AbortError", "TimeoutError", "TypeError"].includes(name) ? name : "redacted",
        message: ["Request timed out.", "signal timed out", "The operation was aborted.",
          "This operation was aborted", "The user aborted a request.", "Failed to fetch", "fixture pressure released",
          "The operation was aborted due to timeout"].includes(message) ? message : "redacted",
      };
    };
    const observedFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      if (url.origin !== origin || !mounts.some(mount => url.pathname.startsWith(`${mount}/`))) return delegate(input, init);
      const key = url.searchParams.get("archive_pressure");
      const entry: FetchMetadata = {
        sequence: requests.length, phase,
        method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
        path: url.pathname, fixtureKey: key && /^(stream|canary)-\d+$/.test(key) ? key : null,
        elapsedMs: null, status: null, abortReason: null, error: null,
      };
      requests.push(entry);
      const start = performance.now();
      const signal = init?.signal === undefined ? (input instanceof Request ? input.signal : undefined) : init.signal;
      const aborted = () => { entry.abortReason = reason(signal?.reason); entry.elapsedMs = performance.now() - start; };
      if (signal?.aborted) aborted();
      else signal?.addEventListener("abort", aborted, { once: true });
      try {
        const response = await delegate(input, init);
        entry.status = response.status;
        return response;
      } catch (error) {
        entry.error = reason(error);
        throw error;
      } finally {
        entry.elapsedMs = performance.now() - start;
        signal?.removeEventListener("abort", aborted);
      }
    };
    const sampleToast = () => {
      if (ui.clickedAt === null) return;
      for (const toast of document.querySelectorAll<HTMLElement>("[data-sonner-toast]")) {
        if (!toast.getClientRects().length) continue;
        const text = toast.textContent ?? "";
        if (text.includes("Couldn't archive session")) {
          ui.failureMs ??= performance.now() - ui.clickedAt;
          ui.timeoutDescription ||= text.includes("Request timed out.");
        }
        if (text.includes(`Session archived: ${targetTitle}`)) ui.successMs ??= performance.now() - ui.clickedAt;
      }
    };
    const capture = (event: MouseEvent) => {
      if (phase !== "sidebar" || ui.clickedAt !== null || !event.isTrusted || !(event.target instanceof Element)
        || !event.target.closest(`[data-testid="session-archive-${targetSessionId}"]`)) return;
      ui.trustedClick = true;
      ui.clickedAt = performance.now();
      lastTick = performance.now();
    };
    const observer = new MutationObserver(sampleToast);
    const interval = window.setInterval(() => {
      const now = performance.now();
      const gap = now - lastTick;
      ticks += 1;
      maxTickGapMs = Math.max(maxTickGapMs, gap);
      lastTick = now;
      if (ui.clickedAt !== null && ui.failureMs === null && ui.successMs === null) {
        ui.ticks += 1;
        ui.maxTickGapMs = Math.max(ui.maxTickGapMs, gap);
      }
      sampleToast();
    }, 50);
    const paint = () => {
      frames += 1;
      if (ui.clickedAt !== null && ui.failureMs === null && ui.successMs === null) ui.frames += 1;
      frame = requestAnimationFrame(paint);
    };
    const release = () => {
      if (releasePromise) return releasePromise;
      released = true;
      clearTimeout(expiry);
      for (const controller of controllers) controller.abort(new Error("fixture pressure released"));
      releasePromise = (async () => {
        let timer = 0;
        try {
          await Promise.race([
            Promise.all(tasks),
            new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error("Injected SSE cleanup timed out")), 5_000); }),
          ]);
        } finally { clearTimeout(timer); }
      })();
      return releasePromise;
    };
    window.__sessionArchivePressure = {
      read: () => ({
        phase, streams: streams.map(stream => ({ ...stream })), requests: requests.map(request => ({ ...request })),
        released, expired, ticks, frames, maxTickGapMs, ui: { ...ui }, hash: location.hash,
        activeRows: [...document.querySelectorAll<HTMLElement>("[data-sidebar-workspace-id] [data-sidebar-session-id]")]
          .map(row => row.dataset.sidebarSessionId ?? ""),
      }),
      phase(value) { phase = value; },
      start() {
        if (started || released) throw new Error("Pressure streams may only start once");
        started = true;
        ticks = 0;
        frames = 0;
        maxTickGapMs = 0;
        lastTick = performance.now();
        expiry = window.setTimeout(() => { expired = true; void release().catch(() => undefined); }, 90_000);
        for (let index = 0; index < 8; index += 1) {
          const controller = new AbortController();
          controllers.push(controller);
          const stream: StreamMetadata = {
            key: `stream-${index}`, path: `${mounts[index % mounts.length]}/event`,
            status: null, contentType: null, chunks: 0, established: false, closed: false, error: null,
          };
          streams.push(stream);
          tasks.push((async () => {
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
            try {
              const response = await window.fetch(`${origin}${stream.path}?archive_pressure=${stream.key}`, {
                headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
                cache: "no-store", signal: controller.signal,
              });
              stream.status = response.status;
              stream.contentType = response.headers.get("content-type")?.split(";")[0].trim() ?? null;
              if (!response.ok || stream.contentType !== "text/event-stream" || !response.body) {
                await response.body?.cancel();
                throw new Error("SSE fixture endpoint did not establish a stream");
              }
              reader = response.body.getReader();
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                if (chunk.value.byteLength > 0) { stream.chunks += 1; stream.established = true; }
              }
            } catch (error) {
              if (!controller.signal.aborted) stream.error = reason(error);
            } finally { reader?.releaseLock(); stream.closed = true; }
          })());
        }
      },
      async canary() {
        const key = `canary-${++canarySequence}`;
        let bodyComplete = false;
        try {
          const response = await window.fetch(`${origin}${mounts[0]}/session/status?archive_pressure=${key}`, {
            headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(2_000),
          });
          await response.arrayBuffer();
          bodyComplete = true;
        } catch {}
        const entry = requests.find(request => request.fixtureKey === key);
        if (!entry) throw new Error("Canary did not traverse the renderer fetch observer");
        return { ...entry, bodyComplete };
      },
      release,
      async dispose() {
        try { await release(); }
        finally {
          clearInterval(interval);
          clearTimeout(expiry);
          cancelAnimationFrame(frame);
          observer.disconnect();
          document.removeEventListener("click", capture, true);
          window.fetch = delegate;
          delete window.__sessionArchivePressure;
        }
      },
    };
    window.fetch = observedFetch;
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    document.addEventListener("click", capture, true);
    frame = requestAnimationFrame(paint);
  }, [baseUrl.origin, mounts, a2.sessionId, a2.title]), { awaitPromise: true, timeoutMs: 5_000 });

  const get = async (path: string): Promise<unknown> => {
    try {
      const response = await fetch(`${baseUrl.origin}${path}`, {
        method: "GET", headers: { Authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(5_000), redirect: "error",
      });
      if (response.status !== 200) throw new Error("Non-success fixture readback");
      return await response.json();
    } catch { throw new Error(`Runner-side fixture readback failed: GET ${path}`); }
  };
  const readEngine = async () => {
    const startedAt = performance.now();
    const statuses = await Promise.all(workspaceIds.map(async workspaceId => {
      const path = `${mount(workspaceId)}/session/status`;
      const start = performance.now();
      const data = await get(path);
      if (!isRecord(data)) throw new Error("Malformed fixture status response");
      return { workspaceId, data, path, elapsedMs: performance.now() - start };
    }));
    const sessions = await Promise.all(targets.map(async target => {
      const path = `${mount(target.workspaceId)}/session/${encodeURIComponent(target.sessionId)}`;
      const [session, messages] = await Promise.all([get(path), get(`${path}/message?limit=20`)]);
      if (!isRecord(session) || session.id !== target.sessionId || !isRecord(session.time) || !Array.isArray(messages)) {
        throw new Error("Malformed fixture session readback");
      }
      const archivedAt = session.time.archived ?? 0;
      if (typeof archivedAt !== "number") throw new Error("Malformed fixture archive timestamp");
      const owner = statuses.find(status => status.workspaceId === target.workspaceId);
      if (!owner) throw new Error("Missing fixture status owner");
      const status = owner.data[target.sessionId];
      if (status !== undefined && (!isRecord(status) || typeof status.type !== "string")) throw new Error("Malformed fixture session status");
      return { workspaceId: target.workspaceId, sessionId: target.sessionId, archivedAt,
        idle: status === undefined || (isRecord(status) && status.type === "idle"), messageCount: messages.length };
    }));
    return { transport: "runner-fetch", elapsedMs: performance.now() - startedAt, sessions,
      statusReads: statuses.map(({ workspaceId, path, elapsedMs }) => ({ workspaceId, path, elapsedMs, status: 200 })) };
  };
  const lifetime = resources.move();
  return {
    app, target: a2, selected: a1, targets, rootTargets: [a1, a2, b1, faultCandidate], workspaceIds, targetPath,
    ownershipPaths: [targetPath, `${mount(a2.workspaceId)}/path`],
    eventPaths: mounts.map(value => `${value}/event`),
    readEngine,
    mainRequests: fixture.mainRequests,
    mainFetchControl: () => evaluate(app.client, browserScript(async path => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      const started = performance.now();
      try {
        const response = await window.__OPENWORK_ELECTRON__.invokeDesktop("__fetch", `${info.baseUrl}${path}`, {
          headers: { Authorization: `Bearer ${info.ownerToken ?? info.clientToken}` }, timeoutMs: 2_000,
        });
        return { path, status: response.status, elapsedMs: performance.now() - started, completed: true };
      } catch {
        return { path, status: null, elapsedMs: performance.now() - started, completed: false };
      }
    }, [`${mount(a2.workspaceId)}/session/status`]), { awaitPromise: true, timeoutMs: 4_000 }),
    renderer: () => evaluate(app.client, () => {
      if (!window.__sessionArchivePressure) throw new Error("Pressure renderer observer missing");
      return window.__sessionArchivePressure.read();
    }, { timeoutMs: 3_000 }),
    network: () => network.read(),
    async phase(value: Phase) {
      network.phase(value);
      await evaluate(app.client, browserScript(value => {
        if (!window.__sessionArchivePressure) throw new Error("Pressure renderer observer missing");
        window.__sessionArchivePressure.phase(value);
      }, [value]), { timeoutMs: 3_000 });
    },
    startPressure: () => evaluate(app.client, () => {
      if (!window.__sessionArchivePressure) throw new Error("Pressure renderer observer missing");
      window.__sessionArchivePressure.start();
    }, { timeoutMs: 3_000 }),
    canary: () => evaluate(app.client, async () => {
      if (!window.__sessionArchivePressure) throw new Error("Pressure renderer observer missing");
      return window.__sessionArchivePressure.canary();
    }, { awaitPromise: true, timeoutMs: 4_000 }),
    releasePressure: () => evaluate(app.client, async () => {
      if (!window.__sessionArchivePressure) throw new Error("Pressure renderer observer missing");
      await window.__sessionArchivePressure.release();
      return window.__sessionArchivePressure.read();
    }, { awaitPromise: true, timeoutMs: 8_000 }),
    async [Symbol.asyncDispose]() { await lifetime.disposeAsync(); },
  };
}
