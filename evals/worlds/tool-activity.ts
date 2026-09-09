import { addInitScript, browserScript, evaluate, type Surface } from "@openwork/cdp";
import { resolveEvalEngine, type Seed } from "@openwork/env";
import type { MockAgentWorkload, MockMcpHandle } from "@openwork/labs";
import { configureProvider } from "./chat.ts";

const HISTORY_CALLS = 24;
const HISTORY_LINES_PER_CALL = 3;
const ROOT_STARTED = ".tool-long-root-started.txt";
const ROOT_RELEASE = ".tool-long-root-release.txt";
const ROOT_FINISHED = ".tool-long-root-finished.txt";
const OTHER_STARTED = ".tool-long-other-started.txt";
const OTHER_RELEASE = ".tool-long-other-release.txt";
const OTHER_FINISHED = ".tool-long-other-finished.txt";
const CHILD_STARTED = ".child-live-started.txt";
const CHILD_RELEASE = ".child-live-release.txt";
const CHILD_FINISHED = ".child-live-finished.txt";
const CHILD_OTHER_STARTED = ".child-live-other-started.txt";
const CHILD_OTHER_RELEASE = ".child-live-other-release.txt";
const CHILD_OTHER_FINISHED = ".child-live-other-finished.txt";

export type NativeToolFact = {
  callId: string;
  name: string;
  status: string;
  input: string;
  output: string;
  error: string;
  cancelled: boolean;
  metadata: Record<string, unknown>;
  rawState: Record<string, unknown>;
  startedAt: number | null;
  completedAt: number | null;
};

export type NativeAssistantFact = {
  id: string;
  completed: boolean;
  text: string;
  tools: NativeToolFact[];
};

export type ActivityObservation = {
  frames: number;
  mutations: number;
  nativePolls: number;
  nativeErrors: number;
  nativePollIntervalMs: number;
  lastNativeConfirmationAtMs: number | null;
  nativeConfirmationAgeMs: number | null;
  maxNativeConfirmationGapMs: number;
  selectedSamples: number;
  nativeActiveSamples: number;
  primaryActiveSamples: number;
  sidebarActiveSamples: number;
  nativeActiveForMs: number;
  primaryMissingMaxMs: number;
  primaryMissingCurrentMs: number;
  sidebarMissingMaxMs: number;
  sidebarMissingCurrentMs: number;
  primaryMissingIntervals: Array<{ startMs: number; durationMs: number }>;
  sidebarMissingIntervals: Array<{ startMs: number; durationMs: number }>;
  returnActionCaptured: boolean;
  returnSelectedMs: number | null;
  returnActivityMs: number | null;
  stopActionCaptured: boolean;
  stopFeedbackMs: number | null;
  rootInactiveMs: number | null;
  ownerToolTerminalMs: number | null;
  parentToolTerminalMs: number | null;
  nativeSettledMs: number | null;
  uiSettledMs: number | null;
  uiSettledAfterNativeMs: number | null;
  stoppingSeen: boolean;
  transitions: Array<{
    atMs: number;
    selected: boolean;
    nativeActive: boolean;
    primaryActive: boolean;
    sidebarActive: boolean;
    activity: string;
    label: string;
    toolStatus: string;
    parentToolStatus: string;
    nativeFresh: boolean;
    stopEnabled: boolean;
    stoppingVisible: boolean;
    stoppingBusy: boolean;
    activeAnimation: boolean;
  }>;
  current: {
    selected: boolean;
    nativeActive: boolean;
    rootActive: boolean;
    ownerActive: boolean;
    toolStatus: string;
    parentToolStatus: string;
    nativeFresh: boolean;
    primaryVisible: boolean;
    primaryActive: boolean;
    primaryCount: number;
    childSessionId: string;
    childSessionMatches: boolean;
    sidebarVisible: boolean;
    activity: string;
    label: string;
    stopVisible: boolean;
    stopEnabled: boolean;
    stoppingVisible: boolean;
    stoppingDisabled: boolean;
    stoppingBusy: boolean;
    activeAnimation: boolean;
    animationNames: string[];
    reducedMotion: boolean;
  };
};

type ActivityExpectation = {
  engine: "v1" | "v2";
  workspaceId: string;
  rootSessionId: string;
  ownerSessionId: string;
  ownerToolCallId: string;
  parentToolCallId?: string;
  uiCallId: string;
  kind: "tool" | "child";
};

declare global {
  interface Window {
    __toolActivityObservation?: { state: ActivityObservation; stop(): void };
    __toolPromptPosts?: {
      sessionId: string;
      posts: number;
      paths: string[];
      restore(): void;
    };
  }
}

