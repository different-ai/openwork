import { allocateFreePort, browserScript, clickAt, evaluate, hoverAt, reload, type Point, type Surface, typeText, waitForLocated } from "@openwork/cdp";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { engineSessionProbe, observeSidebarExpansion, readAvailableModels, selectModel, waitFor } from "@openwork/behaviors";
import { resolveEvalEngine, SkipError } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import { daytonaSandbox, defaultDaytonaExec, desktop as launchDesktop, execInSandbox, startMockOnSandbox } from "@openwork/hosts";
import { startMockMcp } from "@openwork/labs";

const stormProviderId = "active-session-storm-mock";
const stormModelId = "mock-agent-workload-model";

export interface ShellSession {
  sessionId: string;
  title: string;
}

export interface ShellWorkspace {
  workspaceId: string;
  route: string;
}

export interface StormPlan extends ShellSession, ShellWorkspace {
  index: number;
  path: string;
  filePath: string;
  marker: string;
  slowMarker: string;
  easyMarker: string;
  finalReply: string;
}

type InstantMetricKind = "new-task" | "user-row";
type InstantBoundaryKind = "creation" | "prompt";
type InstantBoundaryStage = "request" | "response";

type InstantRendererState = {
  kind: InstantMetricKind;
  started: boolean;
  trusted: boolean;
  elapsedMs: number | null;
  frames: number;
  mutations: number;
  consecutiveFrames: number;
  expired: boolean;
};

declare global {
  interface Window {
    __instantSendMetric?: { state: InstantRendererState; stop(): void };
  }
}

function instantDeferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Renderer-only timing: trusted input capture through two consecutive animation-frame samples. */
async function observeInstantRenderer(
  seed: Seed,
  app: Surface,
  workspaceId: string,
  kind: InstantMetricKind,
  marker = "",
) {
  await seed.evalIn(app, browserScript((workspaceId, kind, marker) => {
    if (window.__instantSendMetric) throw new Error("An instant-send renderer observer is already active");
    const state: InstantRendererState = {
      kind, started: false, trusted: false, elapsedMs: null, frames: 0,
      mutations: 0, consecutiveFrames: 0, expired: false,
    };
    let startedAt = 0;
    let frame = 0;

    const visibleInViewport = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
    };
    const surfaceRoot = () => {
      if ((localStorage.getItem("openwork.react.activeWorkspace") ?? "") !== workspaceId) return null;
      const sessionlessRoute = `#/workspace/${workspaceId}/session`;
      if (location.hash === sessionlessRoute) {
        const heading = [...document.querySelectorAll<HTMLElement>("h2")]
          .find((candidate) => candidate.textContent?.trim() === "What do you need done?" && visibleInViewport(candidate));
        const headingMain = heading?.closest<HTMLElement>("main") ?? null;
        const main = headingMain && visibleInViewport(headingMain) ? headingMain
          : [...document.querySelectorAll<HTMLElement>("main")].filter(visibleInViewport)
              .find((candidate) => [...candidate.querySelectorAll<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"], [data-message-role]')]
                .some(visibleInViewport)) ?? null;
        const persistedSurfaceVisible = [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")]
          .some(visibleInViewport);
        return main && !persistedSurfaceVisible
          ? { kind: "new-task", root: main, headingVisible: Boolean(heading && main.contains(heading)) }
          : null;
      }
      const persistedPrefix = `#/workspace/${workspaceId}/session/`;
      if (!location.hash.startsWith(persistedPrefix)) return null;
      const sessionId = location.hash.slice(persistedPrefix.length);
      if (!sessionId.startsWith("ses_") || /[/?#]/.test(sessionId)) return null;
      const pane = [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"]')]
        .find(visibleInViewport);
      const surface = [...(pane?.querySelectorAll<HTMLElement>("[data-session-surface-id]") ?? [])]
        .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId && visibleInViewport(candidate));
      return pane && surface ? { kind: "persisted", root: pane, headingVisible: false } : null;
    };
    const editor = () => surfaceRoot()?.root.querySelector<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"]') ?? null;
    const ready = () => {
      const surface = surfaceRoot();
      if (!surface) return false;
      if (kind === "new-task") {
        if (surface.kind !== "new-task" || !surface.headingVisible) return false;
        const node = editor();
        if (!node || !node.isContentEditable || !visibleInViewport(node)
          || !(document.activeElement === node || node.contains(document.activeElement))) return false;
        const rect = node.getBoundingClientRect();
        const x = Math.min(innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
        const y = Math.min(innerHeight - 1, Math.max(0, rect.top + Math.min(rect.height / 2, 24)));
        const hit = document.elementFromPoint(x, y);
        return hit instanceof Node && node.contains(hit);
      }
      const composer = editor();
      return [...surface.root.querySelectorAll<HTMLElement>('[data-message-role="user"]')]
        .some((row) => visibleInViewport(row) && row.innerText.includes(marker)
          && !(composer?.contains(row) || row.contains(composer)));
    };
    const sample = () => {
      if (!state.started || state.elapsedMs !== null) return;
      state.frames += 1;
      state.consecutiveFrames = ready() ? state.consecutiveFrames + 1 : 0;
      if (state.consecutiveFrames >= 2) state.elapsedMs = performance.now() - startedAt;
    };
    const paint = () => { sample(); frame = requestAnimationFrame(paint); };
    const capture = (event: Event) => {
      if (state.started || !event.isTrusted) return;
      if (kind === "new-task") {
        const target = event.target;
        if (event.type !== "click" || !(target instanceof Element)
          || !target.closest(`[data-sidebar-workspace-id="${workspaceId}"] [data-workspace-new-task]`)) return;
      } else {
        if (!(event instanceof KeyboardEvent) || event.key !== "Enter") return;
        const node = editor();
        if (!node || !(event.target instanceof Node) || !(event.target === node || node.contains(event.target))) return;
      }
      state.started = true;
      state.trusted = true;
      startedAt = performance.now();
    };
    const eventName = kind === "new-task" ? "click" : "keydown";
    window.addEventListener(eventName, capture, true);
    const observer = new MutationObserver(() => { state.mutations += 1; });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
    frame = requestAnimationFrame(paint);
    const timer = setTimeout(() => { state.expired = true; stop(); }, 10_000);
    function stop() {
      clearTimeout(timer);
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener(eventName, capture, true);
    }
    window.__instantSendMetric = { state, stop };
  }, [workspaceId, kind, marker]));
  let disposed = false;
  return {
    async read(): Promise<InstantRendererState> {
      const value = await seed.evalIn(app, () => window.__instantSendMetric?.state ?? null);
      if (!isRecord(value) || (value.kind !== "new-task" && value.kind !== "user-row")
        || typeof value.started !== "boolean" || typeof value.trusted !== "boolean"
        || !(value.elapsedMs === null || typeof value.elapsedMs === "number")
        || typeof value.frames !== "number" || typeof value.mutations !== "number"
        || typeof value.consecutiveFrames !== "number" || typeof value.expired !== "boolean") {
        throw new Error(`Instant renderer timing state was malformed: ${JSON.stringify(value)}`);
      }
      return {
        kind: value.kind,
        started: value.started,
        trusted: value.trusted,
        elapsedMs: value.elapsedMs,
        frames: value.frames,
        mutations: value.mutations,
        consecutiveFrames: value.consecutiveFrames,
        expired: value.expired,
      };
    },
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      await seed.evalIn(app, () => {
        window.__instantSendMetric?.stop();
        delete window.__instantSendMetric;
      });
    },
  };
}

type InstantGateState = {
  kind: InstantBoundaryKind;
  stage: InstantBoundaryStage;
  requestIds: Set<string>;
  heldAt: number | null;
  released: boolean;
  failed: boolean;
  expired: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

const INSTANT_BOUNDARY_REJECTION_MESSAGE = "The request was rejected before admission.";

/** Disposable CDP Fetch gate. It reports only compact counts and never request headers or bodies. */
async function instantBoundaryController(app: Surface, workspaceId: string) {
  const endpoint = app.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Instant-send boundary observer requires the desktop CDP endpoint");
  const runtime = await evaluate(app.client, async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    return {
      baseUrl: info?.running && info.baseUrl ? String(info.baseUrl) : "",
      rendererOrigin: window.location.origin,
    };
  }, { awaitPromise: true });
  const { baseUrl, rendererOrigin } = runtime;
  if (typeof baseUrl !== "string" || !baseUrl) throw new Error("OpenWork server URL was unavailable to the boundary observer");
  const origin = new URL(baseUrl).origin;
  const encodedWorkspaceId = encodeURIComponent(workspaceId);
  const sessionBases = ["workspace", "w"].map((mount) => `/${mount}/${encodedWorkspaceId}/opencode/session`);
  const fetchPatterns = sessionBases.map((path) => ({ urlPattern: `${origin}${path}*`, requestStage: "Request" }));
  const socket = new WebSocket(endpoint);
  const ready = instantDeferred();
  const commands = new Map<number, ReturnType<typeof instantDeferred>>();
  const gates: InstantGateState[] = [];
  const counts = { creation: 0, prompt: 0 };
  let nextId = 1;
  let disposed = false;
  let fetchEnabled = false;
  let cleanupPromise: Promise<void> | null = null;
  let failure: Error | undefined;

  const command = async (method: string, params: Record<string, unknown> = {}) => {
    const id = nextId++;
    const result = instantDeferred();
    commands.set(id, result);
    const timer = setTimeout(() => result.reject(new Error(`Instant-send boundary command timed out: ${method}`)), 15_000);
    try {
      socket.send(JSON.stringify({ id, method, params }));
      await result.promise;
    } finally {
      clearTimeout(timer);
      commands.delete(id);
    }
  };
  const loseConnection = () => {
    if (disposed) return;
    failure = new Error("Instant-send boundary observer lost its CDP connection");
    ready.reject(failure);
    for (const result of commands.values()) result.reject(failure);
  };
  const classify = (method: string, url: string): InstantBoundaryKind | null => {
    if (method.toUpperCase() !== "POST") return null;
    const path = new URL(url).pathname;
    if (sessionBases.includes(path)) return "creation";
    return sessionBases.some((base) => path.startsWith(`${base}/`) && path.endsWith("/prompt_async")) ? "prompt" : null;
  };
  const finishGate = async (gate: InstantGateState, fail: boolean) => {
    if (gate.released) return;
    gate.released = true;
    gate.failed = fail;
    if (gate.timer) clearTimeout(gate.timer);
    gate.timer = null;
    const method = fail ? "Fetch.fulfillRequest" : gate.stage === "response" ? "Fetch.continueResponse" : "Fetch.continueRequest";
    const interceptResponse = !fail && gate.stage === "request"
      && gates.some((candidate) => candidate.kind === gate.kind && candidate.stage === "response" && !candidate.released);
    await Promise.all([...gate.requestIds].map((requestId) => command(method, fail
      ? {
          requestId,
          responseCode: 400,
          responsePhrase: "Bad Request",
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
            { name: "Access-Control-Allow-Origin", value: rendererOrigin },
            { name: "Access-Control-Allow-Credentials", value: "true" },
            { name: "Vary", value: "Origin" },
          ],
          body: Buffer.from(JSON.stringify(INSTANT_BOUNDARY_REJECTION_MESSAGE), "utf8").toString("base64"),
        }
      : { requestId, ...(interceptResponse ? { interceptResponse: true } : {}) })));
  };

  socket.addEventListener("open", () => ready.resolve());
  socket.addEventListener("error", loseConnection);
  socket.addEventListener("close", loseConnection);
  socket.addEventListener("message", (event) => {
    const message: unknown = JSON.parse(String(event.data));
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const result = commands.get(message.id);
      if ("error" in message) result?.reject(new Error("Instant-send boundary CDP command failed"));
      else result?.resolve();
    }
    if (message.method !== "Fetch.requestPaused" || !isRecord(message.params)) return;
    const params = message.params;
    if (typeof params.requestId !== "string" || !isRecord(params.request)
      || typeof params.request.method !== "string" || typeof params.request.url !== "string") return;
    const stage: InstantBoundaryStage = typeof params.responseStatusCode === "number" || typeof params.responseErrorReason === "string"
      ? "response" : "request";
    const continueMethod = stage === "response" ? "Fetch.continueResponse" : "Fetch.continueRequest";
    const kind = classify(params.request.method, params.request.url);
    if (!kind) {
      void command(continueMethod, { requestId: params.requestId }).catch((error: Error) => { failure = error; });
      return;
    }
    if (stage === "request") counts[kind] += 1;
    const gate = gates.find((candidate) => candidate.kind === kind && candidate.stage === stage && !candidate.released);
    if (!gate) {
      const interceptResponse = stage === "request"
        && gates.some((candidate) => candidate.kind === kind && candidate.stage === "response" && !candidate.released);
      void command(continueMethod, {
        requestId: params.requestId,
        ...(interceptResponse ? { interceptResponse: true } : {}),
      }).catch((error: Error) => { failure = error; });
      return;
    }
    gate.requestIds.add(params.requestId);
    if (gate.heldAt === null) {
      gate.heldAt = performance.now();
      gate.timer = setTimeout(() => {
        gate.expired = true;
        void finishGate(gate, false).catch((error: Error) => { failure = error; });
      }, 30_000);
    }
  });
  const connectionTimer = setTimeout(() => ready.reject(new Error("Instant-send boundary observer could not connect")), 15_000);
  try {
    await ready.promise;
    await command("Network.enable");
    await command("Fetch.enable", { patterns: fetchPatterns });
    fetchEnabled = true;
  } catch (error) {
    disposed = true;
    socket.close();
    throw error;
  } finally {
    clearTimeout(connectionTimer);
  }

  const arm = (kind: InstantBoundaryKind, stage: InstantBoundaryStage) => {
    if (disposed) throw new Error("Instant-send boundary observer is disposed");
    const state: InstantGateState = {
      kind, stage, requestIds: new Set(), heldAt: null, released: false,
      failed: false, expired: false, timer: null,
    };
    gates.push(state);
    let gateDisposed = false;
    const read = () => {
      if (failure) throw failure;
      return {
        kind, stage, held: state.requestIds.size,
        elapsedMs: state.heldAt === null ? 0 : performance.now() - state.heldAt,
        released: state.released, failed: state.failed, expired: state.expired,
      };
    };
    return {
      read,
      release: () => finishGate(state, false),
      fail: () => finishGate(state, true),
      async [Symbol.asyncDispose]() {
        if (gateDisposed) return;
        gateDisposed = true;
        await finishGate(state, false);
      },
    };
  };
  return {
    holdNext: arm,
    read() {
      if (failure) throw failure;
      const activelyHeld = gates.filter((gate) => !gate.released && gate.requestIds.size > 0);
      return {
        creation: counts.creation,
        prompt: counts.prompt,
        enabled: fetchEnabled,
        activeGateCount: activelyHeld.length,
        activeHeldRequestCount: activelyHeld.reduce((total, gate) => total + gate.requestIds.size, 0),
      };
    },
    async suspend() {
      if (disposed) throw new Error("Instant-send boundary observer is disposed");
      if (failure) throw failure;
      const activelyHeld = gates.filter((gate) => !gate.released && gate.requestIds.size > 0);
      if (activelyHeld.length > 0) {
        throw new Error(`Instant-send boundary observer cannot suspend with ${activelyHeld.length} actively held gate(s)`);
      }
      if (!fetchEnabled) return;
      await command("Fetch.disable");
      fetchEnabled = false;
    },
    async resume() {
      if (disposed) throw new Error("Instant-send boundary observer is disposed");
      if (failure) throw failure;
      if (fetchEnabled) return;
      await command("Fetch.enable", { patterns: fetchPatterns });
      fetchEnabled = true;
    },
    async [Symbol.asyncDispose]() {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        if (disposed) return;
        try {
          for (const gate of gates) await finishGate(gate, false);
          if (fetchEnabled) await command("Fetch.disable");
        } finally {
          fetchEnabled = false;
          disposed = true;
          socket.close();
        }
      })();
      return cleanupPromise;
    },
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}/v1`;
}

function streamReply(response: ServerResponse, id: string, reply: string): void {
  const chunks = [
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function additionalWorkspace(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  path: string,
): Promise<ShellWorkspace> {
  const previous = await seed.evalIn(app, () => (localStorage.getItem("openwork.react.activeWorkspace") ?? ""));
  // TODO(primitive): seed.workspace should always create the requested additional workspace.
  const result = await seed.evalIn(app, browserScript((path) => window.__openworkControl.execute("workspace.create", { path }), [path]), { awaitPromise: true, timeoutMs: 120_000 });
  if (!isRecord(result) || result.ok !== true) throw new Error(`Could not create workspace ${path}: ${JSON.stringify(result)}`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const state = await seed.evalIn(app, () => (({
      workspaceId: localStorage.getItem("openwork.react.activeWorkspace") ?? "",
      route: window.location.hash,
      ready: Boolean(window.__openworkControl),
    })));
    if (isRecord(state)
      && typeof state.workspaceId === "string"
      && state.workspaceId
      && state.workspaceId !== previous
      && typeof state.route === "string"
      && state.ready === true) {
      return { workspaceId: state.workspaceId, route: state.route };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Workspace ${path} did not become active after creation.`);
}

