import { browserScript, evaluate } from "@openwork/cdp";
import { SkipError, type Place, type Seed } from "@openwork/env";
import { createHash } from "node:crypto";
import { archiveActiveSessions } from "./session-shell.ts";

export const NO_WINDOW_ERROR = "No OpenWork window is connected to this server. Open the OpenWork app or its web tab and try again.";

type MailboxState = {
  armed: boolean;
  interceptedAt: number | null;
  heldAt: number | null;
  releasedAt: number | null;
  expired: boolean;
  holdCount: number;
  pollsStarted: number;
  pollsCompleted: number;
  pollsReturned: number;
  pollsInFlight: number;
  lastPollStartedAt: number | null;
  lastPollCompletedAt: number | null;
  pollsStartedAtHold: number;
  pollsCompletedAtHold: number;
  heldItems: number | null;
  deliveredContexts: number;
  deliveredOther: number;
  replyPosts: number;
  engineWriteAttempts: number;
  ticks: number;
  frames: number;
  maxTickGapMs: number;
  failure: string | null;
};

declare global {
  interface Window {
    __sessionMailboxLiveness?: {
      arm(): void;
      release(): void;
      dispose(): void;
      read(): MailboxState & {
        now: number;
        held: boolean;
        heldElapsedMs: number;
        heldMonotonicMs: number;
        hash: string;
        timeOrigin: number;
        documentReady: boolean;
        composerVisible: boolean;
        activeRows: string[];
      };
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function sessionMailboxLiveness(seed: Seed, context: { place: Place }) {
  if (context.place.kind !== "local") {
    throw new SkipError("Mailbox liveness requires runner-reachable fixture loopback; use --local --engine v1 --surface electron");
  }
  if (process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim()) {
    throw new SkipError("Mailbox liveness requires source-built Electron; unset OPENWORK_EVAL_ELECTRON_BINARY");
  }
  await using resources = new AsyncDisposableStack();
  const fixture = resources.use(await archiveActiveSessions(seed, context));
  const { app, a1, a2, b1, child, faultCandidate, workspaceA, workspaceB } = fixture;
  if (app.handle.hostKind !== "local" || app.handle.kind !== "electron" || !app.handle.pid || !app.handle.profileDir) {
    throw new Error("Mailbox liveness requires a spawned isolated local Electron profile");
  }
  const targets = [a1, a2, b1, child, faultCandidate];
  const workspaceIds = [workspaceA.workspaceId, workspaceB.workspaceId];
  const mount = (workspaceId: string) => `/workspace/${encodeURIComponent(workspaceId)}/opencode`;
  const server = await evaluate(app.client, async () => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl) throw new Error("Mailbox fixture server unavailable");
    return { baseUrl: info.baseUrl, token: info.ownerToken ?? info.clientToken };
  }, { awaitPromise: true, timeoutMs: 5_000 });
  if (!server.token) throw new Error("Mailbox fixture credential unavailable");
  resources.defer(() => { server.token = ""; });
  const base = new URL(server.baseUrl);
  if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
    || base.pathname !== "/" || base.search || base.hash || base.username || base.password) {
    throw new Error("Mailbox witness only accepts its isolated HTTP loopback server");
  }
  const disposeObserver = () => evaluate(app.client, () => {
    window.__sessionMailboxLiveness?.dispose();
    return { observerRemoved: window.__sessionMailboxLiveness === undefined };
  }, { timeoutMs: 3_000 });
  resources.defer(async () => {
    try { await disposeObserver(); }
    finally {
      await evaluate(app.client, () => { window.fetch = window.__archiveNetwork.original; }, { timeoutMs: 3_000 });
    }
  });
  await evaluate(app.client, browserScript(origin => {
    if (window.__sessionMailboxLiveness) throw new Error("Mailbox observer already installed");
    if (window.__archiveNetwork.mode !== "none" || window.__archiveNetwork.release) {
      throw new Error("Mailbox witness refuses archive faults");
    }
    const delegate = window.fetch;
    const state: MailboxState = {
      armed: false, interceptedAt: null, heldAt: null, releasedAt: null, expired: false, holdCount: 0,
      pollsStarted: 0, pollsCompleted: 0, pollsReturned: 0, pollsInFlight: 0,
      lastPollStartedAt: null, lastPollCompletedAt: null, pollsStartedAtHold: 0, pollsCompletedAtHold: 0,
      heldItems: null, deliveredContexts: 0, deliveredOther: 0, replyPosts: 0, engineWriteAttempts: 0,
      ticks: 0, frames: 0, maxTickGapMs: 0, failure: null,
    };
    let releaseBody: (() => void) | null = null;
    let expiry = 0;
    let frame = 0;
    let disposed = false;
    let heldMonotonicAt = 0;
    let lastTick = performance.now();
    const interval = window.setInterval(() => {
      const now = performance.now();
      state.ticks += 1;
      state.maxTickGapMs = Math.max(state.maxTickGapMs, now - lastTick);
      lastTick = now;
    }, 50);
    const paint = () => { state.frames += 1; frame = requestAnimationFrame(paint); };
    const release = () => {
      state.armed = false;
      state.releasedAt ??= Date.now();
      clearTimeout(expiry);
      expiry = 0;
      releaseBody?.();
      releaseBody = null;
    };
    const observedFetch: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (url.origin !== origin) return delegate(input, init);
      if (/^\/(workspace|w)\/[^/]+\/opencode\//.test(url.pathname) && !["GET", "HEAD", "OPTIONS"].includes(method)) {
        state.engineWriteAttempts += 1;
      }
      if (method === "POST" && /^\/experimental\/ui-control\/[^/]+\/reply$/.test(url.pathname)) state.replyPosts += 1;
      if (method !== "GET" || url.pathname !== "/experimental/ui-control/pending") return delegate(input, init);
      const selected = state.armed;
      const startedAt = Date.now();
      if (selected) {
        state.armed = false;
        state.holdCount += 1;
        state.interceptedAt = startedAt;
      }
      state.pollsStarted += 1;
      state.pollsInFlight += 1;
      state.lastPollStartedAt = startedAt;
      try {
        const response = await delegate(input, init);
        const readText = response.text.bind(response);
        response.text = async () => {
          try {
            const text = await readText();
            const body: unknown = JSON.parse(text);
            if (!response.ok || !body || typeof body !== "object" || !("items" in body) || !Array.isArray(body.items)) {
              throw new Error("Malformed real mailbox poll response");
            }
            const contexts = body.items.filter((item: unknown) => item !== null && typeof item === "object"
              && "kind" in item && item.kind === "context").length;
            state.pollsCompleted += 1;
            state.lastPollCompletedAt = Date.now();
            if (selected && !disposed && state.releasedAt === null) {
              state.heldAt = Date.now();
              heldMonotonicAt = performance.now();
              state.heldItems = body.items.length;
              state.pollsStartedAtHold = state.pollsStarted;
              state.pollsCompletedAtHold = state.pollsCompleted;
              state.maxTickGapMs = 0;
              lastTick = performance.now();
              await new Promise<void>(resolve => {
                releaseBody = resolve;
                expiry = window.setTimeout(() => { state.expired = true; release(); }, 45_000);
              });
            }
            state.deliveredContexts += contexts;
            state.deliveredOther += body.items.length - contexts;
            state.pollsReturned += 1;
            return text;
          } catch {
            state.failure = "Mailbox response-body observation failed";
            throw new Error(state.failure);
          }
        };
        return response;
      } catch {
        state.failure = "Real mailbox fetch failed";
        throw new Error(state.failure);
      } finally { state.pollsInFlight -= 1; }
    };
    window.__sessionMailboxLiveness = {
      arm() {
        if (disposed || state.armed || state.holdCount || state.releasedAt !== null || state.pollsReturned < 1) {
          throw new Error("Hold requires a completed real renderer poll and may only be armed once");
        }
        state.armed = true;
      },
      release,
      read: () => ({
        ...state, now: Date.now(), held: releaseBody !== null,
        heldElapsedMs: state.heldAt === null ? 0 : (state.releasedAt ?? Date.now()) - state.heldAt,
        heldMonotonicMs: state.heldAt === null ? 0 : performance.now() - heldMonotonicAt,
        hash: location.hash, timeOrigin: performance.timeOrigin, documentReady: document.readyState === "complete",
        composerVisible: [...document.querySelectorAll<HTMLElement>('[data-lexical-editor="true"][contenteditable="true"]')]
          .some(node => node.getClientRects().length > 0),
        activeRows: [...document.querySelectorAll<HTMLElement>("[data-sidebar-workspace-id] [data-sidebar-session-id]")]
          .filter(node => node.getClientRects().length > 0).map(node => node.dataset.sidebarSessionId ?? "").sort(),
      }),
      dispose() {
        if (disposed) return;
        disposed = true;
        release();
        clearInterval(interval);
        cancelAnimationFrame(frame);
        window.fetch = delegate;
        delete window.__sessionMailboxLiveness;
      },
    };
    window.fetch = observedFetch;
    frame = requestAnimationFrame(paint);
  }, [base.origin]), { timeoutMs: 5_000 });

  const request = async (path: string, method: "GET" | "POST", timeoutMs: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = performance.now();
    try {
      const response = await fetch(`${base.origin}${path}`, {
        method, headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ kind: "context" }) } : {}),
        redirect: "error", signal: controller.signal,
      });
      const body: unknown = await response.json();
      return { status: response.status, elapsedMs: performance.now() - startedAt, body };
    } catch { throw new Error(`Runner fixture ${method} ${path} did not complete; no automatic retry`); }
    finally { clearTimeout(timer); }
  };
  const get = async (path: string) => {
    const response = await request(path, "GET", 5_000);
    if (response.status !== 200) throw new Error(`Runner fixture GET ${path} returned HTTP ${response.status}`);
    return response.body;
  };
  let contextInFlight = false;
  let contextUncertain = false;
  let contextRequests = 0;
  const readContext = async () => {
    if (contextInFlight || contextUncertain) throw new Error("Previous context request has no confirmed completion; do not retry");
    contextInFlight = true;
    contextRequests += 1;
    try {
      const result = await request("/experimental/ui-control/request", "POST", 8_000);
      const body = result.body;
      if (result.status !== 200 || !isRecord(body)) throw new Error("Unexpected mailbox context response");
      if (body.ok === false && body.error === NO_WINDOW_ERROR && Object.keys(body).sort().join(",") === "error,ok") {
        return { status: result.status, elapsedMs: result.elapsedMs, body: { ok: false, error: NO_WINDOW_ERROR } };
      }
      if (body.ok !== true || !isRecord(body.context) || body.context.schemaVersion !== 1
        || typeof body.context.revision !== "number" || !isRecord(body.context.screen)
        || body.context.screen.kind !== "conversation" || typeof body.context.screen.route !== "string"
        || body.context.screen.workspaceId !== workspaceA.workspaceId) throw new Error("Actual renderer context was not a fixture conversation");
      return { status: result.status, elapsedMs: result.elapsedMs, body: { ok: true, context: {
        schemaVersion: body.context.schemaVersion, revision: body.context.revision,
        screen: { kind: body.context.screen.kind, route: body.context.screen.route, workspaceId: body.context.screen.workspaceId },
      } } };
    } catch {
      contextUncertain = true;
      throw new Error("Context read failed or had an unexpected result; do not retry");
    } finally { contextInFlight = false; }
  };
  const readEngine = async () => {
    const inventories = await Promise.all(workspaceIds.map(async workspaceId => {
      const [list, statuses] = await Promise.all([get(`${mount(workspaceId)}/session?limit=200`), get(`${mount(workspaceId)}/session/status`)]);
      if (!Array.isArray(list) || !isRecord(statuses)) throw new Error("Malformed fixture engine inventory");
      const ids = list.map(entry => {
        if (!isRecord(entry) || typeof entry.id !== "string") throw new Error("Malformed fixture inventory identity");
        return entry.id;
      }).sort();
      return { workspaceId, ids, statuses };
    }));
    const sessions = await Promise.all(targets.map(async target => {
      const path = `${mount(target.workspaceId)}/session/${encodeURIComponent(target.sessionId)}`;
      const [session, messages, todos] = await Promise.all([get(path), get(`${path}/message?limit=20`), get(`${path}/todo`)]);
      if (!isRecord(session) || session.id !== target.sessionId || !isRecord(session.time) || !Array.isArray(messages) || !Array.isArray(todos)) {
        throw new Error("Malformed fixture session readback");
      }
      const archivedAt = session.time.archived ?? 0;
      if (typeof archivedAt !== "number") throw new Error("Malformed fixture archive timestamp");
      const owner = inventories.find(entry => entry.workspaceId === target.workspaceId);
      if (!owner) throw new Error("Missing fixture workspace owner");
      const status = owner.statuses[target.sessionId];
      return {
        workspaceId: target.workspaceId, sessionId: target.sessionId, archivedAt,
        idle: status === undefined || (isRecord(status) && status.type === "idle"),
        messageCount: messages.length, todoCount: todos.length,
        digest: createHash("sha256").update(JSON.stringify({ session, messages, todos })).digest("hex"),
      };
    }));
    return { inventories: inventories.map(({ workspaceId, ids }) => ({ workspaceId, ids })), sessions };
  };
  const lifetime = resources.move();
  return {
    app, targets, rootTargets: [a1, a2, b1, faultCandidate],
    route: `#/workspace/${workspaceA.workspaceId}/session`, workspaceId: workspaceA.workspaceId,
    readContext, readEngine, disposeObserver,
    rendererHealth: () => evaluate(app.client, browserScript(async origin => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 2_000);
      const startedAt = performance.now();
      try {
        const response = await window.fetch(`${origin}/health`, { signal: controller.signal, cache: "no-store", redirect: "error" });
        await response.arrayBuffer();
        return { transport: "renderer-fetch", path: "/health", status: response.status, elapsedMs: performance.now() - startedAt };
      } catch { throw new Error("Unrelated renderer health fetch did not complete while the mailbox body was held"); }
      finally { clearTimeout(timer); }
    }, [base.origin]), { awaitPromise: true, timeoutMs: 3_000 }),
    contextRequests: () => contextRequests,
    health: async () => {
      const result = await request("/health", "GET", 2_000);
      return { transport: "runner-fetch", path: "/health", status: result.status, elapsedMs: result.elapsedMs };
    },
    renderer: () => evaluate(app.client, () => {
      if (!window.__sessionMailboxLiveness) throw new Error("Mailbox observer missing");
      return window.__sessionMailboxLiveness.read();
    }, { timeoutMs: 3_000 }),
    arm: () => evaluate(app.client, () => {
      if (!window.__sessionMailboxLiveness) throw new Error("Mailbox observer missing");
      window.__sessionMailboxLiveness.arm();
    }, { timeoutMs: 3_000 }),
    release: () => evaluate(app.client, () => {
      if (!window.__sessionMailboxLiveness) throw new Error("Mailbox observer missing");
      window.__sessionMailboxLiveness.release();
      return window.__sessionMailboxLiveness.read();
    }, { timeoutMs: 3_000 }),
    async [Symbol.asyncDispose]() { await lifetime.disposeAsync(); },
  };
}