function installActivityObservation(expected: ActivityExpectation): void {
  window.__toolActivityObservation?.stop();
  const startedAt = performance.now();
  const state: ActivityObservation = {
    frames: 0, mutations: 0, nativePolls: 0, nativeErrors: 0, nativePollIntervalMs: 200,
    lastNativeConfirmationAtMs: null, nativeConfirmationAgeMs: null, maxNativeConfirmationGapMs: 0,
    selectedSamples: 0, nativeActiveSamples: 0, primaryActiveSamples: 0, sidebarActiveSamples: 0,
    nativeActiveForMs: 0, primaryMissingMaxMs: 0, primaryMissingCurrentMs: 0,
    sidebarMissingMaxMs: 0, sidebarMissingCurrentMs: 0,
    primaryMissingIntervals: [], sidebarMissingIntervals: [],
    returnActionCaptured: false, returnSelectedMs: null, returnActivityMs: null,
    stopActionCaptured: false, stopFeedbackMs: null, rootInactiveMs: null, ownerToolTerminalMs: null, parentToolTerminalMs: null,
    nativeSettledMs: null, uiSettledMs: null, uiSettledAfterNativeMs: null, stoppingSeen: false,
    transitions: [],
    current: {
      selected: false, nativeActive: false, rootActive: false, ownerActive: false, toolStatus: "", parentToolStatus: "", nativeFresh: false,
      primaryVisible: false, primaryActive: false, primaryCount: 0, sidebarVisible: false,
      childSessionId: "", childSessionMatches: false,
      activity: "", label: "", stopVisible: false, stopEnabled: false,
      stoppingVisible: false, stoppingDisabled: false, stoppingBusy: false, activeAnimation: false,
      animationNames: [], reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    },
  };
  let frame = 0;
  let nativeActiveAt: number | null = null;
  let selectedAt: number | null = null;
  let firstSelectedAt: number | null = null;
  let primaryMissingAt: number | null = null;
  let sidebarMissingAt: number | null = null;
  let returnClickedAt: number | null = null;
  let stopClickedAt: number | null = null;
  let stopped = false;
  let polling = false;
  let pollTimer = 0;
  let rootActive = false;
  let ownerActive = false;
  let toolStatus = "";
  let parentToolStatus = "";
  let lastNativeConfirmationAt: number | null = null;
  let nativeSettledAt: number | null = null;
  const NATIVE_STALE_AFTER_MS = 1_000;

  const elapsed = () => performance.now() - startedAt;
  const visible = (node: HTMLElement | null): node is HTMLElement => {
    if (!node || node.getClientRects().length === 0) return false;
    const style = getComputedStyle(node);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
    let left = 0;
    let top = 0;
    let right = innerWidth;
    let bottom = innerHeight;
    const own = node.getBoundingClientRect();
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const parentStyle = getComputedStyle(parent);
      if (![parentStyle.overflow, parentStyle.overflowX, parentStyle.overflowY]
        .some((value) => value === "auto" || value === "scroll" || value === "hidden" || value === "clip")) continue;
      const rect = parent.getBoundingClientRect();
      left = Math.max(left, rect.left);
      top = Math.max(top, rect.top);
      right = Math.min(right, rect.right);
      bottom = Math.min(bottom, rect.bottom);
    }
    return own.right > left && own.left < right && own.bottom > top && own.top < bottom;
  };
  const closeMissing = (
    now: number,
    since: number | null,
    intervals: Array<{ startMs: number; durationMs: number }>,
    currentMax: number,
  ) => {
    if (since === null) return { since: null, max: currentMax, current: 0 };
    const duration = now - since;
    intervals.push({ startMs: since - startedAt, durationMs: duration });
    return { since: null, max: Math.max(currentMax, duration), current: 0 };
  };
  const updateMissing = (
    missing: boolean,
    now: number,
    since: number | null,
    intervals: Array<{ startMs: number; durationMs: number }>,
    currentMax: number,
  ) => {
    if (missing) {
      const nextSince = since ?? now;
      const current = now - nextSince;
      return { since: nextSince, max: Math.max(currentMax, current), current };
    }
    return closeMissing(now, since, intervals, currentMax);
  };
  const sample = () => {
    if (stopped) return;
    const now = performance.now();
    const pane = document.querySelector<HTMLElement>('[data-workbench-pane="primary"]');
    const surface = pane?.querySelector<HTMLElement>('[data-session-surface-id]') ?? null;
    const selected = surface?.dataset.sessionSurfaceId === expected.rootSessionId
      && surface.dataset.sessionSurfaceWorkspaceId === expected.workspaceId;
    if (selected) {
      selectedAt ??= now;
      firstSelectedAt ??= now;
      state.selectedSamples += 1;
    } else {
      selectedAt = null;
    }
    const selector = expected.kind === "tool"
      ? `[data-tool-aggregate="${CSS.escape(expected.uiCallId)}"]`
      : `[data-subagent-run="${CSS.escape(expected.uiCallId)}"]`;
    const primaryNodes = selected ? [...(pane?.querySelectorAll<HTMLElement>(selector) ?? [])] : [];
    const visiblePrimary = primaryNodes.filter(visible);
    const primary = visiblePrimary.at(-1) ?? null;
    const childSessionId = expected.kind === "child" ? primary?.dataset.subagentSessionId ?? "" : "";
    const activity = expected.kind === "tool"
      ? primary?.dataset.toolLifecycle ?? ""
      : primary?.dataset.subagentActivity ?? "";
    const explicitlyActive = expected.kind === "tool"
      ? activity === "running"
      : Boolean(activity) && !["completed", "failed", "stopped", "interrupted"].includes(activity);
    const primaryActive = visible(primary) && explicitlyActive;
    const row = document.querySelector<HTMLElement>(
      `[data-sidebar-session-id="${CSS.escape(expected.rootSessionId)}"][data-sidebar-session-workspace-id="${CSS.escape(expected.workspaceId)}"]`,
    );
    const sidebar = row?.querySelector<HTMLElement>("[data-session-loading-indicator]") ?? null;
    const sidebarVisible = visible(sidebar);
    const stop = selected ? [...(pane?.querySelectorAll<HTMLButtonElement>('button[aria-label="Stop"]') ?? [])].find(visible) ?? null : null;
    const stopping = selected ? [...(pane?.querySelectorAll<HTMLButtonElement>('button[aria-label="Stopping"]') ?? [])].find(visible) ?? null : null;
    const stoppingVisible = visible(stopping);
    const stoppingDisabled = Boolean(stopping && stopping.disabled);
    const stoppingBusy = stopping?.getAttribute("aria-busy") === "true";
    const shimmer = primary ? [...primary.querySelectorAll<HTMLElement>(".ow-text-shimmer")].filter(visible) : [];
    const animationNames = shimmer.map((node) => getComputedStyle(node).animationName).filter((name) => name && name !== "none");
    const activeAnimation = animationNames.length > 0 && shimmer.some((node) => getComputedStyle(node).animationPlayState === "running");
    const stopEnabled = Boolean(stop && !stop.disabled);
    const nativeConfirmationAgeMs = lastNativeConfirmationAt === null ? null : now - lastNativeConfirmationAt;
    const nativeFresh = nativeConfirmationAgeMs !== null && nativeConfirmationAgeMs <= NATIVE_STALE_AFTER_MS;
    const nativeActive = nativeFresh && rootActive && ownerActive && toolStatus === "running";
    state.nativeConfirmationAgeMs = nativeConfirmationAgeMs;
    if (nativeActive) {
      nativeActiveAt ??= now;
      state.nativeActiveSamples += 1;
      state.nativeActiveForMs = now - nativeActiveAt;
    } else {
      nativeActiveAt = null;
      state.nativeActiveForMs = 0;
    }
    if (primaryActive) state.primaryActiveSamples += 1;
    if (sidebarVisible) state.sidebarActiveSamples += 1;
    const selectedPastHandoff = selectedAt !== null && now - selectedAt >= 500;
    const nativePastHandoff = nativeActiveAt !== null && now - nativeActiveAt >= 500;
    const documentPastHandoff = firstSelectedAt !== null && now - firstSelectedAt >= 500;
    const primaryGap = updateMissing(nativeActive && selectedPastHandoff && !primaryActive, now,
      primaryMissingAt, state.primaryMissingIntervals, state.primaryMissingMaxMs);
    primaryMissingAt = primaryGap.since;
    state.primaryMissingMaxMs = primaryGap.max;
    state.primaryMissingCurrentMs = primaryGap.current;
    const sidebarGap = updateMissing(nativeActive && nativePastHandoff && documentPastHandoff && !sidebarVisible, now,
      sidebarMissingAt, state.sidebarMissingIntervals, state.sidebarMissingMaxMs);
    sidebarMissingAt = sidebarGap.since;
    state.sidebarMissingMaxMs = sidebarGap.max;
    state.sidebarMissingCurrentMs = sidebarGap.current;
    if (returnClickedAt !== null && selected && state.returnSelectedMs === null) state.returnSelectedMs = now - returnClickedAt;
    if (returnClickedAt !== null && primaryActive && state.returnActivityMs === null) state.returnActivityMs = now - returnClickedAt;
    if (stopClickedAt !== null) {
      if (stoppingVisible && stoppingDisabled && stoppingBusy) {
        state.stoppingSeen = true;
        state.stopFeedbackMs ??= now - stopClickedAt;
      }
      if (state.rootInactiveMs === null && !rootActive) state.rootInactiveMs = now - stopClickedAt;
      if (state.ownerToolTerminalMs === null && (toolStatus === "error" || toolStatus === "completed" || toolStatus === "cancelled")) {
        state.ownerToolTerminalMs = now - stopClickedAt;
      }
      if (state.parentToolTerminalMs === null && parentToolStatus
        && parentToolStatus !== "pending" && parentToolStatus !== "running" && parentToolStatus !== "streaming") {
        state.parentToolTerminalMs = now - stopClickedAt;
      }
      const nativeSettled = state.rootInactiveMs !== null && state.ownerToolTerminalMs !== null
        && (!expected.parentToolCallId || state.parentToolTerminalMs !== null);
      if (nativeSettled && nativeSettledAt === null) {
        nativeSettledAt = now;
        state.nativeSettledMs = now - stopClickedAt;
      }
      const settledAt = nativeSettledAt;
      const uiSettled = settledAt !== null && !stop && !stoppingVisible && !primaryActive && !activeAnimation;
      if (uiSettled && state.uiSettledMs === null) {
        state.uiSettledMs = now - stopClickedAt;
        state.uiSettledAfterNativeMs = now - settledAt;
      }
    }
    const label = primary?.innerText.trim().replace(/\s+/g, " ") ?? "";
    state.current = {
      selected, nativeActive, rootActive, ownerActive, toolStatus, parentToolStatus, nativeFresh,
      primaryVisible: visible(primary), primaryActive, primaryCount: visiblePrimary.length,
      childSessionId, childSessionMatches: expected.kind !== "child" || childSessionId === expected.ownerSessionId,
      sidebarVisible, activity, label, stopVisible: Boolean(stop), stopEnabled,
      stoppingVisible, stoppingDisabled, stoppingBusy,
      activeAnimation, animationNames, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
    const previous = state.transitions.at(-1);
    const signature = JSON.stringify({ selected, nativeActive, primaryActive, sidebarVisible, activity, label, toolStatus,
      parentToolStatus, stopEnabled, stoppingVisible, stoppingBusy, activeAnimation });
    const previousSignature = previous ? JSON.stringify({
      selected: previous.selected, nativeActive: previous.nativeActive, primaryActive: previous.primaryActive,
      sidebarVisible: previous.sidebarActive, activity: previous.activity, label: previous.label,
      toolStatus: previous.toolStatus, parentToolStatus: previous.parentToolStatus,
      stopEnabled: previous.stopEnabled, stoppingVisible: previous.stoppingVisible,
      stoppingBusy: previous.stoppingBusy, activeAnimation: previous.activeAnimation,
    }) : "";
    if (signature !== previousSignature && state.transitions.length < 80) {
      state.transitions.push({ atMs: elapsed(), selected, nativeActive, primaryActive, sidebarActive: sidebarVisible,
        activity, label, toolStatus, parentToolStatus, nativeFresh, stopEnabled, stoppingVisible, stoppingBusy, activeAnimation });
    }
  };
  const readJson = async (path: string): Promise<unknown> => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) throw new Error("local server credentials unavailable");
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return response.json();
  };
  const unwrap = (value: unknown): unknown => expected.engine === "v2" && value && typeof value === "object"
    ? Reflect.get(value, "data") : value;
  const active = (value: unknown, sessionId: string): boolean => Boolean(value && typeof value === "object" && Reflect.get(value, sessionId));
  const statusForCall = (value: unknown, wantedCallId: string): string => {
    const messages = Array.isArray(value) ? value : [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const parts = expected.engine === "v2" ? Reflect.get(message, "content") : Reflect.get(message, "parts");
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== "object" || Reflect.get(part, "type") !== "tool") continue;
        const callId = Reflect.get(part, expected.engine === "v2" ? "id" : "callID");
        if (callId !== wantedCallId) continue;
        const toolState = Reflect.get(part, "state");
        const status = toolState && typeof toolState === "object" ? Reflect.get(toolState, "status") : "";
        return typeof status === "string" ? status : "";
      }
    }
    return "";
  };
  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    const mount = `/workspace/${encodeURIComponent(expected.workspaceId)}/${expected.engine === "v2" ? "opencode2/api" : "opencode"}`;
    const statusPath = expected.engine === "v2" ? "/session/active" : "/session/status";
    const transcriptPath = (sessionId: string) => `/session/${encodeURIComponent(sessionId)}/${expected.engine === "v2" ? "context" : "message?limit=100"}`;
    try {
      const reads = [readJson(mount + statusPath), readJson(mount + transcriptPath(expected.ownerSessionId))];
      if (expected.parentToolCallId && expected.ownerSessionId !== expected.rootSessionId) {
        reads.push(readJson(mount + transcriptPath(expected.rootSessionId)));
      }
      const [rawActive, rawTranscript, rawParentTranscript] = await Promise.all(reads);
      const activeMap = unwrap(rawActive);
      rootActive = active(activeMap, expected.rootSessionId);
      ownerActive = expected.ownerSessionId === expected.rootSessionId ? rootActive : active(activeMap, expected.ownerSessionId);
      toolStatus = statusForCall(unwrap(rawTranscript), expected.ownerToolCallId);
      parentToolStatus = expected.parentToolCallId
        ? statusForCall(unwrap(rawParentTranscript ?? rawTranscript), expected.parentToolCallId) : "";
      const confirmedAt = performance.now();
      if (lastNativeConfirmationAt !== null) {
        state.maxNativeConfirmationGapMs = Math.max(state.maxNativeConfirmationGapMs, confirmedAt - lastNativeConfirmationAt);
      }
      lastNativeConfirmationAt = confirmedAt;
      state.lastNativeConfirmationAtMs = confirmedAt - startedAt;
      state.nativePolls += 1;
      sample();
    } catch {
      state.nativeErrors += 1;
    } finally {
      polling = false;
    }
  };
  const click = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const session = event.target.closest<HTMLElement>("[data-sidebar-session-id], [data-session-tab-id]");
    if (session && (session.dataset.sidebarSessionId === expected.rootSessionId || session.dataset.sessionTabId === expected.rootSessionId)) {
      returnClickedAt = performance.now();
      state.returnActionCaptured = true;
      state.returnSelectedMs = null;
      state.returnActivityMs = null;
    }
    const stop = event.target.closest<HTMLButtonElement>('button[aria-label="Stop"]');
    const owner = stop?.closest<HTMLElement>("[data-session-surface-id]");
    if (stop && stopClickedAt === null && owner?.dataset.sessionSurfaceId === expected.rootSessionId
      && owner.dataset.sessionSurfaceWorkspaceId === expected.workspaceId) {
      stopClickedAt = performance.now();
      state.stopActionCaptured = true;
      clearInterval(pollTimer);
      state.nativePollIntervalMs = 25;
      pollTimer = window.setInterval(() => { void poll(); }, 25);
    }
  };
  document.addEventListener("click", click, true);
  const mutations = new MutationObserver(() => { state.mutations += 1; sample(); });
  mutations.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  const paint = () => { state.frames += 1; sample(); frame = requestAnimationFrame(paint); };
  frame = requestAnimationFrame(paint);
  pollTimer = window.setInterval(() => { void poll(); }, state.nativePollIntervalMs);
  void poll();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    const now = performance.now();
    const primaryGap = closeMissing(now, primaryMissingAt, state.primaryMissingIntervals, state.primaryMissingMaxMs);
    state.primaryMissingMaxMs = primaryGap.max;
    const sidebarGap = closeMissing(now, sidebarMissingAt, state.sidebarMissingIntervals, state.sidebarMissingMaxMs);
    state.sidebarMissingMaxMs = sidebarGap.max;
    cancelAnimationFrame(frame);
    clearInterval(pollTimer);
    mutations.disconnect();
    document.removeEventListener("click", click, true);
  };
  window.__toolActivityObservation = { state, stop };
  sample();
}