async function configureWorkspaceProvider(
  seed: Seed,
  app: Awaited<ReturnType<Seed["desktop"]>>,
  workspaceIds: readonly string[],
  options: {
    providerId: string;
    modelId: string;
    modelName: string;
    baseUrl: string;
    smallModel?: string;
    allowTools?: boolean;
  },
): Promise<void> {
  // TODO(primitive): seed.configureWorkspaceProvider should configure and reload a workspace model without raw renderer evaluation.
  const result = await seed.evalIn(app, browserScript(async (workspaceIds, smallModel, allowTools, providerId, modelId, modelName, baseUrl, defaultModel) => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const root = String(info.baseUrl).replace(/\/+$/, "");
    const headers = {
      Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
      "Content-Type": "application/json",
    };
    const outcomes = [];
    for (const workspaceId of workspaceIds) {
      const opencode: { model: string; provider: Record<string, unknown>; small_model?: string; permission?: unknown } = {
        model: defaultModel,
        provider: {
          [providerId]: {
            npm: "@ai-sdk/openai-compatible",
            name: modelName,
            options: { baseURL: baseUrl, apiKey: "sk-eval-fixture" },
            models: { [modelId]: { name: modelName, tool_call: allowTools } },
          },
        },
      };
      if (smallModel) opencode.small_model = smallModel;
      if (allowTools) opencode.permission = { edit: "allow", write: "allow", read: "allow", bash: "allow" };
      const response = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        headers,
        body: JSON.stringify({ opencode }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        outcomes.push({ workspaceId, stage: "config", status: response.status, text: (await response.text()).slice(0, 300) });
        continue;
      }
      const reload = await fetch(root + "/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(60000),
      });
      outcomes.push({ workspaceId, stage: "reload", status: reload.status, text: reload.ok ? "ok" : (await reload.text()).slice(0, 300) });
    }
    const raw = localStorage.getItem("openwork.preferences");
    let preferences: Record<string, unknown> = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: providerId, modelID: modelId },
      modelVariant: null,
      providerStepCleaned: true,
    }));
    localStorage.setItem("openwork.defaultModel", defaultModel);
    for (const workspaceId of workspaceIds) localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return { outcomes };
  }, [
      [...workspaceIds],
      options.smallModel ?? null,
      options.allowTools ?? false,
      options.providerId,
      options.modelId,
      options.modelName,
      options.baseUrl,
      `${options.providerId}/${options.modelId}`,
    ]), { awaitPromise: true, timeoutMs: 240_000 });
  if (typeof result !== "object" || result === null || !("outcomes" in result) || !Array.isArray(result.outcomes)) {
    throw new Error(`Workspace provider configuration failed: ${JSON.stringify(result)}`);
  }
  const failures = result.outcomes.filter((outcome) => (
    typeof outcome !== "object" || outcome === null || !("status" in outcome) || outcome.status !== 200
  ));
  if (failures.length > 0) throw new Error(`Workspace provider configuration failed: ${JSON.stringify(failures)}`);
}

async function oneWorkspace(seed: Seed, name: string, titles: readonly string[] = []) {
  const app = await seed.desktop({ name });
  const workspacePath = seed.tmpPath(name);
  const workspace = await seed.workspace(app, workspacePath);
  const sessions = titles.length > 0 ? await seed.sessions(app, titles) : [];
  return { app, workspace, workspacePath, sessions };
}

export async function sidebarPrimaryActions(seed: Seed) {
  return oneWorkspace(seed, "sidebar-primary-actions");
}

export async function sidebarOverflow(seed: Seed) {
  const longTitle = "Reading Google Drive documents for the quarterly workspace review";
  const app = await seed.desktop({ name: "sidebar-title-overflow-fade" });
  const workspacePath = "/tmp/Yonder";
  const workspace = await seed.workspace(app, workspacePath);
  const sessions = await seed.sessions(app, [longTitle]);
  return { app, workspace, workspacePath, sessions, longTitle };
}

export async function sidebarExpansion(seed: Seed, mode: "workspace" | "group" | "ungrouped") {
  const app = await seed.desktop({ name: `sidebar-${mode}-expansion` });
  await app.client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 600, deviceScaleFactor: 1, mobile: false });
  const workspace = await seed.workspace(app, seed.tmpPath(`sidebar-${mode}`));
  const sessions = await seed.sessions(app, Array.from({ length: 20 }, (_, index) => `Expansion task ${String(index + 1).padStart(2, "0")}`));
  const [neighbor] = await seed.sessions(app, ["Neighbor task"]);
  if (!neighbor) throw new Error("Sidebar expansion neighbor was not created");
  const groups = mode === "workspace" ? [] : [
    ...(mode === "group" ? [{ id: "grp_expansion", label: "Expansion group" }] : []),
    { id: "grp_neighbor", label: "Neighbor group" },
  ];
  const assignments = mode === "workspace" ? {} : Object.fromEntries([
    ...sessions.flatMap(session => mode === "group" ? [[session.sessionId, "grp_expansion"]] : []),
    [neighbor.sessionId, "grp_neighbor"],
  ]);
  // Persist real group state and manual order before reload; no component/store imports.
  await seed.evalIn(app, browserScript(async (workspaceId, groups, assignments, ids) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info?.baseUrl) throw new Error("Sidebar seed needs the local server");
    const response = await fetch(`${info.baseUrl.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/session-groups`, {
      method: "PUT", headers: { Authorization: `Bearer ${info.ownerToken ?? info.clientToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: { groups, assignments } }), signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Sidebar group seed failed: ${response.status}`);
    localStorage.setItem("openwork.react.sessionManagement", JSON.stringify({ state: {
      pinnedIds: [], unreadIds: [], orderByWorkspace: { [workspaceId]: ids },
      groupsByWorkspace: { [workspaceId]: { groups, assignments, collapsedGroupIds: [] } },
    }, version: 0 }));
  }, [workspace.workspaceId, groups, assignments, [...sessions.map(session => session.sessionId), neighbor.sessionId]]));
  await app.client.send("Page.reload");
  await waitFor(app, () => Boolean(document.querySelector('[data-sidebar-session-id]')) && Boolean(window.__openworkControl), {
    timeoutMs: 60_000, label: "sidebar expansion fixture reloaded",
  });
  const observation = await observeSidebarExpansion(app);
  return { app, workspace, sessions, neighbor, observation, [Symbol.asyncDispose]: () => observation[Symbol.asyncDispose]() };
}

export async function sidebarWorkspaceTitles(seed: Seed) {
  const runId = Date.now().toString(36);
  const shortName = `Yonder-${runId}`;
  const longName = `openwork-workspace-title-that-keeps-going-past-the-sidebar-${runId}`;
  const app = await seed.desktop({ name: "sidebar-workspace-title-fit" });
  const shortWorkspace = await seed.workspace(app, `/tmp/${shortName}`);
  return { app, shortName, longName, shortWorkspace };
}

export async function workspaceNewTask(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("local renderer performance contract (OPENWORK_WORLD_PLACE=local and --local)");
  if (resolveEvalEngine() !== "v1") throw new SkipError("native v1 instant-send contract (OPENWORK_EVAL_ENGINE=v1)");
  const providerId = "new-task-mock";
  const modelId = "new-task-model";
  const nonce = `${Date.now().toString(36)}-${process.pid}`;
  const lazySamples = Array.from({ length: 12 }, (_, index) => ({
    marker: `INSTANT-LAZY-${String(index + 1).padStart(2, "0")}-${nonce}`,
    reply: `Lazy task ${String(index + 1).padStart(2, "0")} completed ${nonce}.`,
  }));
  const existingSamples = Array.from({ length: 12 }, (_, index) => ({
    marker: `INSTANT-EXISTING-${String(index + 1).padStart(2, "0")}-${nonce}`,
    reply: `Existing task ${String(index + 1).padStart(2, "0")} completed ${nonce}.`,
  }));
  const existingHistory = `EXISTING-HISTORY-${nonce}`;
  const existingHistoryReply = `The existing startup task finished successfully ${nonce}.`;
  const unrelatedHistory = `UNRELATED-HISTORY-${nonce}`;
  const unrelatedHistoryReply = `The unrelated startup task finished successfully ${nonce}.`;
  const navigation = { marker: `INSTANT-NAVIGATION-A-${nonce}`, reply: `Navigation task completed ${nonce}.` };
  const responseHold = { marker: `INSTANT-RESPONSE-HOLD-${nonce}`, reply: `Response hold completed ${nonce}.` };
  const workloads = [
    { marker: existingHistory, reply: existingHistoryReply },
    { marker: unrelatedHistory, reply: unrelatedHistoryReply },
    ...lazySamples,
    ...existingSamples,
    navigation,
    responseHold,
  ]
    .map(({ marker, reply }) => ({ promptMarker: marker, latestUserTurn: true, finalReply: reply, steps: [] }));
  await using setup = new AsyncDisposableStack();
  const mock = setup.use(await startMockMcp({ port: await allocateFreePort(), agentWorkloads: workloads }));
  const app = await seed.desktop({ name: "workspace-new-task", model: `${providerId}/${modelId}` });
  const workspacePath = seed.tmpPath(`openwork-workspace-new-task-long-name-${Date.now()}`);
  const workspace = await seed.workspace(app, workspacePath, { create: true });
  await configureWorkspaceProvider(seed, app, [workspace.workspaceId], {
    providerId, modelId, modelName: "New task model", baseUrl: `${mock.url}/v1`,
  });
  await reload(app, { timeoutMs: 60_000 });
  await waitFor(app, () => Boolean(window.__openworkControl?.listActions()
    .some((entry) => entry.id === "session.model_picker.open" && entry.disabled === false)), {
    timeoutMs: 60_000,
    label: "reloaded renderer model picker is interactive",
  });
  await readAvailableModels(app);
  const selectedModel = await selectModel(app, modelId);
  if (!selectedModel.selected) throw new Error("The mock task model was not selected.");
  const [unrelated, existing] = await seed.sessions(app, ["Unrelated populated task", "Existing populated task"]);
  if (!unrelated || !existing) throw new Error("Instant-send world did not create both real v1 sessions.");

  const serverInfo = await seed.evalIn(app, async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    return info?.running && info.baseUrl
      ? { baseUrl: String(info.baseUrl), token: String(info.ownerToken ?? info.clientToken ?? "") }
      : null;
  }, { awaitPromise: true, timeoutMs: 30_000 });
  if (!isRecord(serverInfo) || typeof serverInfo.baseUrl !== "string" || typeof serverInfo.token !== "string" || !serverInfo.token) {
    throw new Error("Instant-send world could not reach the real local v1 engine.");
  }
  const serverUrl = serverInfo.baseUrl;
  const serverToken = serverInfo.token;
  const engine = engineSessionProbe({
    engine: "v1",
    surface: app,
    workspaceId: workspace.workspaceId,
  });
  const submitNativePrompt = async (sessionId: string, text: string) => {
    const base = serverUrl.replace(/\/+$/, "");
    const response = await fetch(`${base}/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}/message`, {
      method: "POST",
      headers: { Authorization: `Bearer ${serverToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: providerId, modelID: modelId },
        parts: [{ type: "text", text }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Real v1 history setup returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  };
  await Promise.all([
    submitNativePrompt(unrelated.sessionId, unrelatedHistory),
    submitNativePrompt(existing.sessionId, existingHistory),
  ]);
  const readNativeHistory = async (sessionId: string, marker: string, reply: string) => {
    const base = serverUrl.replace(/\/+$/, "");
    const mount = `${base}/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode`;
    const headers = { Authorization: `Bearer ${serverToken}` };
    const [messagesResponse, statusResponse] = await Promise.all([
      fetch(`${mount}/session/${encodeURIComponent(sessionId)}/message?limit=20`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      }),
      fetch(`${mount}/session/status`, { headers, signal: AbortSignal.timeout(10_000) }),
    ]);
    if (!messagesResponse.ok || !statusResponse.ok) {
      throw new Error(`Real v1 history readiness returned messages=${messagesResponse.status}, status=${statusResponse.status}`);
    }
    const messagesBody: unknown = await messagesResponse.json();
    const statusBody: unknown = await statusResponse.json();
    const messages = Array.isArray(messagesBody)
      ? messagesBody
      : isRecord(messagesBody) && Array.isArray(messagesBody.data) ? messagesBody.data : [];
    const nativeMessages = messages.flatMap((message) => {
      if (!isRecord(message)) return [];
      const info = isRecord(message.info) ? message.info : message;
      const parts = Array.isArray(message.parts) ? message.parts : [];
      return [{
        role: typeof info.role === "string" ? info.role : "",
        text: parts.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n"),
      }];
    });
    const statuses = isRecord(statusBody) && isRecord(statusBody.data) ? statusBody.data : statusBody;
    const status = isRecord(statuses) ? statuses[sessionId] : undefined;
    return {
      userPersisted: nativeMessages.some((message) => message.role === "user" && message.text.includes(marker)),
      assistantPersisted: nativeMessages.some((message) => message.role === "assistant" && message.text.includes(reply)),
      idle: status === undefined || (isRecord(status) && status.type === "idle"),
    };
  };
  const historyDeadline = Date.now() + 60_000;
  let historyReadiness = await Promise.all([
    readNativeHistory(unrelated.sessionId, unrelatedHistory, unrelatedHistoryReply),
    readNativeHistory(existing.sessionId, existingHistory, existingHistoryReply),
  ]);
  while (!historyReadiness.every((state) => state.userPersisted && state.assistantPersisted && state.idle)) {
    if (Date.now() >= historyDeadline) {
      throw new Error(`Real v1 completed history did not become idle: ${JSON.stringify(historyReadiness)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    historyReadiness = await Promise.all([
      readNativeHistory(unrelated.sessionId, unrelatedHistory, unrelatedHistoryReply),
      readNativeHistory(existing.sessionId, existingHistory, existingHistoryReply),
    ]);
  }
  await waitFor(app, browserScript((marker, reply, workspaceId, sessionId) => {
    if ((localStorage.getItem("openwork.react.activeWorkspace") ?? "") !== workspaceId
      || location.hash !== `#/workspace/${workspaceId}/session/${sessionId}`) return false;
    const pane = document.querySelector<HTMLElement>('[data-workbench-pane="primary"]');
    const surface = [...(pane?.querySelectorAll<HTMLElement>("[data-session-surface-id]") ?? [])]
      .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId);
    const userVisible = [...(surface?.querySelectorAll<HTMLElement>('[data-message-role="user"]') ?? [])]
      .some((row) => row.innerText.includes(marker));
    const assistantVisible = [...(surface?.querySelectorAll<HTMLElement>('[data-message-role="assistant"]') ?? [])]
      .some((row) => row.innerText.includes(reply));
    return userVisible && assistantVisible;
  }, [existingHistory, existingHistoryReply, workspace.workspaceId, existing.sessionId]), {
    timeoutMs: 30_000,
    label: "existing completed task is visible before performance sampling",
  });

  const boundary = await instantBoundaryController(app, workspace.workspaceId);
  const sessionIds = async () => {
    const result = await engine.list();
    if (!result.ok) throw new Error(`Real v1 session inventory returned HTTP ${result.status}`);
    return result.data.map((session) => session.id).sort();
  };
  const sanitizedDiagnosticText = (value: string) => value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/\b(ownerToken|clientToken|token)\b\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
  const sanitizedErrorField = (value: unknown, field: "name" | "message") => {
    const pending: unknown[] = [value];
    for (let index = 0; index < pending.length && index < 8; index += 1) {
      const candidate = pending[index];
      if (field === "message" && typeof candidate === "string" && candidate) return sanitizedDiagnosticText(candidate);
      if (Array.isArray(candidate)) {
        pending.push(...candidate);
        continue;
      }
      if (!isRecord(candidate)) continue;
      const fieldNames = field === "name" ? ["name", "code", "error"] : ["message", "detail", "error"];
      for (const fieldName of fieldNames) {
        const direct = candidate[fieldName];
        if (typeof direct !== "string" || !direct) continue;
        return sanitizedDiagnosticText(direct);
      }
      for (const key of ["error", "data", "cause", "validation", "issues", "errors"]) {
        if (key in candidate) pending.push(candidate[key]);
      }
    }
    return "unavailable";
  };
  const messageFacts = async (sessionId: string, marker: string, diagnosticReplyMarker?: string) => {
    if (diagnosticReplyMarker !== undefined) {
      let currentServerInfo: { baseUrl: string; ownerAccessToken: string; clientAccessToken: string } | null = null;
      let serverInfoError: string | null = null;
      try {
        currentServerInfo = await seed.evalIn(app, async () => {
          const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
          if (!info?.running || !info.baseUrl) return null;
          return {
            baseUrl: String(info.baseUrl),
            ownerAccessToken: String(info.ownerToken ?? ""),
            clientAccessToken: String(info.clientToken ?? ""),
          };
        }, { awaitPromise: true, timeoutMs: 5_000 });
      } catch (error) {
        serverInfoError = sanitizedErrorField(error, "message");
      }
      const unavailable = (error: string) => ({
        messages: 0,
        markerCount: 0,
        markerOccurrences: 0,
        diagnostic: {
          transport: "node",
          user: { count: 0, occurrences: 0 },
          reply: { count: 0, occurrences: 0 },
          ownerSnapshot: Object.fromEntries(["session", "messages", "todo", "status"]
            .map((name) => [name, { status: 0, durationMs: 0, errorName: "unavailable", errorMessage: error }])),
          clientSnapshot: null,
          health: { status: 0, durationMs: 0, errorName: "unavailable", errorMessage: error, actualV1Version: null },
          preview: { status: 0, durationMs: 0, errorName: "unavailable", errorMessage: error, enabled: null, chatRouting: null },
        },
      });
      if (!currentServerInfo?.ownerAccessToken) return unavailable(serverInfoError ?? "current owner server credential unavailable");

      const base = currentServerInfo.baseUrl.replace(/\/+$/, "");
      const nodeGet = async (path: string, accessToken: string) => {
        const startedAt = performance.now();
        try {
          const response = await fetch(`${base}${path}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: AbortSignal.timeout(5_000),
          });
          const text = await response.text();
          let body: unknown = text;
          try { body = text ? JSON.parse(text) : null; } catch {}
          return {
            ok: response.ok,
            status: response.status,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
            body,
            transportErrorName: null,
            transportErrorMessage: null,
          };
        } catch (error) {
          return {
            ok: false,
            status: 0,
            durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
            body: null,
            transportErrorName: sanitizedErrorField(error, "name"),
            transportErrorMessage: sanitizedErrorField(error, "message"),
          };
        }
      };
      const responseFacts = (response: Awaited<ReturnType<typeof nodeGet>>) => ({
        status: response.status,
        durationMs: response.durationMs,
        errorName: response.ok ? null : response.transportErrorName ?? sanitizedErrorField(response.body, "name"),
        errorMessage: response.ok ? null : response.transportErrorMessage ?? sanitizedErrorField(response.body, "message"),
      });
      const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode`;
      const encodedSessionId = encodeURIComponent(sessionId);
      const snapshotPaths = {
        session: `${mount}/session/${encodedSessionId}`,
        messages: `${mount}/session/${encodedSessionId}/message?limit=140`,
        todo: `${mount}/session/${encodedSessionId}/todo`,
        status: `${mount}/session/status`,
      };
      const snapshotProbe = async (accessToken: string) => {
        const [session, messages, todo, status] = await Promise.all([
          nodeGet(snapshotPaths.session, accessToken),
          nodeGet(snapshotPaths.messages, accessToken),
          nodeGet(snapshotPaths.todo, accessToken),
          nodeGet(snapshotPaths.status, accessToken),
        ]);
        return {
          responses: { session, messages, todo, status },
          facts: {
            session: responseFacts(session),
            messages: responseFacts(messages),
            todo: responseFacts(todo),
            status: responseFacts(status),
          },
        };
      };
      const compareClient = Boolean(currentServerInfo.clientAccessToken
        && currentServerInfo.clientAccessToken !== currentServerInfo.ownerAccessToken);
      const [ownerSnapshot, clientSnapshot, healthResponse, previewResponse] = await Promise.all([
        snapshotProbe(currentServerInfo.ownerAccessToken),
        compareClient ? snapshotProbe(currentServerInfo.clientAccessToken) : Promise.resolve(null),
        nodeGet(`${mount}/global/health`, currentServerInfo.ownerAccessToken),
        nodeGet("/experimental/engine-v2-preview/status", currentServerInfo.ownerAccessToken),
      ]);
      const messageResponse = ownerSnapshot.responses.messages;
      const responseItems = Array.isArray(messageResponse.body)
        ? messageResponse.body
        : isRecord(messageResponse.body) && Array.isArray(messageResponse.body.data)
          ? messageResponse.body.data
          : [];
      const nativeMessages = responseItems.flatMap((message) => {
        if (!isRecord(message)) return [];
        const info = isRecord(message.info) ? message.info : message;
        const parts = Array.isArray(message.parts) ? message.parts : [];
        return [{
          role: typeof info.role === "string" ? info.role : "",
          text: parts.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n"),
        }];
      });
      const markerFacts = (role: "user" | "assistant", value: string) => {
        const matching = nativeMessages.filter((message) => message.role === role && message.text.includes(value));
        return {
          count: matching.length,
          occurrences: value ? matching.reduce((total, message) => total + message.text.split(value).length - 1, 0) : 0,
        };
      };
      const user = markerFacts("user", marker);
      const reply = markerFacts("assistant", diagnosticReplyMarker);
      const actualV1Version = isRecord(healthResponse.body) && typeof healthResponse.body.version === "string"
        ? sanitizedDiagnosticText(healthResponse.body.version) : null;
      return {
        messages: nativeMessages.length,
        markerCount: user.count,
        markerOccurrences: user.occurrences,
        diagnostic: {
          transport: "node",
          user,
          reply,
          ownerSnapshot: ownerSnapshot.facts,
          clientSnapshot: clientSnapshot?.facts ?? null,
          health: { ...responseFacts(healthResponse), actualV1Version },
          preview: {
            ...responseFacts(previewResponse),
            enabled: isRecord(previewResponse.body) && typeof previewResponse.body.enabled === "boolean"
              ? previewResponse.body.enabled : null,
            chatRouting: isRecord(previewResponse.body) && typeof previewResponse.body.chatRouting === "boolean"
              ? previewResponse.body.chatRouting : null,
          },
        },
      };
    }
    const result = await engine.messages(sessionId, 100).catch((error: unknown) => {
      const errorName = sanitizedErrorField(error, "name");
      const errorMessage = sanitizedErrorField(error, "message");
      throw new Error(`Real v1 messages read failed for session ${sessionId}: error name=${errorName}; message=${errorMessage}`);
    });
    if (!result.ok) {
      const errorName = sanitizedErrorField(result.body, "name");
      const errorMessage = sanitizedErrorField(result.body, "message");
      throw new Error(`Real v1 messages read failed for session ${sessionId}: HTTP ${result.status}; validation/error name=${errorName}; message=${errorMessage}`);
    }
    const texts = result.data.map((message) => message.parts.map((part) => part.text).join("\n"));
    const matching = marker ? texts.filter((text) => text.includes(marker)) : [];
    return {
      messages: texts.length,
      markerCount: matching.length,
      markerOccurrences: marker ? matching.reduce((total, text) => total + text.split(marker).length - 1, 0) : 0,
      diagnostic: null,
    };
  };
  const providerRequestCount = async (promptMarker: string) => (await mock.agentRequests({ promptMarker }))
    .filter((request) => request.promptMarker === promptMarker && request.kind !== "utility").length;
  const visibleMessageFacts = (sessionId: string, role: "user" | "assistant", marker: string) => seed.evalIn(app, browserScript((sessionId, role, marker) => {
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
    };
    const surfaces = [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")]
      .filter((surface) => surface.dataset.sessionSurfaceId === sessionId);
    const rows = surfaces.flatMap((surface) => [...surface.querySelectorAll<HTMLElement>("[data-message-role]")])
      .filter((row) => row.dataset.messageRole === role && row.innerText.includes(marker));
    const viewportRows = rows.filter(visible);
    const labels = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]
      .filter(visible)
      .map((node) => (node.getAttribute("aria-label") ?? node.innerText).replace(/\s+/g, " ").trim().slice(0, 120))
      .filter((label, index, values) => Boolean(label) && values.indexOf(label) === index)
      .slice(0, 5);
    const network = performance.getEntriesByType("resource").flatMap((entry) => {
      if (!(entry instanceof PerformanceResourceTiming)) return [];
      if (entry.initiatorType !== "fetch" && entry.initiatorType !== "xmlhttprequest") return [];
      const url = new URL(entry.name);
      return [{
        path: url.pathname,
        limit: url.searchParams.get("limit"),
        responseStatus: entry.responseStatus,
        durationMs: Math.round(entry.duration * 100) / 100,
      }];
    }).slice(-30);
    return {
      rowCount: viewportRows.length,
      markerOccurrences: marker ? viewportRows.reduce((total, row) => total + row.innerText.split(marker).length - 1, 0) : 0,
      totalRowCount: rows.length,
      offscreenRowCount: rows.length - viewportRows.length,
      surfaceCount: surfaces.length,
      visibleSurfaceCount: surfaces.filter(visible).length,
      loaderLabels: labels('[role="status"], [data-session-loading-indicator]'),
      errorLabels: labels('[role="alert"]'),
      network,
    };
  }, [sessionId, role, marker]));
  const rendererDiagnostic = (expectedSessionId: string | null) => seed.evalIn(app, browserScript((expectedWorkspaceId, expectedSessionId) => {
    const composer = window.__openwork?.slice("composer") ?? null;
    const ownerWorkspaceId: unknown = composer ? Reflect.get(composer, "workspaceId") : null;
    const ownerSessionId: unknown = composer ? Reflect.get(composer, "sessionId") : null;
    return {
      expectedWorkspaceId,
      expectedSessionId,
      expectedRoute: expectedSessionId
        ? `#/workspace/${expectedWorkspaceId}/session/${expectedSessionId}`
        : `#/workspace/${expectedWorkspaceId}/session`,
      actualRoute: location.hash,
      ownerWorkspaceId: typeof ownerWorkspaceId === "string" ? ownerWorkspaceId : null,
      ownerSessionId: typeof ownerSessionId === "string" ? ownerSessionId : null,
      snapshotQuery: composer ? {
        status: composer.snapshotQuery.status,
        fetchStatus: composer.snapshotQuery.fetchStatus,
        isPaused: composer.snapshotQuery.isPaused,
        failureCount: composer.snapshotQuery.failureCount,
        errorName: composer.snapshotQuery.errorName,
        errorMessage: composer.snapshotQuery.errorMessage,
        dataSessionId: composer.snapshotQuery.dataSessionId,
        dataMessageCount: composer.snapshotQuery.dataMessageCount,
        currentSnapshotId: composer.snapshotQuery.currentSnapshotId,
        intendedSessionId: composer.snapshotQuery.intendedSessionId,
        opencodeBaseUrl: composer.snapshotQuery.opencodeBaseUrl,
        tokenPresent: composer.snapshotQuery.tokenPresent,
      } : null,
      navigatorOnline: navigator.onLine,
      documentHasFocus: document.hasFocus(),
    };
  }, [workspace.workspaceId, expectedSessionId]));
  const readInstantComposer = () => seed.evalIn(app, browserScript((workspaceId) => {
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return node.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
        && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
        && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
    };
    if ((localStorage.getItem("openwork.react.activeWorkspace") ?? "") !== workspaceId) {
      return { rootKind: "", focused: false, editable: false, text: "" };
    }
    let root: HTMLElement | null = null;
    let rootKind = "";
    const sessionlessRoute = `#/workspace/${workspaceId}/session`;
    if (location.hash === sessionlessRoute) {
      const heading = [...document.querySelectorAll<HTMLElement>("h2")]
        .find((candidate) => candidate.textContent?.trim() === "What do you need done?" && visible(candidate));
      const headingMain = heading?.closest<HTMLElement>("main") ?? null;
      const main = headingMain && visible(headingMain) ? headingMain
        : [...document.querySelectorAll<HTMLElement>("main")].filter(visible)
            .find((candidate) => [...candidate.querySelectorAll<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"], [data-message-role]')]
              .some(visible)) ?? null;
      const persistedSurfaceVisible = [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")].some(visible);
      if (main && !persistedSurfaceVisible) { root = main; rootKind = "new-task"; }
    } else {
      const persistedPrefix = `#/workspace/${workspaceId}/session/`;
      const sessionId = location.hash.startsWith(persistedPrefix) ? location.hash.slice(persistedPrefix.length) : "";
      if (sessionId.startsWith("ses_") && !/[/?#]/.test(sessionId)) {
        const pane = [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"]')].find(visible) ?? null;
        const surface = [...(pane?.querySelectorAll<HTMLElement>("[data-session-surface-id]") ?? [])]
          .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId && visible(candidate));
        if (pane && surface) { root = pane; rootKind = "persisted"; }
      }
    }
    const editor = root?.querySelector<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"]') ?? null;
    return {
      rootKind,
      focused: Boolean(editor && (document.activeElement === editor || editor.contains(document.activeElement))),
      editable: Boolean(editor?.isContentEditable && visible(editor)),
      text: editor?.innerText ?? "",
    };
  }, [workspace.workspaceId]));
  const insertFocusedText = async (text: string) => {
    const before = await readInstantComposer();
    if (!isRecord(before) || (before.rootKind !== "new-task" && before.rootKind !== "persisted")
      || before.focused !== true || before.editable !== true || typeof before.text !== "string") {
      throw new Error(`Focused composer was unavailable for native insertText: ${JSON.stringify(before)}`);
    }
    await typeText(app, text);
    const deadline = Date.now() + 5_000;
    let after = await readInstantComposer();
    while (Date.now() < deadline && !after.text.endsWith(text)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      after = await readInstantComposer();
    }
    if (!after.text.endsWith(text)) throw new Error("Focused composer did not retain native insertText");
    return { beforeText: before.text, afterText: after.text };
  };
  const newTaskGeometry = (point: Point) => seed.evalIn(app, browserScript((workspaceId, x, y) => {
    const matchingWorkspaces = [...document.querySelectorAll<HTMLElement>(`[data-sidebar-workspace-id="${workspaceId}"]`)];
    const matchingPlusNodes = matchingWorkspaces.flatMap((candidate) => [...candidate.querySelectorAll<HTMLElement>("[data-workspace-new-task]")]);
    const matchingHeaderNodes = new Set(matchingPlusNodes.map((candidate) => candidate.closest<HTMLElement>("[data-workspace-actions]")?.parentElement).filter((candidate) => candidate !== null));
    const workspace = matchingWorkspaces[0] ?? null;
    const plus = workspace?.querySelector<HTMLElement>("[data-workspace-new-task]") ?? null;
    const actions = plus?.closest<HTMLElement>("[data-workspace-actions]") ?? null;
    const header = actions?.parentElement ?? null;
    const actionsStyle = actions ? getComputedStyle(actions) : null;
    const correctWorkspace = Boolean(workspace && plus?.closest("[data-sidebar-workspace-id]") === workspace);
    const rect = plus?.getBoundingClientRect() ?? null;
    let hiddenBy = "";
    let current: Element | null = plus ?? null;
    while (current instanceof Element && !hiddenBy) {
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) <= 0) {
        hiddenBy = `${current.tagName.toLowerCase()}:${style.display}/${style.visibility}/${style.opacity}`;
      }
      current = current.parentElement;
    }
    const centerX = rect ? rect.left + rect.width / 2 : 0;
    const centerY = rect ? rect.top + rect.height / 2 : 0;
    const centered = Math.abs(centerX - x) < 0.5 && Math.abs(centerY - y) < 0.5;
    const inViewport = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    const hit = inViewport ? document.elementFromPoint(x, y) : null;
    const hitPlus = Boolean(plus && hit instanceof Node && plus.contains(hit));
    return {
      ready: Boolean(correctWorkspace && plus && rect && rect.width > 0 && rect.height > 0
        && !hiddenBy && centered && inViewport && hitPlus),
      found: Boolean(plus),
      point: [Math.round(x), Math.round(y)],
      center: [Math.round(centerX), Math.round(centerY)],
      centerX,
      centerY,
      rect: rect ? [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)] : [],
      correctWorkspace,
      hiddenBy,
      hitPlus,
      headerHover: header?.matches(":hover") ?? false,
      plusHover: plus?.matches(":hover") ?? false,
      hoverHover: matchMedia("(hover: hover)").matches,
      anyHoverHover: matchMedia("(any-hover: hover)").matches,
      pointerFine: matchMedia("(pointer: fine)").matches,
      maxTouchPoints: navigator.maxTouchPoints,
      documentHasFocus: document.hasFocus(),
      actionsClassName: actions?.className ?? "",
      headerClassName: header?.className ?? "",
      actionsOpacity: actionsStyle?.opacity ?? "",
      actionsTransitionDuration: actionsStyle?.transitionDuration ?? "",
      multipleMatchingPlus: matchingPlusNodes.length > 1,
      multipleMatchingHeaders: matchingHeaderNodes.size > 1,
      covering: hitPlus || !(hit instanceof Element) ? "" : hit.tagName.toLowerCase(),
    };
  }, [workspace.workspaceId, point.x, point.y]));
  const prepareWorkspaceNewTask = async (): Promise<Point> => {
    const deadline = Date.now() + 5_000;
    const reset = await seed.evalIn(app, browserScript((workspaceId) => {
      const workspace = document.querySelector<HTMLElement>(`[data-sidebar-workspace-id="${workspaceId}"]`);
      const plus = workspace?.querySelector<HTMLElement>("[data-workspace-new-task]") ?? null;
      const header = plus?.closest<HTMLElement>("[data-workspace-actions]")?.parentElement ?? null;
      if (!workspace || !plus || !header || plus.closest("[data-sidebar-workspace-id]") !== workspace) {
        return { ready: false, point: [0, 0], plus: [], header: [], hitHeader: false, x: 0, y: 0 };
      }
      let rect = plus.getBoundingClientRect();
      if (rect.left < 0 || rect.top < 0 || rect.right > innerWidth || rect.bottom > innerHeight) {
        plus.scrollIntoView({ block: "nearest", inline: "nearest" });
        rect = plus.getBoundingClientRect();
      }
      const headerRect = header.getBoundingClientRect();
      const left = Math.max(0, headerRect.left);
      const right = Math.min(innerWidth, headerRect.right);
      const top = Math.max(0, headerRect.top);
      const bottom = Math.min(innerHeight, headerRect.bottom);
      const x = left + Math.min(8, Math.max(1, (right - left) / 4));
      const y = top + (bottom - top) / 2;
      let headerVisible = true;
      let current: Element | null = header;
      while (current instanceof Element && headerVisible) {
        const style = getComputedStyle(current);
        headerVisible = style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0;
        current = current.parentElement;
      }
      const hit = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight ? document.elementFromPoint(x, y) : null;
      const hitHeader = hit instanceof Node && header.contains(hit) && !plus.contains(hit);
      const plusX = rect.left + rect.width / 2;
      const plusY = rect.top + rect.height / 2;
      const different = Math.abs(x - plusX) >= 1 || Math.abs(y - plusY) >= 1;
      return {
        ready: headerVisible && right > left && bottom > top && hitHeader && different,
        point: [Math.round(x), Math.round(y)],
        plus: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
        header: [Math.round(headerRect.x), Math.round(headerRect.y), Math.round(headerRect.width), Math.round(headerRect.height)],
        hitHeader,
        x,
        y,
      };
    }, [workspace.workspaceId]));
    if (!reset.ready || !Number.isFinite(reset.x) || !Number.isFinite(reset.y)) {
      throw new Error(`New task header reset point was unavailable before click: ${JSON.stringify(reset)}`);
    }
    await hoverAt(app, { x: reset.x, y: reset.y });
    let readiness = await newTaskGeometry({ x: reset.x, y: reset.y });
    while (!readiness.headerHover && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      readiness = await newTaskGeometry({ x: reset.x, y: reset.y });
    }
    if (!readiness.headerHover || !readiness.correctWorkspace
      || !Number.isFinite(readiness.centerX) || !Number.isFinite(readiness.centerY)) {
      throw new Error(`New task header did not rearm hover before click: ${JSON.stringify(readiness)}`);
    }
    let point: Point = { x: readiness.centerX, y: readiness.centerY };
    await hoverAt(app, point);
    readiness = await newTaskGeometry(point);
    while (!readiness.ready && Date.now() < deadline) {
      if (readiness.correctWorkspace && Number.isFinite(readiness.centerX) && Number.isFinite(readiness.centerY)
        && (Math.abs(readiness.centerX - point.x) >= 0.5 || Math.abs(readiness.centerY - point.y) >= 0.5)) {
        point = { x: readiness.centerX, y: readiness.centerY };
        await hoverAt(app, point);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      readiness = await newTaskGeometry(point);
    }
    if (!readiness.ready) {
      throw new Error(`New task plus was not ready before click: ${JSON.stringify(readiness)}`);
    }
    return point;
  };
  const clickWorkspaceNewTask = (point: Point) => clickAt(app, point);
  const accessibleRunTaskReady = async (expectedText: string) => seed.evalIn(app, browserScript((workspaceId, expectedText) => {
      const visible = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return node.getClientRects().length > 0 && rect.width > 0 && rect.height > 0
          && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight
          && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0;
      };
      if ((localStorage.getItem("openwork.react.activeWorkspace") ?? "") !== workspaceId) {
        return { ready: false, rootKind: "", composerText: "", focusedEditor: false, buttonFound: false, buttonDisabled: null, buttonHit: false };
      }
      let root: HTMLElement | null = null;
      let rootKind = "";
      const sessionlessRoute = `#/workspace/${workspaceId}/session`;
      if (location.hash === sessionlessRoute) {
        const heading = [...document.querySelectorAll<HTMLElement>("h2")]
          .find((candidate) => candidate.textContent?.trim() === "What do you need done?" && visible(candidate));
        const headingMain = heading?.closest<HTMLElement>("main") ?? null;
        const main = headingMain && visible(headingMain) ? headingMain
          : [...document.querySelectorAll<HTMLElement>("main")].filter(visible)
              .find((candidate) => [...candidate.querySelectorAll<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"], [data-message-role]')]
                .some(visible)) ?? null;
        const persistedSurfaceVisible = [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")].some(visible);
        if (main && !persistedSurfaceVisible) { root = main; rootKind = "new-task"; }
      } else {
        const persistedPrefix = `#/workspace/${workspaceId}/session/`;
        const sessionId = location.hash.startsWith(persistedPrefix) ? location.hash.slice(persistedPrefix.length) : "";
        if (sessionId.startsWith("ses_") && !/[/?#]/.test(sessionId)) {
          const pane = [...document.querySelectorAll<HTMLElement>('[data-workbench-pane="primary"]')].find(visible) ?? null;
          const surface = [...(pane?.querySelectorAll<HTMLElement>("[data-session-surface-id]") ?? [])]
            .find((candidate) => candidate.dataset.sessionSurfaceId === sessionId && visible(candidate));
          if (pane && surface) { root = pane; rootKind = "persisted"; }
        }
      }
      const editor = [...(root?.querySelectorAll<HTMLElement>('[contenteditable="true"][data-lexical-editor="true"]') ?? [])]
        .find(visible) ?? null;
      const button = [...(root?.querySelectorAll<HTMLButtonElement>('button[aria-label="Run task"]') ?? [])]
        .find(visible) ?? null;
      const rect = button?.getBoundingClientRect() ?? null;
      const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
      const buttonHit = Boolean(button && hit instanceof Node && button.contains(hit));
      const focusedEditor = Boolean(editor && (document.activeElement === editor || editor.contains(document.activeElement)));
      const composerText = editor?.innerText ?? "";
      return {
        ready: Boolean(root && editor?.isContentEditable && visible(editor) && focusedEditor
          && composerText === expectedText && button && !button.disabled && buttonHit),
        rootKind,
        composerText,
        focusedEditor,
        buttonFound: Boolean(button),
        buttonDisabled: button?.disabled ?? null,
        buttonHit,
      };
    }, [workspace.workspaceId, expectedText]));

  const resources = setup.move();
  return {
    app,
    workspace,
    workspacePath,
    existing,
    unrelated,
    existingHistory,
    unrelatedHistory,
    lazySamples,
    existingSamples,
    navigation,
    responseHold,
    failure: {
      creationA: `INSTANT-CREATE-FAIL-A-${nonce}`,
      creationB: `INSTANT-CREATE-FAIL-B-${nonce}`,
      promptA: `INSTANT-PROMPT-FAIL-A-${nonce}`,
      promptB: `INSTANT-PROMPT-FAIL-B-${nonce}`,
      pendingB: `INSTANT-PENDING-DRAFT-B-${nonce}`,
      navigationB: `INSTANT-NAVIGATION-DRAFT-B-${nonce}`,
    },
    boundary,
    sessionIds,
    messageFacts,
    providerRequestCount,
    visibleMessageFacts,
    rendererDiagnostic,
    insertFocusedText,
    prepareWorkspaceNewTask,
    clickWorkspaceNewTask,
    accessibleRunTaskReady,
    observeRenderer: (kind: InstantMetricKind, marker = "") => observeInstantRenderer(seed, app, workspace.workspaceId, kind, marker),
    [Symbol.asyncDispose]: () => resources.disposeAsync(),
  };
}

export async function pinnedSessions(seed: Seed) {
  const app = await seed.desktop({ name: "pinned-sessions-exposed" });
  const workspacePath = seed.tmpPath("pinned-sessions-exposed");
  const workspace = await seed.workspace(app, workspacePath);
  const [candidate, neighbor] = await seed.sessions(app, ["Candidate session", "Neighbor session"]);
  if (!candidate || !neighbor) throw new Error("Pinned world did not create both sessions.");

  // TODO(primitive): probe.context should expose the OpenWork context snapshot.
  async function context(): Promise<{ pinnedSessionIds: string[]; pinnedResourceRefs: string[] }> {
    const value = await seed.evalIn(app, () => {
      const c = window.__openworkControl?.context?.();
      return {
        pinnedSessionIds: c?.conversations?.pinnedSessionIds ?? null,
        pinnedResourceRefs: (c?.resources ?? [])
          .filter((r) => r.kind === "session" && r.state?.pinned === true)
          .map((r) => r.ref),
      };
    });
    if (!isRecord(value)
      || !Array.isArray(value.pinnedSessionIds)
      || !value.pinnedSessionIds.every((id) => typeof id === "string")
      || !Array.isArray(value.pinnedResourceRefs)
      || !value.pinnedResourceRefs.every((ref) => typeof ref === "string")) {
      throw new Error(`OpenWork context pin state was malformed: ${JSON.stringify(value)}`);
    }
    return {
      pinnedSessionIds: value.pinnedSessionIds,
      pinnedResourceRefs: value.pinnedResourceRefs,
    };
  }

  // TODO(primitive): probe.sidebar complements user.see({ text: "Pinned" }) by exposing which rows the section contains.
  async function pinnedSidebarRows(): Promise<string[] | null> {
    const value = await seed.evalIn(app, () => {
      const section = document.querySelector<HTMLElement>("[data-global-pinned-sessions]");
      if (!section) return null;
      return [...section.querySelectorAll<HTMLElement>("[data-sidebar-session-id]")]
        .map((row) => row.getAttribute("data-sidebar-session-id"));
    });
    if (value === null) return null;
    if (!Array.isArray(value) || !value.every((sessionId) => typeof sessionId === "string")) {
      throw new Error(`Global pinned sidebar rows were malformed: ${JSON.stringify(value)}`);
    }
    return value;
  }

  return { app, workspace, workspacePath, candidate, neighbor, context, pinnedSidebarRows };
}

export async function commandPaletteSearch(seed: Seed) {
  return oneWorkspace(seed, `command-palette-search-${Date.now()}`);
}

type ArchiveFault = "none" | "false" | "error" | "timeout" | "unconfirmed" | "hold" | "retry" | "permission" | "question" | "prompt_error" | "hold_prompt" | "accepted_command" | "hold_archive";
type ArchiveRequest = {
  path: string; sessionId: string; action: string; messageID: string | null; result: string | number | null;
  command?: { name: string; arguments: string; model: string | null; agent: string | null };
  responseBody?: string;
  dispatchError?: string;
};

declare global {
  interface Window {
    __archiveAvailabilityRequests: { method: string; path: string }[];
    __archiveNetwork: {
      mode: ArchiveFault;
      sessionId: string;
      workspaceId: string;
      requests: ArchiveRequest[];
      original: typeof fetch;
      release: (() => void | Promise<void>) | null;
    };
  }
}

export async function archiveActiveSessions(seed: Seed, { place }: { place: Place }) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("Active archive requires v1; session-archive-undo covers v2 unavailability.");
  await using resources = new AsyncDisposableStack();
  const providerId = "session-archive-mock";
  const modelId = "mock-agent-workload-model";
  const app = await seed.desktop({ name: "session-archive-button", model: `${providerId}/${modelId}` });
  const definition = seed.mock({ agentWorkloads: [{ promptMarker: "session-archive", matchAll: true, finalReply: "Archive fixture reply.", steps: [] }] });
  const sandbox = app.handle.sandboxId;
  const booted = app.handle.hostKind === "daytona"
    ? await (async () => {
      if (!sandbox || !definition.connect) throw new Error("Archive mock requires its desktop sandbox and mock adapter.");
      const remote = await startMockOnSandbox({ sandbox, port: definition.daytonaPort });
      return definition.connect(remote.url);
    })()
    : await definition.boot(place);
  const mock = resources.use(booted.handle);
  const setHeld = async (held: boolean) => {
    const response = await fetch(`${mock.url}/admin/agent-hold`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ held }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Archive mock hold failed: HTTP ${response.status}`);
  };
  await setHeld(true);
  const stamp = `${Date.now()}-${process.pid}`;
  const workspaceA = await seed.workspace(app, `/tmp/openwork-session-archive-${stamp}-a`);
  const workspaceBName = `openwork-session-archive-${stamp}-b`;
  const workspaceB = await additionalWorkspace(seed, app, `/tmp/${workspaceBName}`);
  await configureWorkspaceProvider(seed, app, [workspaceA.workspaceId, workspaceB.workspaceId], {
    providerId, modelId, modelName: "Archive fixture model", baseUrl: `${mock.url}/v1`, allowTools: true,
  });
  // OpenWork's runtime config drops command/model keys. In v1.18.18 the native
  // workspace PATCH also writes config.json, which its project loader ignores.
  // Use the native global config in this desktop's isolated profile instead.
  const commandSetup = await seed.evalIn(app, browserScript(async (workspaceId, model) => {
    const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
    if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
    const base = `${info.baseUrl.replace(/\/+$/, "")}/workspace/${workspaceId}/opencode`;
    const headers = { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken), "Content-Type": "application/json" };
    const read = async () => {
      const [configResponse, commandsResponse] = await Promise.all(["config", "command"].map(endpoint =>
        fetch(`${base}/${endpoint}`, { headers, signal: AbortSignal.timeout(15000) })));
      if (!configResponse.ok || !commandsResponse.ok) throw new Error(`Archive command inventory failed: config=${configResponse.status}, commands=${commandsResponse.status}`);
      const config: { model?: string; small_model?: string; default_agent?: string } = await configResponse.json();
      const commands: { name: string; template: string; model?: string; agent?: string }[] = await commandsResponse.json();
      const command = commands.find(command => command.name === "archive-witness");
      return { model: config.model ?? null, smallModel: config.small_model ?? null, agent: config.default_agent ?? null,
        command: command ? { name: command.name, template: command.template, model: command.model ?? null, agent: command.agent ?? null } : null,
        commandNames: commands.map(command => command.name).sort() };
    };
    const before = await read();
    const response = await fetch(`${base}/global/config`, {
      method: "PATCH", headers, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model, small_model: model, command: { "archive-witness": { template: "Archive command witness task." } } }),
    });
    if (!response.ok) throw new Error(`Archive native command configuration failed: ${response.status} ${(await response.text()).slice(0, 2000)}`);
    // Global config invalidates instances asynchronously; observe actual engine
    // readiness before creating sessions or submitting any held command.
    const deadline = Date.now() + 30_000;
    let after = await read();
    while (after.model !== model || after.smallModel !== model || after.command?.template !== "Archive command witness task.") {
      if (Date.now() >= deadline) throw new Error(`Archive command is not ready: ${JSON.stringify({ after, before })}`);
      await new Promise(resolve => setTimeout(resolve, 250));
      after = await read();
    }
    return { before, after };
  }, [workspaceA.workspaceId, `${providerId}/${modelId}`]), { timeoutMs: 90_000 });
  // Seed each owning engine once; UI task creation can race route changes and create extra sessions.
  async function createSession(workspaceId: string, title: string, parentID?: string): Promise<ShellSession & { workspaceId: string }> {
    const result = await seed.evalIn(app, browserScript(async (workspaceId, title, parentID) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const response = await fetch(info.baseUrl.replace(/\/+$/, "") + "/workspace/" + encodeURIComponent(workspaceId) + "/opencode/session", {
        method: "POST", headers: { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken), "Content-Type": "application/json" },
        body: JSON.stringify(parentID ? { title, parentID } : { title }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Could not seed " + title + " in " + workspaceId + ": " + response.status);
      const session = await response.json();
      return { sessionId: session.id, title: session.title };
    }, [workspaceId, title, parentID]), { timeoutMs: 20_000 });
    if (!isRecord(result) || typeof result.sessionId !== "string" || !result.sessionId || typeof result.title !== "string") {
      throw new Error(`Missing archive session ${title}: ${JSON.stringify(result)}`);
    }
    return { sessionId: result.sessionId, title: result.title, workspaceId };
  }
  const a1 = await createSession(workspaceA.workspaceId, "Chat A");
  const a2 = await createSession(workspaceA.workspaceId, "Archive idle neighbor");
  const b1 = await createSession(workspaceB.workspaceId, "Archive other workspace");
  const child = await createSession(workspaceA.workspaceId, "Archive child task", a1.sessionId);
  // Never reuse synthetic retry/approval state as a real-run target.
  const faultCandidate = await createSession(workspaceA.workspaceId, "Archive fault isolation");

  const previousTimeOrigin = await seed.evalIn(app, () => performance.timeOrigin);
  if (typeof previousTimeOrigin !== "number") throw new Error("Archive document time origin was unavailable.");
  await seed.evalIn(app, browserScript((workspaceId) => {
    history.replaceState(history.state, "", "#/workspace/" + encodeURIComponent(workspaceId) + "/session");
    location.reload();
    return true;
  }, [workspaceB.workspaceId]));
  // Expansion is not persisted: let B render after reload, then leave both groups open on A's start route.
  for (const phase of [
    { workspaceId: workspaceB.workspaceId, sessions: [b1] },
    { workspaceId: workspaceA.workspaceId, sessions: [a1, a2, b1, faultCandidate] },
  ]) {
    if (phase.workspaceId === workspaceA.workspaceId) {
      await seed.evalIn(app, browserScript((workspaceId) => {
        location.hash = "/workspace/" + encodeURIComponent(workspaceId) + "/session";
        return true;
      }, [workspaceA.workspaceId]));
    }
    const deadline = Date.now() + 60_000;
    let ready = false;
    let lastState: unknown = null;
    while (Date.now() < deadline) {
      lastState = await seed.evalIn(app, browserScript((previousTimeOrigin, workspaceId, sessions) => {
        const route = window.__openwork?.slice?.("route");
        const rows = sessions.map((session) => {
          const row = document.querySelector('[data-sidebar-workspace-id="' + session.workspaceId + '"] [data-sidebar-session-id="' + session.sessionId + '"]');
          return {
            sessionId: session.sessionId,
            loaded: route?.sessionsByWorkspaceId?.[session.workspaceId]?.some(item => item.id === session.sessionId) === true,
            visible: Boolean(row?.getClientRects().length),
          };
        });
        return {
          hash: location.hash, selectedWorkspaceId: route?.selectedWorkspaceId, rows,
          ready: performance.timeOrigin !== previousTimeOrigin && Boolean(window.__openworkControl)
            && route?.selectedWorkspaceId === workspaceId
            && !route.workspaces.find(workspace => workspace.id === workspaceId)?.loading
            && location.hash === "#/workspace/" + encodeURIComponent(workspaceId) + "/session"
            && rows.every(row => row.loaded && row.visible),
        };
      }, [previousTimeOrigin, phase.workspaceId, phase.sessions]), {
        timeoutMs: Math.min(5_000, Math.max(1, deadline - Date.now())),
      }).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
      if (isRecord(lastState) && lastState.ready === true) {
        ready = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
    }
    if (!ready) throw new Error(`Archive workspace ${phase.workspaceId} route and sidebar did not become ready: ${JSON.stringify(lastState)}`);
  }

  // Faults live at the HTTP boundary, not in product stores or archive code.
  // The local desktop's loopback OpenCode requests use the renderer fetch.
  await seed.evalIn(app, () => {
    const original = window.fetch.bind(window);
    const state: Window["__archiveNetwork"] = { mode: "none", sessionId: "", workspaceId: "", requests: [], release: null, original };
    window.__archiveNetwork = state;
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const match = url.pathname.match(/\/session\/([^/]+)\/(abort|prompt_async|command|shell)$/);
      const metadata = request.method === "PATCH" ? url.pathname.match(/\/session\/([^/]+)$/) : null;
      const record: ArchiveRequest | null = match && request.method === "POST"
        ? { path: url.pathname, sessionId: match[1], action: match[2], messageID: null, result: null }
        : metadata ? { path: url.pathname, sessionId: metadata[1], action: "metadata", messageID: null, result: null } : null;
      if (record && ["prompt_async", "command"].includes(record.action)) {
        const body: unknown = await request.clone().json();
        if (body && typeof body === "object" && "messageID" in body && typeof body.messageID === "string") record.messageID = body.messageID;
        if (record.action === "command" && body && typeof body === "object" && "command" in body && typeof body.command === "string"
          && "arguments" in body && typeof body.arguments === "string") {
          record.command = { name: body.command, arguments: body.arguments,
            model: "model" in body && typeof body.model === "string" ? body.model : null,
            agent: "agent" in body && typeof body.agent === "string" ? body.agent : null };
        }
      }
      if (record) state.requests.push(record);
      const owner = url.pathname.startsWith("/workspace/" + encodeURIComponent(state.workspaceId) + "/opencode/");
      const target = owner && record?.sessionId === state.sessionId;
      if (record?.action === "metadata" && target && state.mode === "hold_archive") {
        await new Promise<void>(resolve => { state.release = resolve; });
        state.release = null;
      }
      if (record?.action === "command" && target && state.mode === "accepted_command") {
        record.result = "accepted, not dispatched";
        const admitted = new Request(request, { signal: new AbortController().signal });
        state.release = async () => {
          state.release = null;
          try {
            const response = await original(admitted);
            record.result = response.status;
            record.responseBody = (await response.text()).slice(0, 2000);
            if (!response.ok) throw new Error("Admitted command dispatch failed: " + response.status + " " + record.responseBody);
          } catch (error) {
            record.dispatchError = error instanceof Error ? error.message : String(error);
            throw error;
          }
        };
        return Response.json({ ok: true, accepted: true });
      }
      if (record?.action === "prompt_async" && target && state.mode === "prompt_error") {
        record.result = 400;
        return Response.json({ error: "Injected send failure" }, { status: 400 });
      }
      if (record?.action === "prompt_async" && target && state.mode === "hold_prompt") {
        await new Promise<void>(resolve => { state.release = resolve; });
        state.release = null;
        record.result = 400;
        return Response.json({ error: "Injected delayed queue send failure" }, { status: 400 });
      }
      if (record?.action === "abort" && target && ["false", "error", "timeout", "unconfirmed", "hold"].includes(state.mode)) {
        const mode = state.mode;
        if (mode === "hold" || mode === "timeout") {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { state.release = null; record.result = "cancelled"; reject(request.signal.reason); };
            state.release = () => {
              request.signal.removeEventListener("abort", abort);
              state.release = null;
              if (state.mode === "hold") state.mode = "none";
              resolve();
            };
            if (request.signal.aborted) abort();
            else request.signal.addEventListener("abort", abort, { once: true });
          });
        } else {
          record.result = mode;
          if (mode === "error") throw new TypeError("Injected abort connection failure");
          return Response.json(mode === "unconfirmed");
        }
      }
      const response = await original(request);
      if (record) record.result = response.status;
      // Merge only the owning endpoint's target. All unrelated statuses and
      // approvals remain authoritative, including concurrently running sessions.
      const { mode, sessionId, workspaceId } = state;
      const owningResponse = url.pathname.startsWith("/workspace/" + encodeURIComponent(workspaceId) + "/opencode/");
      const stillArmed = () => state.mode === mode && state.sessionId === sessionId && state.workspaceId === workspaceId;
      if (owningResponse && response.ok && mode === "retry" && url.pathname.endsWith("/session/status")) {
        const statuses: Record<string, unknown> = await response.clone().json();
        if (!stillArmed()) return response;
        return Response.json({ ...statuses, [sessionId]: { type: "retry", attempt: 1, message: "Retrying", next: Date.now() + 60000 } });
      }
      if (owningResponse && response.ok && (mode === "permission" || mode === "question") && url.pathname.endsWith("/opencode/" + mode)) {
        const requests: unknown[] = await response.clone().json();
        if (!stillArmed()) return response;
        return Response.json([...requests, { id: "archive-pending-request", sessionID: sessionId,
          permission: "bash", patterns: ["*"], metadata: {}, always: [],
          questions: [{ question: "Continue?", header: "Continue", options: [{ label: "Yes", description: "Continue" }] }],
        }]);
      }
      return response;
    };
    return true;
  });

  async function networkFault(mode: ArchiveFault, sessionId: string) {
    const target = [a1, a2, b1, child, faultCandidate].find(session => session.sessionId === sessionId);
    if (!target) throw new Error("Archive fault target has no known workspace owner");
    await seed.evalIn(app, browserScript((mode, sessionId, workspaceId) => {
      if (window.__archiveNetwork.release) throw new Error("Release the previous archive fault before replacing it");
      window.__archiveNetwork.mode = mode;
      window.__archiveNetwork.sessionId = sessionId;
      window.__archiveNetwork.workspaceId = workspaceId;
      return true;
    }, [mode, sessionId, target.workspaceId]));
  }

  async function facts() {
    const result = await seed.evalIn(app, browserScript(async (workspaceIds) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const headers = { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken) };
      const sessions = [];
      // Assertions use real engine facts, never our injected fault response.
      const read = window.__archiveNetwork.original;
      for (const workspaceId of workspaceIds) {
        const base = info.baseUrl.replace(/\/+$/, "") + "/workspace/" + workspaceId + "/opencode";
        const [list, statuses] = await Promise.all([
          read(base + "/session?limit=200", { headers, signal: AbortSignal.timeout(10000) }).then(r => { if (!r.ok) throw new Error("Session list: " + r.status); return r.json(); }),
          read(base + "/session/status", { headers, signal: AbortSignal.timeout(10000) }).then(r => { if (!r.ok) throw new Error("Session status: " + r.status); return r.json(); }),
        ]);
        for (const session of list) sessions.push({ workspaceId, sessionId: session.id,
          archived: (session.time?.archived ?? 0) > 0, status: statuses[session.id]?.type ?? "idle" });
      }
      return {
        sessions,
        requests: window.__archiveNetwork.requests,
        surfaces: [...document.querySelectorAll("[data-session-surface-id]")].map(el => el.getAttribute("data-session-surface-id")),
        activeRows: [...document.querySelectorAll("[data-sidebar-workspace-id] [data-sidebar-session-id]")].map(el => el.getAttribute("data-sidebar-session-id")),
        tabs: window.__openworkControl.context().conversations.tabs.map(tab => tab.sessionId),
        memory: JSON.parse(localStorage.getItem("openwork.react.sessionByWorkspace") ?? "{}"),
      };
    }, [[workspaceA.workspaceId, workspaceB.workspaceId]]), { timeoutMs: 30_000 });
    if (!isRecord(result) || !Array.isArray(result.sessions) || !Array.isArray(result.requests)
      || !Array.isArray(result.surfaces) || !Array.isArray(result.activeRows) || !Array.isArray(result.tabs) || !isRecord(result.memory)) {
      throw new Error(`Malformed archive facts: ${JSON.stringify(result)}`);
    }
    const sessions = result.sessions.map((entry) => {
      if (!isRecord(entry) || typeof entry.workspaceId !== "string" || typeof entry.sessionId !== "string"
        || typeof entry.archived !== "boolean" || typeof entry.status !== "string") throw new Error("Malformed archive session");
      return { workspaceId: entry.workspaceId, sessionId: entry.sessionId, archived: entry.archived, status: entry.status };
    });
    const requests = result.requests.map((entry) => {
      if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.sessionId !== "string"
        || typeof entry.action !== "string") throw new Error("Malformed archive request");
      return { path: entry.path, sessionId: entry.sessionId, action: entry.action, result: entry.result, messageID: entry.messageID,
        command: entry.command, responseBody: entry.responseBody, dispatchError: entry.dispatchError };
    });
    return { sessions, requests, surfaces: result.surfaces, activeRows: result.activeRows, tabs: result.tabs, memory: result.memory };
  }

  const paletteShortcut = await seed.evalIn(app, () => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+K" : "Control+K");
  const lifetime = resources.move();
  return {
    app,
    workspaceA,
    workspaceB,
    a1,
    a2,
    b1,
    child,
    faultCandidate,
    workspaceBName,
    commandSetup,
    paletteShortcut,
    facts,
    networkFault,
    faultObservation: () => seed.evalIn(app, browserScript(async (workspaceIds) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const root = info.baseUrl.replace(/\/+$/, "");
      const results = [];
      for (const workspaceId of workspaceIds) {
        for (const endpoint of ["session/status", "permission", "question"]) {
          const url = `${root}/workspace/${workspaceId}/opencode/${endpoint}`;
          const options = { headers: { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken) }, signal: AbortSignal.timeout(10000) };
          const [actual, observed] = await Promise.all([window.__archiveNetwork.original(url, options), fetch(url, options)]);
          if (!actual.ok || !observed.ok) throw new Error(`Fault observation failed for ${endpoint}`);
          results.push({ workspaceId, endpoint, actual: await actual.json(), observed: await observed.json() });
        }
      }
      return results;
    }, [[workspaceA.workspaceId, workspaceB.workspaceId]]), { timeoutMs: 30_000 }),
    diagnostics: () => seed.evalIn(app, () => ({
      hash: location.hash,
      fault: { mode: window.__archiveNetwork.mode, sessionId: window.__archiveNetwork.sessionId, workspaceId: window.__archiveNetwork.workspaceId, held: window.__archiveNetwork.release !== null },
      composer: window.__openwork?.slice("composer"),
      events: window.__openwork?.events(80),
      drafts: localStorage.getItem("openwork.session-drafts.v2"),
      surfaces: [...document.querySelectorAll<HTMLElement>("[data-session-surface-id]")].map(surface => ({
        sessionId: surface.dataset.sessionSurfaceId,
        text: surface.innerText.slice(-6000),
        draft: surface.querySelector<HTMLElement>('[data-lexical-editor="true"]')?.innerText,
      })),
      actions: window.__openworkControl.listActions().filter(action => action.id.startsWith("composer.")).map(action => ({ id: action.id, disabled: action.disabled })),
      requests: window.__archiveNetwork.requests,
    })),
    surfaceReady: (sessionId: string) => seed.evalIn(app, browserScript((sessionId) => {
      const surface = document.querySelector<HTMLElement>(`[data-session-surface-id="${sessionId}"]`);
      const snapshot = window.__openwork?.slice("composer")?.snapshotQuery;
      return Boolean(surface?.getClientRects().length && surface.querySelector('[data-lexical-editor="true"][contenteditable="true"]'))
        && snapshot?.intendedSessionId === sessionId && snapshot.currentSnapshotId === sessionId;
    }, [sessionId])),
    undoToastSettled: () => seed.evalIn(app, () => {
      const toast = document.querySelector("[data-undo-toast]")?.closest("[data-sonner-toast]");
      return toast instanceof HTMLElement && toast.dataset.mounted === "true"
        && toast.getAnimations({ subtree: true }).every(animation => animation.playState !== "running");
    }),
    dispatchUnrelatedPrompt: (session: { workspaceId: string; sessionId: string }) => seed.evalIn(app, browserScript(async (session, providerID, modelID) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const response = await fetch(`${info.baseUrl.replace(/\/+$/, "")}/workspace/${session.workspaceId}/opencode/session/${session.sessionId}/prompt_async`, {
        method: "POST", headers: { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken), "Content-Type": "application/json" },
        body: JSON.stringify({ model: { providerID, modelID }, parts: [{ type: "text", text: "An independently submitted task, not the accepted command." }] }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Independent prompt rejected: " + response.status);
      return true;
    }, [session, providerId, modelId]), { timeoutMs: 20_000 }),
    releaseAbort: () => seed.evalIn(app, async () => {
      if (!window.__archiveNetwork.release) throw new Error("No pending archive request to release");
      await window.__archiveNetwork.release();
      return true;
    }, { timeoutMs: 30_000 }),
    requests: async () => (await mock.agentRequests()).filter(request => request.kind !== "utility"),
    releaseRun: () => setHeld(false),
    holdRun: () => setHeld(true),
    transcript: (session: { workspaceId: string; sessionId: string }) => seed.evalIn(app, browserScript(async (workspaceId, sessionId) => {
      const info = await window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo");
      if (!info.running || !info.baseUrl) throw new Error("Archive engine is unavailable");
      const response = await window.__archiveNetwork.original(info.baseUrl.replace(/\/+$/, "") + "/workspace/" + workspaceId + "/opencode/session/" + sessionId + "/message", {
        headers: { Authorization: "Bearer " + (info.ownerToken ?? info.clientToken) }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Could not read transcript: " + response.status);
      const messages: { info: { id: string; sessionID: string; role: string; parentID?: string; time: { completed?: number }; finish?: string; error?: unknown }; parts: { type: string; text?: string; state?: { status: string } }[] }[] = await response.json();
      return messages.map(({ info, parts }) => ({ id: info.id, sessionId: info.sessionID, role: info.role, parentID: info.parentID ?? null,
        completed: info.time.completed ?? null, finish: info.finish ?? null, error: info.error ?? null,
        pendingTools: parts.some(p => p.type === "tool" && (p.state?.status === "pending" || p.state?.status === "running")),
        text: parts.filter(p => p.type === "text").map(p => p.text).join("\n") }));
    }, [session.workspaceId, session.sessionId]), { timeoutMs: 20_000 }),
    async [Symbol.asyncDispose]() { await lifetime.disposeAsync(); },
  };
}

export async function archiveSessions(seed: Seed) {
  const app = await seed.desktop({ name: "session-archive-undo" });
  return archiveWorld(seed, app, seed.tmpPath("session-archive-undo"), ["Archive candidate", "Archive neighbor"]);
}

/**
 * Archive in a workspace the desktop stores by a linked path. The folder does
 * not exist when the workspace is added, so the desktop keeps the path as
 * given (`<root>/link/OpenWork Chat`) while the engine resolves it and stamps
 * every session with the real path (`<root>/real/OpenWork Chat`) — the shape a
 * fresh macOS profile has under `/var` -> `/private/var`.
 */
export async function archiveSessionsInLinkedWorkspace(seed: Seed) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("Archive is unavailable in the v2 preview; session-archive-undo covers that.");
  const app = await seed.desktop({ name: "session-archive-linked-path" });
  const root = seed.tmpPath("session-archive-linked");
  const real = `${root}/real`;
  const link = `${root}/link`;
  // The real parent as the app host resolves it; `seed.tmpPath` itself may sit behind a symlink (macOS /tmp).
  let resolvedReal: string;
  if (app.handle.sandboxId) {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const script = `mkdir -p ${quote(real)} && ln -sfn ${quote(real)} ${quote(link)} && readlink -f ${quote(real)}`;
    const result = await execInSandbox(defaultDaytonaExec, app.handle.sandboxId, `printf %s ${Buffer.from(script).toString("base64")} | base64 -d | bash`, { timeoutMs: 15_000, context: "Arrange the linked workspace parent" });
    resolvedReal = result.stdout.trim();
    if (result.code !== 0 || !resolvedReal.startsWith("/")) throw new Error(`Linked workspace parent arrangement failed: ${result.stderr || result.stdout}`);
  } else {
    await mkdir(real, { recursive: true });
    await symlink(real, link);
    resolvedReal = await realpath(real);
  }
  const world = await archiveWorld(seed, app, `${link}/OpenWork Chat`, ["Split pane conversation", "Other pane"], { create: true });
  return {
    ...world,
    realWorkspacePath: `${resolvedReal}/OpenWork Chat`,
    /** The path the desktop persisted for the workspace, exactly as it will address the engine. */
    storedWorkspacePath: async () => {
      const value = await seed.evalIn(app, browserScript((workspaceId) =>
        window.__openwork?.slice?.("route")?.workspaces?.find(item => item.id === workspaceId)?.path ?? null, [world.workspace.workspaceId]));
      if (typeof value !== "string") throw new Error(`Stored workspace path was malformed: ${JSON.stringify(value)}`);
      return value;
    },
    /** The directory the engine stamped on each session, read through the workspace mount. */
    engineDirectories: async (): Promise<Record<string, string>> => {
      const value = await seed.evalIn(app, browserScript(async (workspaceId) => {
        const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
        if (!info?.running || !info.baseUrl) throw new Error("OpenWork server is unavailable");
        const response = await fetch(`${String(info.baseUrl).replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/opencode/session?limit=200`, {
          headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") }, signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw new Error("Workspace session listing failed with HTTP " + response.status);
        const sessions = await response.json();
        if (!Array.isArray(sessions)) throw new Error("Workspace session listing was not an array");
        return Object.fromEntries(sessions.filter((session) => typeof session?.id === "string" && typeof session?.directory === "string")
          .map((session) => [session.id, session.directory]));
      }, [world.workspace.workspaceId]), { awaitPromise: true, timeoutMs: 20_000 });
      if (!isRecord(value) || !Object.values(value).every((directory) => typeof directory === "string")) {
        throw new Error(`Engine directories were malformed: ${JSON.stringify(value)}`);
      }
      return Object.fromEntries(Object.entries(value).map(([id, directory]) => [id, String(directory)]));
    },
    splitFacts: () => seed.evalIn(app, () => {
      const layout = window.__openworkControl?.context?.()?.conversations?.layout;
      return {
        primarySessionId: (layout?.kind === "split" ? layout.primarySessionId : undefined) ?? (layout?.kind === "single" ? layout.sessionId : undefined) ?? "",
        secondarySessionId: (layout?.kind === "split" ? layout.secondarySessionId : undefined) ?? "",
        secondaryPaneCount: document.querySelectorAll('[data-workbench-pane="secondary"]').length,
      };
    }),
  };
}

async function archiveWorld(seed: Seed, app: Surface, workspacePath: string, titles: [string, string], options: { create?: boolean } = {}) {
  const engine = resolveEvalEngine();
  const workspace = await seed.workspace(app, workspacePath, options);
  const [candidate, neighbor] = await seed.sessions(app, titles);
  if (!candidate || !neighbor) throw new Error("Archive world did not create both sessions.");
  await seed.evalIn(app, browserScript((workspaceId) => {
    const original = window.fetch.bind(window);
    window.__archiveAvailabilityRequests = [];
    window.fetch = async (input, init) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (path.startsWith(`/workspace/${workspaceId}/`)
        && ((request.method === "POST" && /\/(abort|interrupt)$/.test(path)) || (request.method === "PATCH" && /\/session\/[^/]+$/.test(path)))) {
        window.__archiveAvailabilityRequests.push({ method: request.method, path });
      }
      return original(request);
    };
    return true;
  }, [workspace.workspaceId]));

  /**
   * OpenCode's own `time.archived` stamp per session id (0 when active), read
   * through the workspace-scoped OpenWork server mount the desktop uses.
   */
  // TODO(primitive): probe.sessions should expose the workspace's native session list.
  async function archivedAt(): Promise<Record<string, number>> {
    const value = await seed.evalIn(app, browserScript(async (workspaceId, engine) => {
      const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
      if (!info?.running || !info.baseUrl) throw new Error("OpenWork server is unavailable");
      const response = await fetch(
        String(info.baseUrl).replace(/\/+$/, "") + "/workspace/" + encodeURIComponent(workspaceId) + (engine === "v2" ? "/opencode2/api/session?limit=200" : "/opencode/session?limit=200"),
        {
          headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error("Workspace session listing failed with HTTP " + response.status);
      const body = await response.json();
      const sessions = engine === "v2" ? body.data : body;
      if (!Array.isArray(sessions)) throw new Error("Workspace session listing was not an array");
      return Object.fromEntries(sessions
        .filter((session) => typeof session?.id === "string")
        .map((session) => [session.id, typeof session?.time?.archived === "number" ? session.time.archived : 0]));
    }, [workspace.workspaceId, engine]), { awaitPromise: true, timeoutMs: 20_000 });
    if (!isRecord(value)) throw new Error(`Workspace archived state was malformed: ${JSON.stringify(value)}`);
    const stamps: Record<string, number> = {};
    for (const [sessionId, stamp] of Object.entries(value)) {
      if (typeof stamp !== "number") throw new Error(`Archived stamp for ${sessionId} was malformed: ${JSON.stringify(stamp)}`);
      stamps[sessionId] = stamp;
    }
    return stamps;
  }

  /** Active rows, the global Archived section, and the candidate's own archive button. */
  // TODO(primitive): probe.sidebar should expose the workspace tree and the Archived section.
  async function sidebar(): Promise<{ active: string[]; archivedSection: boolean; archiveButtonDisabled: boolean | null; archiveButtonTitle: string | null }> {
    const value = await seed.evalIn(app, browserScript((workspaceId, candidateId) => {
      const tree = document.querySelector<HTMLElement>('[data-sidebar-workspace-id="' + workspaceId + '"]');
      const button = tree?.querySelector<HTMLButtonElement>(`[data-sidebar-session-id="${candidateId}"] button[data-testid="session-archive-${candidateId}"]`);
      return {
        active: [...(tree?.querySelectorAll<HTMLElement>("[data-sidebar-session-id]") ?? [])]
          .map((row) => row.getAttribute("data-sidebar-session-id")),
        archivedSection: Boolean(document.querySelector<HTMLElement>("[data-global-archived-sessions]")),
        archiveButtonDisabled: button?.disabled ?? null,
        archiveButtonTitle: button?.title ?? null,
      };
    }, [workspace.workspaceId, candidate.sessionId]));
    if (!isRecord(value)
      || !Array.isArray(value.active)
      || !value.active.every((sessionId) => typeof sessionId === "string")
      || typeof value.archivedSection !== "boolean"
      || (value.archiveButtonDisabled !== null && typeof value.archiveButtonDisabled !== "boolean")
      || (value.archiveButtonTitle !== null && typeof value.archiveButtonTitle !== "string")) {
      throw new Error(`Sidebar archive facts were malformed: ${JSON.stringify(value)}`);
    }
    return { active: value.active, archivedSection: value.archivedSection, archiveButtonDisabled: value.archiveButtonDisabled, archiveButtonTitle: value.archiveButtonTitle };
  }

  /** True once the undo pill is on screen and its slide-in has finished, i.e. when a person would reach for it. */
  // TODO(primitive): user.click should wait for a target's entrance animation to settle.
  async function undoToastSettled(): Promise<boolean> {
    const value = await seed.evalIn(app, () => {
      const pill = document.querySelector<HTMLElement>("[data-undo-toast]");
      const toast = pill?.closest("[data-sonner-toast]");
      if (!(toast instanceof HTMLElement)) return false;
      return toast.dataset.mounted === "true"
        && toast.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
    });
    return value === true;
  }

  return { app, engine, workspace, workspacePath, candidate, neighbor, archivedAt, sidebar, undoToastSettled,
    // The rename UI rejects blank input; arrange persisted legacy titles through the native API.
    setCandidateTitle: (title: string) => seed.evalIn(app, browserScript(async (workspaceId, sessionId, title) => {
      const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
      if (!info?.running || !info.baseUrl) throw new Error("OpenWork server is unavailable");
      const response = await fetch(`${info.baseUrl.replace(/\/+$/, "")}/workspace/${encodeURIComponent(workspaceId)}/opencode/session/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${info.ownerToken ?? info.clientToken ?? ""}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Setting fixture title failed with HTTP ${response.status}`);
      const session = await response.json();
      if (session.id !== sessionId || typeof session.title !== "string") throw new Error("Unexpected session title response");
      return session.title;
    }, [workspace.workspaceId, candidate.sessionId, title]), { awaitPromise: true, timeoutMs: 20_000 }),
    archiveToast: () => seed.evalIn(app, () => {
      const pill = document.querySelector<HTMLElement>("[data-undo-toast]");
      const message = pill?.querySelector("p");
      const bounds = pill?.getBoundingClientRect();
      return {
        text: message?.textContent,
        fullTitle: message?.querySelector("[title]")?.getAttribute("title"),
        truncated: Boolean(message && message.scrollWidth > message.clientWidth && getComputedStyle(message).textOverflow === "ellipsis"),
        fitsViewport: Boolean(bounds && bounds.left >= 0 && bounds.right <= window.innerWidth),
        actionsInside: Boolean(pill && bounds && [...pill.querySelectorAll("button")].every(button => {
          const action = button.getBoundingClientRect();
          return action.width > 0 && action.left >= bounds.left && action.right <= bounds.right;
        })),
      };
    }),
    hoverArchiveButton: async () => {
      // Disabled buttons reject pointer hits; hover their visible bounds without clicking.
      const button = await waitForLocated(app, { testId: `session-archive-${candidate.sessionId}` }, { timeoutMs: 10_000 });
      await hoverAt(app, button.center);
    },
    mutationRequests: () => seed.evalIn(app, () => window.__archiveAvailabilityRequests),
  };
}

export async function responsiveSessions(seed: Seed) {
  const titles = ["Responsive primary chat", "Responsive split chat"];
  const world = await oneWorkspace(seed, "responsive-session-layout", titles);
  const [primary, secondary] = world.sessions;
  if (!primary || !secondary) throw new Error("Responsive world did not create both sessions.");
  // TODO(primitive): seed.desktop should accept an initial viewport for Electron surfaces.
  await world.app.client.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  return { ...world, primary, secondary };
}

export type SidebarRouteWorkspace = { id: string; name: string; loading: boolean; error: string | null };
export type SidebarRouteSession = { id: string; title: string };
export type SidebarRouteFacts = {
  selectedWorkspaceId: string;
  workspaces: SidebarRouteWorkspace[];
  sessionsByWorkspaceId: Record<string, SidebarRouteSession[]>;
};

function parseSidebarRouteFacts(value: unknown): SidebarRouteFacts {
  if (!isRecord(value) || typeof value.selectedWorkspaceId !== "string" || !Array.isArray(value.workspaces) || !isRecord(value.sessionsByWorkspaceId)) {
    throw new Error(`Route inspector slice was unavailable: ${JSON.stringify(value)}`);
  }
  const workspaces: SidebarRouteWorkspace[] = [];
  for (const workspace of value.workspaces) {
    if (!isRecord(workspace) || typeof workspace.id !== "string" || typeof workspace.name !== "string" || typeof workspace.loading !== "boolean") {
      throw new Error(`Route inspector workspace was invalid: ${JSON.stringify(workspace)}`);
    }
    workspaces.push({
      id: workspace.id,
      name: workspace.name,
      loading: workspace.loading,
      error: typeof workspace.error === "string" ? workspace.error : null,
    });
  }
  const sessionsByWorkspaceId: Record<string, SidebarRouteSession[]> = {};
  for (const [workspaceId, sessions] of Object.entries(value.sessionsByWorkspaceId)) {
    if (!Array.isArray(sessions)) throw new Error(`Route inspector sessions for ${workspaceId} were invalid: ${JSON.stringify(sessions)}`);
    sessionsByWorkspaceId[workspaceId] = sessions.map((session) => {
      if (!isRecord(session) || typeof session.id !== "string" || typeof session.title !== "string") {
        throw new Error(`Route inspector session was invalid: ${JSON.stringify(session)}`);
      }
      return { id: session.id, title: session.title };
    });
  }
  return { selectedWorkspaceId: value.selectedWorkspaceId, workspaces, sessionsByWorkspaceId };
}

/**
 * Two empty workspaces on one desktop. `other` is created last, which selects
 * it and expands its sidebar group; the group stays expanded after the spec
 * returns to `home`, so `other`'s rows keep rendering while it is not selected.
 */
export async function externalSessionVisibility(seed: Seed) {
  const app = await seed.desktop({ name: "sidebar-external-session-visibility" });
  const repoRoot = app.workspaceRoot;
  if (!repoRoot) throw new Error("External session visibility needs a spawned desktop with a known workspace root.");
  // Real checkout directories avoid conflating session-list freshness with a
  // missing-directory cold start in OpenCode.
  const homePath = `${repoRoot}/apps/app`;
  const otherPath = `${repoRoot}/apps/server`;
  const home = await seed.workspace(app, homePath);
  const other = await additionalWorkspace(seed, app, otherPath);
  const workspaceDirectories = new Map([
    [home.workspaceId, homePath],
    [other.workspaceId, otherPath],
  ]);
  // TODO(primitive): seed.desktop should accept an initial viewport for Electron surfaces.
  // The sidebar renders its workspace rows only on a desktop-width viewport.
  await app.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1_400,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  // These empty workspaces do not send prompts. Let the model catalog settle
  // and explicitly close its picker before testing sidebar clicks: the missing
  // default-model prompt can otherwise appear between hit-testing and clicking.
  await readAvailableModels(app);
  await seed.evalIn(app, () => {
    const close = document.querySelector<HTMLElement>('[data-slot="dialog-content"] [data-slot="dialog-close"]');
    if (!(close instanceof HTMLElement)) throw new Error("Model picker close control unavailable");
    close.click();
  });
  await waitFor(app, () => (!document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')), {
    timeoutMs: 30_000,
    label: "model picker backdrop dismissed before sidebar interaction",
  });
  const rawServerInfo = await seed.evalIn(app, () => (window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo")), {
    awaitPromise: true,
    timeoutMs: 30_000,
  });
  if (!isRecord(rawServerInfo) || typeof rawServerInfo.baseUrl !== "string") {
    throw new Error(`OpenWork server info was unavailable: ${JSON.stringify(rawServerInfo)}`);
  }
  const serverUrl = new URL(rawServerInfo.baseUrl);
  const serverToken = typeof rawServerInfo.ownerToken === "string"
    ? rawServerInfo.ownerToken
    : typeof rawServerInfo.clientToken === "string"
      ? rawServerInfo.clientToken
      : "";
  if (!serverToken) throw new Error("OpenWork server info did not include a token.");
  let externalServerUrl = serverUrl.origin;
  if (app.handle.hostKind === "daytona") {
    const sandboxId = app.handle.sandboxId?.trim();
    if (!sandboxId) throw new Error("Daytona desktop did not expose its sandbox id.");
    await using previewHost = daytonaSandbox(sandboxId);
    if (!previewHost.previewUrl) throw new Error("Daytona host cannot expose the OpenWork server port.");
    externalServerUrl = await previewHost.previewUrl(Number(serverUrl.port));
  }
  return {
    app,
    home,
    other,
    homePath,
    engine: resolveEvalEngine(),
    async observeSessionRequests(workspaceId: string, holdMetadataExcept?: readonly string[]) {
      const debuggerUrl = app.client.webSocketDebuggerUrl;
      if (!debuggerUrl) throw new Error("Session request witness needs a desktop CDP endpoint");
      const socket = new WebSocket(debuggerUrl);
      const ready = Promise.withResolvers<void>();
      const requests: { method: string; path: string; requestId: string; startedAt: number }[] = [];
      const prefixes = ["workspace", "w"].map((mount) => `/${mount}/${encodeURIComponent(workspaceId)}/opencode2/api/session`);
      const ended = new Set<string>();
      const commands = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
      let nextCommandId = 2;
      let held: { requestId: string; networkId: string; sessionId: string; startedAt: number } | undefined;
      let released = false;
      let holdTimeout: ReturnType<typeof setTimeout> | undefined;
      let failure: Error | undefined;
      let disposed = false;
      const command = async (method: string, params = {}) => {
        const id = nextCommandId++;
        const result = Promise.withResolvers<void>();
        commands.set(id, result);
        const timeout = setTimeout(() => result.reject(new Error(`Session request witness timed out: ${method}`)), 15_000);
        try {
          socket.send(JSON.stringify({ id, method, params }));
          await result.promise;
        } finally {
          clearTimeout(timeout);
          commands.delete(id);
        }
      };
      const releaseMetadata = async () => {
        if (!held || released) return;
        released = true;
        clearTimeout(holdTimeout);
        await command("Fetch.continueRequest", { requestId: held.requestId });
      };
      const fail = () => {
        if (disposed) return;
        failure = new Error("Session request witness lost its CDP connection");
        ready.reject(failure);
        for (const result of commands.values()) result.reject(failure);
      };
      const timeout = setTimeout(() => ready.reject(new Error("Session request witness did not become ready")), 15_000);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method: "Network.enable" })));
      socket.addEventListener("error", fail);
      socket.addEventListener("close", fail);
      socket.addEventListener("message", (event) => {
        const message: unknown = JSON.parse(String(event.data));
        if (!isRecord(message)) return;
        if (message.id === 1) {
          if (message.error) ready.reject(new Error("Session request witness could not enable Network events"));
          else ready.resolve();
        }
        const result = typeof message.id === "number" ? commands.get(message.id) : undefined;
        if (result) {
          if (message.error) result.reject(new Error(`Session request witness CDP command ${message.id} failed`));
          else result.resolve();
        }
        if (!isRecord(message.params)) return;
        if (["Network.responseReceived", "Network.loadingFinished", "Network.loadingFailed"].includes(String(message.method))
          && typeof message.params.requestId === "string") ended.add(message.params.requestId);
        if (message.method === "Fetch.requestPaused" && typeof message.params.requestId === "string") {
          const request = message.params.request;
          const networkId = message.params.networkId;
          const network = requests.find((item) => item.requestId === networkId);
          const prefix = network && prefixes.find((prefix) => network.path.startsWith(`${prefix}/`));
          const sessionId = prefix && network?.path.slice(prefix.length + 1);
          // One-shot hold; source reads and non-metadata traffic pass through.
          if (!held && holdMetadataExcept && isRecord(request) && request.method === "GET"
            && network && sessionId && !sessionId.includes("/") && !holdMetadataExcept.includes(decodeURIComponent(sessionId))) {
            held = { requestId: message.params.requestId, networkId: network.requestId, sessionId: decodeURIComponent(sessionId), startedAt: network.startedAt };
            // Fail closed at 1.5s, leaving headroom below the adapter's 2s abort.
            holdTimeout = setTimeout(() => void releaseMetadata().catch((error: Error) => { failure = error; }),
              Math.max(0, 1_500 - (performance.now() - held.startedAt)));
          } else {
            void command("Fetch.continueRequest", { requestId: message.params.requestId }).catch((error: Error) => { failure = error; });
          }
          return;
        }
        if (message.method !== "Network.requestWillBeSent") return;
        const request = message.params.request;
        if (!isRecord(request) || typeof request.url !== "string" || typeof request.method !== "string") return;
        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, "");
        if (url.origin !== serverUrl.origin || !prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return;
        if (typeof message.params.requestId !== "string") return;
        // Retain only identity/timing/method/path, never headers or bodies.
        requests.push({ method: request.method, path, requestId: message.params.requestId, startedAt: performance.now() });
      });
      try {
        await ready.promise;
        if (holdMetadataExcept) await command("Fetch.enable", {
          patterns: prefixes.map((prefix) => ({ urlPattern: `${serverUrl.origin}${prefix}/*`, requestStage: "Request" })),
        });
      } catch (error) {
        disposed = true;
        socket.close();
        throw error;
      } finally {
        clearTimeout(timeout);
      }
      return {
        snapshot() {
          if (failure) throw failure;
          return {
            lists: requests.filter((request) => request.method === "GET" && prefixes.includes(request.path)).length,
            reads: requests.filter((request) => request.method === "GET").map((request) => request.path),
            held: held ? {
              sessionId: held.sessionId,
              elapsedMs: performance.now() - held.startedAt,
              pending: !released && !ended.has(held.networkId),
            } : null,
          };
        },
        releaseMetadata,
        async [Symbol.asyncDispose]() {
          clearTimeout(holdTimeout);
          try {
            if (holdMetadataExcept) await command("Fetch.disable");
          } finally {
            disposed = true;
            socket.close();
          }
        },
      };
    },
    async observeWorkspaceEvents(workspaceId: string) {
      const abort = new AbortController();
      const url = new URL(`${externalServerUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode2/api/event`);
      // A client-supplied location must not override its authenticated mount.
      url.searchParams.set("location[directory]", workspaceId === home.workspaceId ? otherPath : homePath);
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${serverToken}` },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(120_000)]),
      });
      if (!response.ok || !response.body) throw new Error(`Workspace event stream returned ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let received = "";
      let failure: unknown;
      const finished = (async () => {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += decoder.decode(chunk.value, { stream: true });
          }
        } catch (error) {
          if (!abort.signal.aborted) failure = error;
        }
      })();
      return {
        snapshot() {
          if (failure) throw failure;
          return received;
        },
        async [Symbol.asyncDispose]() {
          abort.abort();
          await reader.cancel().catch(() => undefined);
          await finished;
        },
      };
    },
    async serverSessionIds(workspaceId: string): Promise<string[]> {
      const response = await engineSessionProbe({ engine: resolveEvalEngine(), serverUrl: externalServerUrl, token: serverToken, workspaceId }).list();
      if (!response.ok) throw new Error(`Session list returned HTTP ${response.status}`);
      return response.data.map((session) => session.id);
    },
    async forkSessionOutsideWindow(workspaceId: string, sessionId: string) {
      const base = `${externalServerUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode2/api/session/${encodeURIComponent(sessionId)}`;
      const request = async (path: string, body?: unknown): Promise<unknown> => {
        const response = await fetch(`${base}${path}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: `Bearer ${serverToken}`, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`External fork setup ${path} returned HTTP ${response.status}`);
        return response.status === 204 ? null : response.json();
      };
      // A settled native shell message supplies a fork boundary without a model.
      await request("/shell", { command: "printf 'External fork history\\n'" });
      const sourceBefore = { info: await request(""), history: await request("/export") };
      const response = await request("/fork", { boundary: { type: "through" } });
      if (!isRecord(response) || !isRecord(response.data) || typeof response.data.id !== "string" || typeof response.data.title !== "string") {
        throw new Error("Native fork did not return a complete session identity and title");
      }
      return {
        id: response.data.id,
        title: response.data.title,
        sourceBefore,
        sourceAfter: { info: await request(""), history: await request("/export") },
      };
    },
    /** The sidebar's own per-workspace session lists and load state. */
    // TODO(primitive): probe.route should expose the sidebar's per-workspace session lists.
    async route(): Promise<SidebarRouteFacts> {
      return parseSidebarRouteFacts(await seed.evalIn(app, () => {
        const route = window.__openwork?.slice?.("route");
        if (!route) return null;
        return {
          selectedWorkspaceId: String(route.selectedWorkspaceId ?? ""),
          workspaces: (route.workspaces ?? []).map((workspace) => ({
            id: String(workspace.id),
            name: String(workspace.displayNameResolved ?? ""),
            loading: Boolean(workspace.loading),
            error: typeof workspace.error === "string" ? workspace.error : null,
          })),
          sessionsByWorkspaceId: Object.fromEntries(Object.entries(route.sessionsByWorkspaceId ?? {}).map(([workspaceId, sessions]) => [
            workspaceId,
            (sessions ?? []).map((session) => ({ id: String(session?.id ?? ""), title: String(session?.title ?? "") })),
          ])),
        };
      }));
    },
    /**
     * Creates a session the way another client would: straight against the
     * OpenWork server's workspace mount, never through the desktop's UI state.
     */
    // TODO(primitive): seed.externalSession should create a session on the server without touching the renderer.
    async createSessionOutsideWindow(workspaceId: string, title: string, requestedDirectory?: string): Promise<string> {
      const directory = requestedDirectory ?? workspaceDirectories.get(workspaceId);
      if (!directory) throw new Error(`No directory is registered for workspace ${workspaceId}.`);
      const probe = engineSessionProbe({
        engine: resolveEvalEngine(),
        serverUrl: externalServerUrl,
        token: serverToken,
        workspaceId,
      });
      const findCreatedSession = async (): Promise<string | null> => {
        try {
          const response = await probe.list();
          return response.ok ? response.data.find((session) => session.title === title)?.id ?? null : null;
        } catch {
          return null;
        }
      };

      let lastError = "no response";
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const existing = await findCreatedSession();
        if (existing) return existing;
        try {
          const response = await probe.create(directory, title);
          if (response.ok && response.data) return response.data.id;
          lastError = `HTTP ${response.status}: ${JSON.stringify(response.body)}`;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        // A timed-out POST may have committed before its response was lost.
        // Check by unique title before the next non-idempotent attempt.
        const created = await findCreatedSession();
        if (created) return created;
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempt) * 1_000));
      }
      throw new Error(`Creating a session outside the window failed after 4 attempts: ${lastError}`);
    },
  };
}

export async function crossWorkspaceSessions(seed: Seed) {
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const app = await seed.desktop({ name: "cross-workspace-split-view" });
  const workspaceA = await seed.workspace(app, `/tmp/openwork-cross-workspace-split-${runId}-a`);
  const [primary, sameWorkspacePeer] = await seed.sessions(app, [
    `Primary workspace anchor ${runId}`,
    `Primary workspace peer ${runId}`,
  ]);
  const workspaceB = await additionalWorkspace(seed, app, `/tmp/openwork-cross-workspace-split-${runId}-b`);
  const [crossWorkspacePeer] = await seed.sessions(app, [`Secondary workspace peer ${runId}`]);
  if (!primary || !sameWorkspacePeer || !crossWorkspacePeer) throw new Error("Split world did not create all sessions.");
  return {
    app,
    workspaceA,
    workspaceB,
    primary: { ...primary, workspaceId: workspaceA.workspaceId },
    sameWorkspacePeer: { ...sameWorkspacePeer, workspaceId: workspaceA.workspaceId },
    crossWorkspacePeer: { ...crossWorkspacePeer, workspaceId: workspaceB.workspaceId },
  };
}

export async function settingsRuntime(seed: Seed) {
  const stamp = Date.now();
  const firstName = `openwork-session-settings-a-${stamp}`;
  const secondName = `openwork-session-settings-b-${stamp}`;
  const app = await seed.desktop({ name: "session-switch-settings-runtime" });
  const firstWorkspace = await seed.workspace(app, `/tmp/${firstName}`);
  const secondWorkspace = await additionalWorkspace(seed, app, `/tmp/${secondName}`);
  // TODO(primitive): seed.runtimeErrorCapture should install a scoped renderer error witness.
  await seed.evalIn(app, () => {
    window.__sessionSettingsRuntimeErrors = [];
    window.addEventListener("error", (event) => window.__sessionSettingsRuntimeErrors.push(String(event.error?.message ?? event.message ?? "window error")));
    window.addEventListener("unhandledrejection", (event) => window.__sessionSettingsRuntimeErrors.push(String(event.reason?.message ?? event.reason ?? "unhandled rejection")));
    return true;
  });
  return { app, firstWorkspace, secondWorkspace, firstName, secondName };
}

export async function macSidebar(seed: Seed) {
  const world = await oneWorkspace(seed, "mac-sidebar-toggle-clearance", ["Mac sidebar clearance"]);
  return world;
}

export async function rendererCrash(seed: Seed) {
  const app = await seed.desktop({ name: "desktop-renderer-crash-recovery" });
  return { app };
}

export async function renderCycle(seed: Seed, { place }: { place: import("@openwork/env").Place }) {
  // TODO(primitive): seed.desktop should accept environment overrides for instrumented renderer launches.
  const app = await launchDesktop({
    name: "desktop-render-cycle-stability",
    host: place.host(),
    env: { VITE_OPENWORK_PROFILER: "1" },
  });
  const workspacePath = seed.tmpPath("desktop-render-cycle");
  await mkdir(workspacePath, { recursive: true });
  // TODO(primitive): seed.storage should arrange persisted renderer preferences without raw evaluation.
  await seed.evalIn(app, () => {
    localStorage.setItem("openwork.debug.profilerOverlay", "1");
    location.reload();
    return true;
  }).catch(() => undefined);
  return {
    app,
    workspacePath,
    async [Symbol.asyncDispose]() {
      try {
        await app[Symbol.asyncDispose]();
      } finally {
        await rm(workspacePath, { recursive: true, force: true });
      }
    },
  };
}

export async function loadingIdle(seed: Seed) {
  const providerId = "session-loading-idle-mock";
  const modelId = "session-loading-idle-model";
  const reply = "session loading idle proof";
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      request.resume();
      request.on("end", () => setTimeout(() => streamReply(response, "chatcmpl-session-loading-idle", reply), 8_000));
      return;
    }
    response.writeHead(404).end();
  });
  const baseUrl = await listen(server);
  try {
    const world = await oneWorkspace(seed, "session-loading-idle");
    await configureWorkspaceProvider(seed, world.app, [world.workspace.workspaceId], {
      providerId,
      modelId,
      modelName: "Session loading idle model",
      baseUrl,
    });
    const parking = await seed.session(world.app, { title: "Parking session" });
    const main = await seed.session(world.app, { title: "Main loading session" });
    return {
      ...world,
      parking,
      main,
      reply,
      renamedTitle: "Session loading stays idle",
      async [Symbol.asyncDispose]() {
        await closeServer(server);
      },
    };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

export async function titleFailure(seed: Seed) {
  const providerId = "session-title-failure-mock";
  const modelId = "session-title-main-model";
  const inaccessibleTitleModelId = "session-title-inaccessible-model";
  const reply = "the conversation completes safely";
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        if (body.includes(`\"model\":\"${inaccessibleTitleModelId}\"`)) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "model is not accessible to this user" } }));
          return;
        }
        streamReply(response, "chatcmpl-session-title-failure", reply);
      });
      return;
    }
    response.writeHead(404).end();
  });
  const baseUrl = await listen(server);
  try {
    const world = await oneWorkspace(seed, "session-title-failure-warning");
    await configureWorkspaceProvider(seed, world.app, [world.workspace.workspaceId], {
      providerId,
      modelId,
      modelName: "Session title main model",
      baseUrl,
      smallModel: `${providerId}/${inaccessibleTitleModelId}`,
    });
    const session = await seed.session(world.app);
    return {
      ...world,
      session,
      reply,
      warningTitle: "Automatic task title did not complete",
      warningBody: "Your conversation is safe.",
      async [Symbol.asyncDispose]() {
        await closeServer(server);
      },
    };
  } catch (error) {
    await closeServer(server);
    throw error;
  }
}