export async function observeToolActivity(app: Surface, expected: ActivityExpectation) {
  const script = browserScript(installActivityObservation, [expected]);
  const registration = await addInitScript(app.client, script);
  await evaluate(app.client, script);
  let disposed = false;
  return {
    read: () => evaluate(app.client, () => {
      if (!window.__toolActivityObservation) throw new Error("Tool activity observer is unavailable in this document");
      return window.__toolActivityObservation.state;
    }),
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      await evaluate(app.client, () => { window.__toolActivityObservation?.stop(); delete window.__toolActivityObservation; });
      registration.dispose();
    },
  };
}

export async function observeSessionPromptPosts(app: Surface, sessionId: string) {
  await evaluate(app.client, browserScript((sessionId) => {
    window.__toolPromptPosts?.restore();
    const originalFetch = window.fetch.bind(window);
    const state: NonNullable<Window["__toolPromptPosts"]> = {
      sessionId,
      posts: 0,
      paths: [],
      restore() {
        window.fetch = originalFetch;
        delete window.__toolPromptPosts;
      },
    };
    window.fetch = async (input, init) => {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const path = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
      const match = method === "POST"
        ? path.match(/\/(?:opencode|opencode2\/api)\/session\/([^/]+)\/(?:prompt|prompt_async)$/)
        : null;
      if (match?.[1] && decodeURIComponent(match[1]) === sessionId) {
        state.posts += 1;
        state.paths.push(path);
      }
      return originalFetch(input, init);
    };
    window.__toolPromptPosts = state;
  }, [sessionId]));
  let disposed = false;
  return {
    read: () => evaluate(app.client, () => {
      const state = window.__toolPromptPosts;
      if (!state) throw new Error("Session prompt POST observer is unavailable");
      return { sessionId: state.sessionId, posts: state.posts, paths: [...state.paths] };
    }),
    async [Symbol.asyncDispose]() {
      if (disposed) return;
      disposed = true;
      await evaluate(app.client, () => { window.__toolPromptPosts?.restore(); });
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected a native engine object");
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a native engine list");
  return value.map(record);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function printable(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

function nativeToolOutput(state: Record<string, unknown>): string {
  if (state.output !== undefined) return printable(state.output);
  if (typeof state.result === "string") return state.result;
  if (!Array.isArray(state.content)) return printable(state.result);
  return state.content.flatMap((item) => isRecord(item) && item.type === "text" ? [text(item.text)] : []).join("\n");
}

function normalizeTranscript(value: unknown, engine: "v1" | "v2"): NativeAssistantFact[] {
  return records(value).flatMap((message) => {
    const info = engine === "v2" ? message : record(message.info);
    if (info[engine === "v2" ? "type" : "role"] !== "assistant") return [];
    const parts = records(engine === "v2" ? message.content : message.parts);
    return [{
      id: text(info.id),
      completed: typeof record(info.time).completed === "number",
      text: parts.filter((part) => part.type === "text").map((part) => text(part.text)).join(""),
      tools: parts.filter((part) => part.type === "tool").map((part) => {
        const state = record(part.state);
        const status = text(state.status);
        const output = nativeToolOutput(state);
        const error = printable(state.error ?? (status === "error" ? state.result : undefined));
        const metadata = isRecord(state.metadata) ? state.metadata : {};
        const partTime = isRecord(part.time) ? part.time : {};
        const stateTime = isRecord(state.time) ? state.time : {};
        const cancellationEvidence = [output, error, printable(metadata)].join("\n");
        return {
          callId: text(part[engine === "v2" ? "id" : "callID"]),
          name: text(part[engine === "v2" ? "name" : "tool"]),
          status,
          input: printable(state.input),
          output,
          error,
          cancelled: status === "cancelled"
            || /(?:user aborted the command|abort(?:ed|error)|interrupt(?:ed|ion)|cancel(?:led|ation))/i.test(cancellationEvidence),
          metadata,
          rawState: state,
          startedAt: engine === "v2"
            ? finiteNumber(partTime.ran) ?? finiteNumber(partTime.created)
            : finiteNumber(stateTime.start),
          completedAt: engine === "v2" ? finiteNumber(partTime.completed) : finiteNumber(stateTime.end),
        };
      }),
    }];
  });
}

function normalizeSession(value: unknown, engine: "v1" | "v2") {
  const session = record(value);
  return {
    id: text(session.id),
    parentId: text(session.parentID),
    directory: text(session.directory),
    location: session.location ?? null,
    workspace: printable(session[engine === "v2" ? "location" : "directory"]),
    outcome: text(session.outcome),
    raw: session,
  };
}

async function createSession(seed: Seed, app: Surface, title: string) {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await seed.session(app, { title });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Session creation did not settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function gateCommand(started: string, release: string, finished: string, reply: string): string {
  return `printf 'started\\n' > ${started}; i=0; while [ ! -f ${release} ] && [ "$i" -lt 170 ]; do sleep 1; i=$((i+1)); done; if [ -f ${release} ]; then printf 'finished\\n' > ${finished}; printf '${reply}\\n'; else printf 'gate timed out\\n' >&2; exit 124; fi`;
}

function quickCommand(index: number): string {
  const marker = String(index).padStart(2, "0");
  return `printf 'TOOL_HISTORY_${marker}_ALPHA\\nTOOL_HISTORY_${marker}_BETA\\nTOOL_HISTORY_${marker}_GAMMA\\n'`;
}

function childQuickCommand(index: number): string {
  const marker = String(index).padStart(2, "0");
  return `printf 'CHILD_LIVE_${marker}_ALPHA\\nCHILD_LIVE_${marker}_BETA\\n'`;
}

function shellStep(tool: string, command: string, description: string) {
  return { tool, arguments: { command, description, timeout: 210_000 } };
}

function requestedSurface(): "electron" | "web" {
  const value = process.env.OPENWORK_EVAL_APP_SURFACE?.trim() || "electron";
  if (value !== "electron" && value !== "web") {
    throw new Error(`OPENWORK_EVAL_APP_SURFACE must be web or electron; received ${JSON.stringify(value)}.`);
  }
  return value;
}

async function bootActivityApp(
  seed: Seed,
  name: string,
  workspacePath: string,
  mock: ReturnType<Seed["mock"]>,
  model: string,
): Promise<{ app: Surface; mock: MockMcpHandle; actualSourceSha: string | null }> {
  if (requestedSurface() === "web") {
    const app = await seed.appWeb({
      name,
      workspacePath,
      mocks: { agent: mock },
      headless: process.env.OPENWORK_EVAL_CHROME_HEADLESS === "1",
    });
    const agentMock = app.mocks.agent;
    if (!agentMock) throw new Error(`The app-web fixture did not boot the ${name} model witness.`);
    return { app, mock: agentMock, actualSourceSha: app.actualSourceSha };
  }
  const den = await seed.den({ mocks: { agent: mock } });
  const app = await seed.desktop({ name, den, as: "admin", model });
  const agentMock = den.mocks.agent;
  if (!agentMock) throw new Error(`The Electron fixture did not boot the ${name} model witness.`);
  return { app, mock: agentMock, actualSourceSha: null };
}

function workspaceFileApi(seed: Seed, app: Surface, workspaceId: string) {
  return {
    exists: (path: string) => seed.evalIn(app, browserScript(async (workspaceId, path) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/files/stat?path=${encodeURIComponent(path)}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Workspace file stat failed: HTTP ${response.status}`);
      const body: unknown = await response.json();
      return Boolean(body && typeof body === "object" && Reflect.get(body, "exists") === true);
    }, [workspaceId, path]), { awaitPromise: true, timeoutMs: 30_000 }),
    write: (path: string) => seed.evalIn(app, browserScript(async (workspaceId, path) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch(`http://127.0.0.1:${port}/workspace/${encodeURIComponent(workspaceId)}/files/content`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path, content: "release\n", baseUpdatedAt: null }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Workspace file write failed: HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`);
      return true;
    }, [workspaceId, path]), { awaitPromise: true, timeoutMs: 30_000 }),
  };
}

export async function longToolActivity(seed: Seed) {
  const engine = resolveEvalEngine();
  const surface = requestedSurface();
  const tool = engine === "v2" ? "shell" : "bash";
  const providerId = "tool-long-activity-mock";
  const modelId = "tool-long-activity-model";
  const workspacePath = seed.tmpPath("tool-long-activity");
  const history = {
    prompt: "Run the deterministic long-history commands. TOOL_LONG_HISTORY",
    reply: "Long tool history completed.",
    callCount: HISTORY_CALLS,
    lineCount: HISTORY_CALLS * HISTORY_LINES_PER_CALL,
  };
  const root = {
    prompt: "Start the controlled silent root command. TOOL_LONG_ROOT",
    partial: "TOOL_LONG_PARTIAL_OUTPUT",
    final: "The stopped root unexpectedly completed.",
    title: "Long real tool conversation",
  };
  const other = {
    prompt: "Start the unrelated controlled command. TOOL_LONG_OTHER",
    final: "Unrelated controlled command completed.",
    title: "Unrelated controlled tool",
  };
  const followup = {
    prompt: "Prepare one fresh summary after the stopped command. TOOL_LONG_FOLLOWUP",
    reply: "Fresh summary completed once after stop.",
  };
  const workloads: MockAgentWorkload[] = [
    {
      promptMarker: history.prompt, latestUserTurn: true, finalReply: history.reply,
      steps: Array.from({ length: HISTORY_CALLS }, (_, index) => shellStep(tool, quickCommand(index + 1), `History command ${index + 1}`)),
    },
    {
      promptMarker: root.prompt, latestUserTurn: true, finalReply: root.final,
      steps: [
        shellStep(tool, `printf '${root.partial}\\nROOT_PARTIAL_SECOND_LINE\\n'`, "Record partial root output"),
        shellStep(tool, gateCommand(ROOT_STARTED, ROOT_RELEASE, ROOT_FINISHED, "TOOL_LONG_ROOT_RELEASED"), "Wait for controlled root release"),
      ],
    },
    {
      promptMarker: other.prompt, latestUserTurn: true, finalReply: other.final,
      steps: [shellStep(tool, gateCommand(OTHER_STARTED, OTHER_RELEASE, OTHER_FINISHED, "TOOL_LONG_OTHER_RELEASED"), "Wait for unrelated release")],
    },
    { promptMarker: followup.prompt, latestUserTurn: true, finalReply: followup.reply, steps: [] },
  ];
  const definition = seed.mock({ isolatedProcessEnv: surface === "web", agentWorkloads: workloads });
  const booted = await bootActivityApp(seed, "tool-long-activity", workspacePath, definition, `${providerId}/${modelId}`);
  const app = booted.app;
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { bash: "allow", task: "allow" },
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Long tool activity mock",
        options: { baseURL: `${booted.mock.url}/v1`, apiKey: "sk-tool-long-activity" },
        models: { [modelId]: { name: "Long tool activity model" } },
      },
    },
  });
  const rootSession = await createSession(seed, app, root.title);
  const historySession = rootSession;
  const otherSession = await createSession(seed, app, other.title);
  const native = async (path: string): Promise<unknown> => {
    const result = await seed.evalIn(app, browserScript(async (path) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json().catch(() => null) };
    }, [path]), { awaitPromise: true, timeoutMs: 30_000 });
    if (result.status !== 200) throw new Error(`${path}: HTTP ${result.status}`);
    return engine === "v2" ? record(result.body).data : result.body;
  };
  const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}/${engine === "v2" ? "opencode2/api" : "opencode"}`;
  const transcript = async (sessionId: string) => normalizeTranscript(
    await native(`${mount}/session/${encodeURIComponent(sessionId)}/${engine === "v2" ? "context" : "message?limit=100"}`), engine,
  );
  const active = async (sessionId: string) => Boolean(record(await native(`${mount}/${engine === "v2" ? "session/active" : "session/status"}`))[sessionId]);
  const session = async (sessionId: string) => normalizeSession(await native(`${mount}/session/${encodeURIComponent(sessionId)}`), engine);
  const selected = (sessionId: string) => seed.evalIn(app, browserScript((workspaceId, sessionId) => {
    const current = document.querySelector<HTMLElement>('[data-workbench-pane="primary"] [data-session-surface-id]');
    return current?.dataset.sessionSurfaceWorkspaceId === workspaceId && current.dataset.sessionSurfaceId === sessionId;
  }, [workspace.workspaceId, sessionId]));
  const files = workspaceFileApi(seed, app, workspace.workspaceId);
  return {
    app, workspace, surface, engine, tool, history, root: { ...root, ...rootSession }, other: { ...other, ...otherSession },
    historySession, followup, mock: booted.mock, transcript, active, session, selected,
    runtimeFacts: () => ({ surface, hostKind: app.handle.hostKind, actualSourceSha: booted.actualSourceSha }),
    directoryFacts: async (sessionId: string) => {
      const owner = await session(sessionId);
      return { configuredPath: workspacePath, nativeDirectory: owner.directory, nativeLocation: owner.location };
    },
    rootStarted: () => files.exists(ROOT_STARTED), rootFinished: () => files.exists(ROOT_FINISHED), releaseRoot: () => files.write(ROOT_RELEASE),
    otherStarted: () => files.exists(OTHER_STARTED), otherFinished: () => files.exists(OTHER_FINISHED), releaseOther: () => files.write(OTHER_RELEASE),
    observeRoot(ownerToolCallId: string) {
      return observeToolActivity(app, {
        engine, workspaceId: workspace.workspaceId, rootSessionId: rootSession.sessionId,
        ownerSessionId: rootSession.sessionId, ownerToolCallId, uiCallId: ownerToolCallId, kind: "tool",
      });
    },
    async [Symbol.asyncDispose]() {
      await Promise.all([files.write(ROOT_RELEASE), files.write(OTHER_RELEASE)]);
    },
  };
}

export async function liveChildActivity(seed: Seed) {
  const engine = resolveEvalEngine();
  const surface = requestedSurface();
  const shell = engine === "v2" ? "shell" : "bash";
  const delegation = engine === "v2" ? "subagent" : "task";
  const providerId = "child-live-activity-mock";
  const modelId = "child-live-activity-model";
  const workspacePath = seed.tmpPath("child-live-activity");
  const child = {
    prompt: "Run six child checks, then wait for the controlled release. CHILD_LIVE_WORKER",
    title: "Run live child checks",
    final: "The child unexpectedly completed before Stop.",
    quickCalls: 6,
    outputLines: 12,
  };
  const root = {
    prompt: "Delegate the live child checks in the foreground. CHILD_LIVE_ROOT",
    title: "Live foreground child parent",
    final: "The parent unexpectedly completed before Stop.",
  };
  const other = {
    prompt: "Start the unrelated child control command. CHILD_LIVE_OTHER",
    title: "Unrelated child control",
    final: "Unrelated child control completed.",
  };
  const followup = {
    prompt: "Prepare one fresh parent summary after the child Stop. CHILD_LIVE_FOLLOWUP",
    reply: "Fresh parent summary completed once.",
  };
  const workloads: MockAgentWorkload[] = [
    {
      promptMarker: root.prompt, latestUserTurn: true, finalReply: root.final, finalReplyFrom: "last-tool-text",
      steps: [{ tool: delegation, arguments: {
        description: child.title,
        prompt: child.prompt,
        ...(engine === "v2" ? { agent: "general", background: false } : { subagent_type: "general" }),
      } }],
    },
    {
      promptMarker: child.prompt, latestUserTurn: true, finalReply: child.final,
      steps: [
        ...Array.from({ length: child.quickCalls }, (_, index) => shellStep(shell, childQuickCommand(index + 1), `Child check ${index + 1}`)),
        shellStep(shell, gateCommand(CHILD_STARTED, CHILD_RELEASE, CHILD_FINISHED, "CHILD_LIVE_RELEASED"), "Wait for controlled child release"),
      ],
    },
    {
      promptMarker: other.prompt, latestUserTurn: true, finalReply: other.final,
      steps: [shellStep(shell, gateCommand(CHILD_OTHER_STARTED, CHILD_OTHER_RELEASE, CHILD_OTHER_FINISHED, "CHILD_LIVE_OTHER_RELEASED"), "Wait for unrelated child control")],
    },
    { promptMarker: followup.prompt, latestUserTurn: true, finalReply: followup.reply, steps: [] },
  ];
  const definition = seed.mock({ isolatedProcessEnv: surface === "web", agentWorkloads: workloads });
  const booted = await bootActivityApp(seed, "child-live-activity", workspacePath, definition, `${providerId}/${modelId}`);
  const app = booted.app;
  const workspace = await seed.workspace(app, workspacePath);
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    permission: { bash: "allow", task: "allow" },
    agent: { general: { permission: { bash: "allow" } } },
    provider: {
      [providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Live child activity mock",
        options: { baseURL: `${booted.mock.url}/v1`, apiKey: "sk-child-live-activity" },
        models: { [modelId]: { name: "Live child activity model" } },
      },
    },
  });
  const otherSession = await createSession(seed, app, other.title);
  const rootSession = await createSession(seed, app, root.title);
  const native = async (path: string): Promise<unknown> => {
    const result = await seed.evalIn(app, browserScript(async (path) => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
      return { status: response.status, body: await response.json().catch(() => null) };
    }, [path]), { awaitPromise: true, timeoutMs: 30_000 });
    if (result.status !== 200) throw new Error(`${path}: HTTP ${result.status}`);
    return engine === "v2" ? record(result.body).data : result.body;
  };
  const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}/${engine === "v2" ? "opencode2/api" : "opencode"}`;
  const transcript = async (sessionId: string) => normalizeTranscript(
    await native(`${mount}/session/${encodeURIComponent(sessionId)}/${engine === "v2" ? "context" : "message?limit=100"}`), engine,
  );
  const active = async (sessionId: string) => Boolean(record(await native(`${mount}/${engine === "v2" ? "session/active" : "session/status"}`))[sessionId]);
  const activeIds = async () => Object.keys(record(await native(`${mount}/${engine === "v2" ? "session/active" : "session/status"}`)));
  const session = async (sessionId: string) => normalizeSession(await native(`${mount}/session/${encodeURIComponent(sessionId)}`), engine);
  const selected = (sessionId: string) => seed.evalIn(app, browserScript((workspaceId, sessionId) => {
    const current = document.querySelector<HTMLElement>('[data-workbench-pane="primary"] [data-session-surface-id]');
    return current?.dataset.sessionSurfaceWorkspaceId === workspaceId && current.dataset.sessionSurfaceId === sessionId;
  }, [workspace.workspaceId, sessionId]));
  const files = workspaceFileApi(seed, app, workspace.workspaceId);
  return {
    app, workspace, surface, engine, shell, delegation,
    root: { ...root, ...rootSession }, other: { ...other, ...otherSession }, child, followup,
    mock: booted.mock, transcript, active, activeIds, session, selected,
    runtimeFacts: () => ({ surface, hostKind: app.handle.hostKind, actualSourceSha: booted.actualSourceSha }),
    async childCandidates() {
      const rootOwner = await session(rootSession.sessionId);
      const ids = (await activeIds()).filter((id) => id !== rootSession.sessionId && id !== otherSession.sessionId);
      const owners = await Promise.all(ids.map((id) => session(id)));
      return owners.filter((owner) => owner.parentId === rootSession.sessionId && owner.workspace === rootOwner.workspace);
    },
    childStarted: () => files.exists(CHILD_STARTED), childFinished: () => files.exists(CHILD_FINISHED), releaseChild: () => files.write(CHILD_RELEASE),
    otherStarted: () => files.exists(CHILD_OTHER_STARTED), otherFinished: () => files.exists(CHILD_OTHER_FINISHED), releaseOther: () => files.write(CHILD_OTHER_RELEASE),
    observeChild(childSessionId: string, childToolCallId: string, delegationCallId: string) {
      return observeToolActivity(app, {
        engine, workspaceId: workspace.workspaceId, rootSessionId: rootSession.sessionId,
        ownerSessionId: childSessionId, ownerToolCallId: childToolCallId, parentToolCallId: delegationCallId,
        uiCallId: delegationCallId, kind: "child",
      });
    },
    observePromptPosts(sessionId: string) {
      return observeSessionPromptPosts(app, sessionId);
    },
    async [Symbol.asyncDispose]() {
      await Promise.all([files.write(CHILD_RELEASE), files.write(CHILD_OTHER_RELEASE)]);
    },
  };
}