function stormMinutes(): number {
  const value = Number(process.env.OPENWORK_EVAL_ACTIVE_SESSION_STORM_MINUTES ?? "2");
  if (!Number.isFinite(value) || value < 1 || value > 5) {
    throw new Error("OPENWORK_EVAL_ACTIVE_SESSION_STORM_MINUTES must be a number from 1 through 5.");
  }
  return value;
}

function shellValue(value: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) throw new Error(`Unsafe workload shell value: ${value}`);
  return value;
}

export async function activeSessionStorm(seed: Seed) {
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const slowToolMs = Math.round(stormMinutes() * 60_000);
  const plans = Array.from({ length: 3 }, (_, offset) => {
    const index = offset + 1;
    const path = `/tmp/openwork-active-session-storm-${runId}-w${index}`;
    const marker = `STORM-W${index}-${runId}`;
    return {
      index,
      path,
      filePath: `${path}/storm-output-w${index}.txt`,
      marker,
      slowMarker: `SLOW-${marker}`,
      easyMarker: `EASY-${marker}`,
      finalReply: `COMPLETE-${marker}`,
    };
  });
  const mock = seed.mock({
    agentWorkloads: plans.map((plan) => ({
      promptMarker: plan.marker,
      finalReply: plan.finalReply,
      steps: [
        { tool: "bash", arguments: { command: `printf '%s\\n' 'INITIAL-${shellValue(plan.marker)}' > '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Create workspace ${plan.index} output` } },
        { tool: "bash", arguments: { command: `cat '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Read workspace ${plan.index} initial output` } },
        { tool: "bash", arguments: { command: `sleep ${Math.ceil(slowToolMs / 1_000)} && printf '%s\\n' '${shellValue(plan.slowMarker)}' >> '${shellValue(plan.filePath)}'`, timeout: slowToolMs + 30_000, workdir: plan.path, description: `Hold workspace ${plan.index} live` } },
        { tool: "bash", arguments: { command: `cat '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Read workspace ${plan.index} slow output` } },
        { tool: "bash", arguments: { command: `printf '%s\\n' '${shellValue(plan.easyMarker)}' >> '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Append workspace ${plan.index} easy marker` } },
        { tool: "bash", arguments: { command: `cat '${shellValue(plan.filePath)}'`, timeout: 30_000, workdir: plan.path, description: `Read workspace ${plan.index} completed output` } },
      ],
    })),
  });
  const den = await seed.den({
    mocks: { agent: mock },
    org: {
      name: "Active Session Workspace Storm",
      admin: { name: "Storm Admin" },
      members: { member: { name: "Storm Member" } },
    },
  });
  const app = await seed.desktop({
    den,
    as: "member",
    profileDir: process.env.OPENWORK_EVAL_ACTIVE_SESSION_STORM_PROFILE_DIR?.trim(),
  });
  const seededPlans: StormPlan[] = [];
  for (const plan of plans) {
    const workspace = seededPlans.length === 0
      ? await seed.workspace(app, plan.path)
      : await additionalWorkspace(seed, app, plan.path);
    const session = await seed.session(app, { title: `Active storm workspace ${plan.index}` });
    seededPlans.push({ ...plan, ...workspace, ...session });
  }
  await configureWorkspaceProvider(seed, app, seededPlans.map((plan) => plan.workspaceId), {
    providerId: stormProviderId,
    modelId: stormModelId,
    modelName: "Active session storm model",
    baseUrl: `${den.mocks.agent.url}/v1`,
    allowTools: true,
  });
  await seed.evalIn(app, () => { location.reload(); return true; }).catch(() => undefined);
  const reloadDeadline = Date.now() + 60_000;
  while (Date.now() < reloadDeadline) {
    const ready = await seed.evalIn(app, () => (Boolean(window.__openworkControl)
      && Boolean((localStorage.getItem("openwork.den.authToken") ?? "").trim())))
      .catch(() => false);
    if (ready === true) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return {
    app,
    den,
    mock: den.mocks.agent,
    plans: seededPlans,
    slowToolMs,
    routeStormMs: Math.min(60_000, Math.max(35_000, slowToolMs - 25_000)),
  };
}

export async function workspaceOrder(seed: Seed) {
  const profileDir = seed.tmpPath("workspace-sidebar-order-profile");
  const seededApp = await seed.desktop({ name: "workspace-order-seed", profileDir });
  const seededWorkspaceIds: string[] = [];
  for (const label of ["alpha", "beta", "gamma"]) {
    const workspace = seededWorkspaceIds.length === 0
      ? await seed.workspace(seededApp, `${profileDir}/${label}`)
      : await additionalWorkspace(seed, seededApp, `${profileDir}/${label}`);
    seededWorkspaceIds.push(workspace.workspaceId);
  }
  await seededApp[Symbol.asyncDispose]();
  const app = await seed.desktop({ name: "workspace-sidebar-order", profileDir });
  return { app, profileDir, seededWorkspaceIds };
}
