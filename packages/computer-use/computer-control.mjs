// The computer broker owns per-chat consent, the single native session lease,
// receipts, observations and handoff. Model arguments never select a session,
// window, receipt identity, helper command or credential.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

export const COMPUTER_TOOLS = Object.freeze({
  computer_discover: "computer_discover",
  computer_open: "computer_open_session",
  computer_observe: "computer_observe",
  computer_act: "computer_act",
  computer_zoom: "computer_zoom",
  computer_status: "computer_session_status",
  computer_close: "computer_close_session",
});
export const COMPUTER_PROTOCOL = "openwork.computer-use/1";
export const COMPUTER_STOP_GUIDANCE = "Computer session revocation could not be confirmed. Use Stop on the agent's pill over the app window or in the OpenWork Computer Use menu before continuing.";
const ARGUMENTS = Object.freeze({
  computer_open: ["app_id", "pid", "mode", "purpose"],
  computer_observe: ["include_image", "elements"],
  computer_act: ["observation_id", "action", "actions", "intent"],
  computer_zoom: ["observation_id", "x", "y", "width", "height"],
});
const failure = (code, message, extra = {}) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code, message, ...extra }) }] });
const stateOf = (result) => {
  try { return JSON.parse(result.content.find((part) => part.type === "text").text); } catch { return null; }
};
const needsPerson = (result) => stateOf(result)?.state === "paused" || stateOf(result)?.next === "human_takeover";
const withHandoff = (result, status) => {
  const state = stateOf(status);
  const continued = !status.isError && state?.ok === true && state.state === "active";
  return { ...result, isError: result.isError === true || !continued,
    content: [...result.content, { type: "text", text: JSON.stringify({ handoff: state, next: continued ? "observe" : "human_takeover", fresh_observation_required: true, actions_replayed: false }) }] };
};
const withPostObservation = (receipt, status, content = []) => ({ ...receipt, content: [...receipt.content,
  { type: "text", text: JSON.stringify({ post_observation: status, actions_replayed: false,
    ...(!status.ok ? { next: status.next, fresh_observation_required: true } : {}) }) }, ...content] });
const postWarning = (receipt, code, next = "observe") => withPostObservation(receipt, { ok: false, code, next,
  message: "The fresh observation is unavailable. The original receipt is unchanged; do not replay the input. Review the current control state before observing again." });
// A call made in the wrong order dispatched nothing: report it without revoking or closing anything.
const SEQUENCE_CODES = new Set(["session_open", "session_required"]);
const uiText = (value, limit) => typeof value === "string" && value.length <= limit;
const uiNumber = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;

async function bounded(promise, ms) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Computer cleanup or operation timed out.")), ms); })]); }
  finally { clearTimeout(timer); }
}

function deadline(ms) {
  const controller = new AbortController();
  const { signal } = controller;
  const expires = performance.now() + ms;
  const expire = () => controller.abort(new Error("Computer cleanup or operation timed out."));
  const timer = setTimeout(expire, ms);
  const check = () => { if (performance.now() >= expires) expire(); signal.throwIfAborted(); };
  return { signal, check, dispose: () => clearTimeout(timer), async wait(work, parent = signal) {
    const pending = parent === signal ? signal : AbortSignal.any([signal, parent]);
    const active = () => { check(); pending.throwIfAborted(); };
    active();
    let abort;
    try {
      const stopped = new Promise((_, reject) => { abort = () => reject(pending.reason); pending.addEventListener("abort", abort, { once: true }); });
      const value = await Promise.race([Promise.resolve().then(() => { active(); return work(pending); }), stopped]);
      active();
      return value;
    } finally { pending.removeEventListener("abort", abort); }
  } };
}

/**
 * @typedef {{ isError?: boolean, content: Array<{ type: string, text?: string, data?: string, mimeType?: string }> }} ComputerResult
 * @typedef {{ sessionId?: string }} ChatInput
 * @typedef {{ id: string, reason: "setup", computer: string, placement: "local" | "remote", detail?: string, appId?: string, purpose?: string }} ComputerRequest
 * @typedef {{ targets?: Record<string, string> }} SavedChoices
 * @typedef {{
 *   callTool: (name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal, timeoutMs?: number }) => Promise<ComputerResult>,
 *   notifyUi: (params: Record<string, unknown>) => Promise<void>,
 *   close: () => Promise<void>,
 * }} ComputerTransport
 * @typedef {{
 *   id: string,
 *   label: string,
 *   placement: "local" | "remote",
 *   protocol: string,
 *   readiness: () => Promise<{ readiness: string, detail: string, permissions?: { accessibility: boolean, screenRecording: boolean } }>,
 *   setup?: (permission: "accessibility" | "screenRecording") => Promise<{ setupId: string }>,
 *   dismissSetup?: (setupId?: string) => Promise<void>,
 *   connect: (options: { signal: AbortSignal, presence: { name: string, color: string } | null, onUi: (value: unknown) => void, onClose: () => void }) => Promise<ComputerTransport>,
 * }} ComputerAdapter
 */

/**
 * Adapters are trusted main-process dependencies, never renderer or model
 * input: "This Mac" (the native helper) and any remote computer such as a
 * Linux VM (see computer-remote.mjs). Every adapter speaks the same seven-tool
 * contract; each chat picks one. connect() owns a dedicated session scope;
 * close() MUST confirm session revocation, not merely disconnect. One
 * controller across all chats and computers, deliberately conservative.
 * @param {{
 *   adapters: ComputerAdapter[],
 *   runProgram?: (request: import("@openwork/computer-use/runtime").ProgramRequest, host: import("@openwork/computer-use/runtime").ProgramHost, signal: AbortSignal) => Promise<import("@openwork/computer-use/runtime").ProgramResult>,
 *   browserTask?: (request: { sessionId: string, operation: string, args: Record<string, unknown> }, options: { signal: AbortSignal }) => Promise<unknown>,
 *   readRemoteFeatureEnabled?: () => Promise<boolean>,
 *   standing?: { read: () => Promise<SavedChoices>, write: (state: SavedChoices) => Promise<void> },
 *   presence?: { name: string, color: string } | null,
 *   permissionEntry?: () => Promise<{ name: string, ours: boolean }>,
 *   onRequest?: (sessionId: string, request: ComputerRequest | null) => void,
 *   requestMs?: number,
 *   cleanupMs?: number, operationMs?: number, pollMs?: number, idleMs?: number, now?: () => number,
 * }} options
 */
export function createComputerControl({ adapters, runProgram, browserTask, readRemoteFeatureEnabled = async () => false, standing = { read: async () => ({ targets: {} }), write: async (_state) => {} }, presence = null,
  permissionEntry = async () => ({ name: "OpenWork", ours: false }), onRequest = () => {},
  cleanupMs = 3000, operationMs = 120_000, pollMs = 750, idleMs = 90_000, requestMs = 600_000, now = Date.now }) {
  const targets = new Map();
  for (const candidate of Array.isArray(adapters) ? adapters : []) {
    if (!candidate || typeof candidate.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(candidate.id) || targets.has(candidate.id)
      || typeof candidate.label !== "string" || !candidate.label.trim() || !["local", "remote"].includes(candidate.placement)
      || candidate.protocol !== COMPUTER_PROTOCOL || ["readiness", "connect"].some((name) => typeof candidate[name] !== "function")) {
      throw new Error("Computer adapters need a unique id, a label, a placement, the supported protocol, readiness and connect.");
    }
    targets.set(candidate.id, Object.freeze({ ...candidate }));
  }
  if (!targets.size) throw new Error("At least one trusted computer adapter is required.");
  const defaultTarget = [...targets.values()].find((target) => target.placement === "local") ?? [...targets.values()][0];
  const offered = () => [...targets.values()].filter((target) => target.placement === "local" || remoteEnabled);
  /** The computer a chat really uses: its choice, unless remote computers are turned off. */
  const targetFor = (grant) => grant.adapter.placement === "remote" && !remoteEnabled ? defaultTarget : grant.adapter;
  for (const value of [cleanupMs, operationMs, pollMs, idleMs, requestMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Computer time limits must be positive bounded milliseconds.");
  const grants = new Map();
  const requests = new Map();
  const programs = new Map();
  let lease = null;
  let featureEnabled = false;
  let featureGeneration = 0;
  let remoteGeneration = 0;
  let remoteUpdateRevision = 0;
  // `remoteComputers`: off, VMs are hidden and every chat uses a local computer.
  let remoteEnabled = false;
  let remoteRequested = false;
  let saved = null;
  let loadingChoices = null;
  let remembering = Promise.resolve();
  let tail = Promise.resolve();
  let closed = false;
  let resetting = 0;
  function invalidateObservation(current) {
    current.observationGeneration = (current.observationGeneration ?? 0) + 1;
  }
  function advance(grant) {
    programs.get(grant.sessionId)?.controller.abort(new Error("Computer control stopped or changed."));
    grant.controller.abort(new Error("Computer use was turned off, revoked, or restarted."));
    grant.controller = new AbortController();
    return ++grant.revision;
  }
  function disable(grant) {
    grant.enabled = false; advance(grant);
    if (lease?.grant === grant) invalidateObservation(lease);
  }
  async function choices() {
    if (!saved) {
      loadingChoices ??= Promise.resolve().then(() => standing.read()).catch(() => null).then((state) => {
        const chosen = state?.targets && typeof state.targets === "object" ? Object.entries(state.targets).filter(([id, target]) => typeof id === "string" && typeof target === "string") : [];
        saved = { targets: new Map(chosen) };
      });
      await loadingChoices;
    }
    return saved;
  }
  function remember(change) {
    const result = remembering.then(async () => {
      const state = await choices();
      change(state);
      state.targets = new Map([...state.targets].slice(-500));
      await standing.write({ targets: Object.fromEntries(state.targets) });
    });
    remembering = result.catch(() => {});
    return result;
  }
  // An automatic stop (helper exit, failed handoff) pauses a chat for the rest
  // of its turn. The next turn re-arms every chat the person allowed.
  async function rearm(sessionId) {
    if (closed || resetting) return;
    for (const grant of grants.values()) {
      if (sessionId && grant.sessionId !== sessionId) continue;
      if (!grant.enabled && lease?.grant !== grant) grant.enabled = true;
    }
  }
  const serial = (work, limit, signal) => {
    const previous = tail;
    const ready = limit ? limit.wait(() => previous, signal) : previous;
    const result = ready.then(() => { limit?.check(); signal?.throwIfAborted(); return work(); });
    tail = Promise.all([previous, result.then(() => undefined, () => undefined)]).then(() => undefined);
    return result;
  };
  async function grantFor(sessionId) {
    if (closed || resetting) throw new Error("Computer use is stopping.");
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("A chat is required.");
    let grant = grants.get(sessionId);
    if (!grant) {
      const state = await choices();
      grant = grants.get(sessionId);
      if (!grant) {
        // Each chat remembers the computer it last used; one that went away falls back to the first.
        const preferred = process.platform === "darwin" ? defaultTarget : [...targets.values()].find((target) => target.placement === "remote") ?? defaultTarget;
        const adapter = targets.get(state.targets.get(sessionId) ?? "") ?? preferred;
        grant = { sessionId, revision: 0, controller: new AbortController(), enabled: true, windows: new Map(), adapter };
        grants.set(sessionId, grant);
      }
    }
    return grant;
  }
  // Probes start a helper process; reuse a recent answer, longer once ready.
  const lastReadiness = new Map();
  async function readiness(adapter) {
    const last = lastReadiness.get(adapter.id);
    const reuse = last && now() - last.at < (last.value.readiness === "ready" ? 10_000 : 1_000);
    if (reuse) return last.value;
    const value = await probeReadiness(adapter);
    lastReadiness.set(adapter.id, { at: now(), value });
    return value;
  }
  async function probeReadiness(adapter) {
    try {
      // A remote computer's readiness may cross the network; allow it longer.
      const status = await bounded(adapter.readiness(), adapter.placement === "remote" ? 15_000 : cleanupMs);
      if (!["ready", "setup-required", "unsupported", "unavailable"].includes(status?.readiness) || typeof status.detail !== "string") throw new Error("Invalid readiness.");
      const permissions = status.permissions;
      if (permissions !== undefined && (typeof permissions?.accessibility !== "boolean" || typeof permissions?.screenRecording !== "boolean")) throw new Error("Invalid permissions.");
      return { readiness: status.readiness, detail: status.detail,
        ...(permissions ? { permissions: { accessibility: permissions.accessibility, screenRecording: permissions.screenRecording } } : {}) };
    } catch { return { readiness: "unavailable", detail: `${adapter.label} is unavailable right now.` }; }
  }
  function revise(grant, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== grant.revision) throw new Error("Computer settings changed. Check the latest state before trying again.");
    return advance(grant);
  }
  function clearPresentation(current) {
    invalidateObservation(current);
    current.presentation = null;
    current.watchUntil = 0;
    current.frameSequence = -1;
    current.inputSequence = -1;
  }
  function assertUiActive(current) {
    if (lease !== current || current.closing || current.uiEnded || !current.grant.enabled
      || current.controller.signal.aborted || (current.expiresAt !== undefined && now() >= current.expiresAt)) {
      throw new Error("This computer session ended. Sensitive actions still require your authorization.");
    }
  }
  function controlStillOwned(call, observation) {
    const { current, generation, nativeId } = observation;
    try { assertUiActive(current); } catch { return false; }
    return call.grant.revision === call.revision && current.nativeId === nativeId && current.handoffGeneration === generation
      && current.presentation?.phase !== "paused";
  }
  function observationStillOwned(call, observation) {
    return controlStillOwned(call, observation) && observation.current.observationGeneration === observation.observationGeneration;
  }
  function postStillOwned(call) {
    return observationStillOwned(call, call.post) && call.post.current.session?.state !== "paused";
  }
  function observationWarning(call, observation) {
    if (observation.current.observationGeneration === observation.observationGeneration) observation.current.needsObservation = true;
    return failure("observation_required", "Computer control changed while observing. The previous observation was withheld. Review the native controls and observe again.",
      { next: controlStillOwned(call, observation) ? "observe" : "human_takeover", fresh_observation_required: true, actions_replayed: false });
  }
  // A late read must not deliver an image or unlock input after a takeover,
  // even when the person already continued before it arrived.
  function deliverResult(call, result) {
    if (call.post?.captured) return postStillOwned(call) ? call.post.result : postWarning(call.post.receipt, "observation_withheld", controlStillOwned(call, call.post) ? "observe" : "human_takeover");
    if (call.observation && !result.isError) return observationStillOwned(call, call.observation) ? result : observationWarning(call, call.observation);
    return result;
  }
  function matchesOpening(current, value) {
    const opening = current.opening;
    return opening && !opening.signal.aborted && value.appID === opening.args.app_id
      && (opening.args.pid === undefined || value.pid === opening.args.pid)
      && value.mode === opening.args.mode && value.task === opening.args.purpose;
  }
  async function approveWindow(current, presentation, windowId) {
    const opening = current.opening;
    if (!opening || opening.decisionSent) throw new Error("This app request already has a decision. Do not retry it.");
    // Reserve the decision before any await so duplicate notifications cannot approve twice.
    opening.decisionSent = true;
    assertUiActive(current);
    opening.assertActive();
    if (current.presentation !== presentation || presentation.phase !== "approval"
      || !presentation.windows.some((window) => window.id === windowId)) throw new Error("The native window choice changed. Review it again.");
    await current.transport.notifyUi({ id: presentation.id, action: "approve", windowId });
    // The person approved this app's window once in this chat; reopening it later does not ask again.
    const title = presentation.windows.find((window) => window.id === windowId)?.title;
    if (title) current.grant.windows.set(opening.args.app_id, title);
  }
  function receiveUi(current, value) {
    try { assertUiActive(current); } catch { clearPresentation(current); return; }
    if (!value || !uiText(value.id, 128) || !value.id || !["state", "frame", "input"].includes(value.kind)) return;
    const presentation = current.presentation;
    if (value.kind === "state") {
      if (!["approval", "working", "paused", "closed"].includes(value.phase)) return;
      // Only the exact admitted open can introduce an identity. Never adopt a
      // different native ID on this lease, even if a late notification looks valid.
      if (current.uiId && value.id !== current.uiId) {
        clearPresentation(current); current.uiEnded = true;
        disable(current.grant); void cleanup(current);
        return;
      }
      if (!current.uiId && (value.phase !== "approval" || !matchesOpening(current, value))) return;
      if (value.phase === "closed") {
        clearPresentation(current); current.uiEnded = true;
        if (!current.expectedClose) { disable(current.grant); void cleanup(current); }
        return;
      }
      for (const [key, limit] of [["appName", 512], ["appID", 512], ["windowTitle", 2048], ["task", 500], ["mode", 32], ["status", 2048]]) {
        if (value[key] !== undefined && !uiText(value[key], limit)) return;
      }
      if (value.pid !== undefined && (!uiNumber(value.pid, 0x7fffffff) || value.pid === 0)) return;
      if (value.canContinue !== undefined && typeof value.canContinue !== "boolean") return;
      if (value.windows !== undefined && (!Array.isArray(value.windows) || value.windows.length > 128
        || value.windows.some((window) => !window || !uiNumber(window.id, 0xffffffff) || !window.id || !uiText(window.title, 2048))
        || new Set(value.windows.map((window) => window.id)).size !== value.windows.length)) return;
      if (value.phase === "approval" && (!matchesOpening(current, value) || !Array.isArray(value.windows) || !value.windows.length)) return;
      if (!current.uiId) { clearPresentation(current); current.uiId = value.id; }
      const next = { id: value.id, phase: value.phase, inputs: presentation?.inputs ?? [] };
      for (const key of ["appName", "windowTitle", "task", "mode", "status", "canContinue"]) if (value[key] !== undefined) next[key] = value[key];
      if (value.windows) next.windows = value.windows.map(({ id, title }) => ({ id, title }));
      if (value.phase === "working" && presentation?.frame) next.frame = presentation.frame;
      if (value.phase === "paused") {
        if (presentation?.phase !== "paused") current.handoffGeneration++;
        invalidateObservation(current);
        current.needsObservation = true; next.inputs = [];
      }
      if (value.phase === "approval" && isDeepStrictEqual(presentation, next)) return;
      current.presentation = next;
      // The rollout supplies access; select the app window automatically.
      if (value.phase === "approval" && !current.opening?.decisionSent) {
        const previous = current.grant.windows.get(value.appID);
        const selected = next.windows.find((window) => window.title === previous) ?? next.windows[0];
        void approveWindow(current, next, selected.id).catch(() => { disable(current.grant); void cleanup(current); });
      }
      return;
    }
    if (!presentation || value.id !== presentation.id || presentation.phase !== "working" || current.watchUntil <= now()) return;
    if (!uiNumber(value.sequence)) return;
    if (value.kind === "frame") {
      if (value.sequence <= current.frameSequence || !uiNumber(value.capturedAt)
        || !uiNumber(value.width, 8192) || !value.width || !uiNumber(value.height, 8192) || !value.height || value.width * value.height > 16_777_216
        || value.mimeType !== "image/png" || !uiText(value.data, 4 * 1024 * 1024) || !value.data.startsWith("iVBORw0KGgo")
        || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) return;
      current.frameSequence = value.sequence;
      presentation.frame = { sequence: value.sequence, capturedAt: value.capturedAt, width: value.width, height: value.height, mimeType: "image/png", data: value.data };
    } else {
      if (value.sequence <= current.inputSequence || !uiNumber(value.at)
        || !["move", "click", "double_click", "triple_click", "drag", "scroll", "key", "type", "press", "set_value"].includes(value.action)
        || !["move", "down", "up", "dispatched", "uncertain"].includes(value.phase)
        || [value.x, value.y].some((position) => position !== undefined && (!Number.isFinite(position) || position < 0 || position > 1))) return;
      current.inputSequence = value.sequence;
      presentation.inputs.push({ sequence: value.sequence, at: value.at, action: value.action, phase: value.phase,
        ...(value.x !== undefined ? { x: value.x } : {}), ...(value.y !== undefined ? { y: value.y } : {}) });
      if (presentation.inputs.length > 64) presentation.inputs.shift();
    }
  }
  function updateSession(current, result, purpose) {
    const state = stateOf(result);
    if (!state) return;
    const paused = state.state === "paused" || state.next === "human_takeover";
    if (paused && current.nativeId) { invalidateObservation(current); current.needsObservation = true; }
    if ((result.isError || state.ok !== true) && !paused) return;
    const opening = current.session?.state === "opening";
    if (Number.isFinite(state.expires_in_seconds)) current.expiresAt = now() + Math.max(0, state.expires_in_seconds) * 1000;
    current.session = {
      ...current.session,
      state: paused ? "paused" : state.state ?? current.session?.state ?? "active",
      purpose: purpose ?? state.purpose ?? current.session?.purpose ?? "",
      ...(typeof state.app_name === "string" ? { appName: state.app_name } : {}),
      ...(typeof state.window_title === "string" ? { windowTitle: state.window_title } : {}),
      ...(typeof state.phase === "string" ? { phase: state.phase } : paused ? { phase: "waiting-for-person" } : {}),
      ...(Number.isFinite(state.expires_in_seconds) ? { expiresAt: new Date(now() + state.expires_in_seconds * 1000).toISOString() } : {}),
      reason: typeof state.pause_reason === "string" ? state.pause_reason : paused ? state.message ?? "Continue or Stop in the native computer controls." : "",
    };
    if (!paused && (opening || state.state === "active") && typeof state.phase !== "string") delete current.session.phase;
  }
  function nativeStopped(current, result) {
    if (stateOf(result)?.code !== "session_unavailable") return false;
    disable(current.grant);
    current.nativeStopped = true;
    return true;
  }
  async function cleanup(current) {
    clearTimeout(current.idleTimer);
    current.closing = true;
    clearPresentation(current);
    current.opening = null;
    current.controller.abort(new Error("Computer control stopped."));
    current.cleanupPending = true;
    if (!current.cleanup) {
      current.cleanup = (async () => {
        // Do not free the machine while an open/connect may still acknowledge late.
        await current.work?.catch(() => {});
        if (current.connectionUncertain && !current.transport) throw new Error("Connection setup failed without a confirmed helper shutdown.");
        if (current.transport && !current.transportClosed) {
          if (current.nativeId) {
            try { nativeStopped(current, await bounded(current.transport.callTool("computer_close_session", { session_id: current.nativeId }), cleanupMs)); }
            catch { /* close() below must still confirm session revocation. */ }
          }
          await bounded(current.transport.close(), cleanupMs);
          current.transportClosed = true;
        }
        current.cleanupPending = false;
        if (lease === current) lease = null;
        return true;
      })().catch(() => false).finally(() => { current.cleanup = null; });
    }
    try { return await bounded(current.cleanup, cleanupMs); }
    catch {
      // Closing the dedicated transport also cancels a native approval sheet.
      // Keep the reservation until the in-flight operation actually settles.
      if (current.transport && !current.transportClosed) {
        try { await bounded(current.transport.close(), cleanupMs); current.transportClosed = true; } catch { /* Still uncertain; Stop can retry cleanup. */ }
      }
      return !current.cleanupPending;
    }
  }
  // An idle or finished session hands the Mac back without turning the chat off.
  async function release(current) {
    if (lease !== current || current.closing) return true;
    if (current.busy) { current.releaseWhenIdle = true; return true; }
    current.expectedClose = true;
    const confirmed = await cleanup(current);
    await rearm(current.grant.sessionId);
    return confirmed;
  }
  function armIdleRelease(current) {
    clearTimeout(current.idleTimer);
    if (lease !== current || current.busy || current.closing) return;
    if (current.releaseWhenIdle) { void release(current); return; }
    current.idleTimer = setTimeout(() => { void release(current); }, idleMs);
    current.idleTimer.unref?.();
  }
  async function view(grant, poll = false) {
    if (poll && lease?.grant === grant && lease.nativeId && !lease.closing && !lease.busy) {
      const limit = deadline(cleanupMs);
      try {
        await serial(async () => {
          const current = lease;
          if (current?.grant !== grant || current.closing || !current.nativeId || current.busy) return;
          const revision = grant.revision;
          const signal = AbortSignal.any([limit.signal, current.controller.signal]);
          current.work = current.transport.callTool("computer_session_status", { session_id: current.nativeId }, { signal });
          try {
            const result = await limit.wait(() => current.work, signal);
            if (lease !== current || current.closing || grant.revision !== revision) return;
            if (nativeStopped(current, result)) {
              await cleanup(current);
            } else if (result.isError || stateOf(result)?.ok !== true) {
              current.session = { ...current.session, state: "unavailable", reason: stateOf(result)?.message ?? "Native status is unavailable." };
            } else updateSession(current, result);
          } catch {
            if (lease === current && grant.revision === revision) disable(grant);
            await cleanup(current);
          }
        }, limit);
      } catch { /* The snapshot below reports the last known state. */ }
      finally { limit.dispose(); }
    }
    const target = targetFor(grant);
    const status = await readiness(target);
    const elsewhere = lease && lease.grant !== grant;
    const current = lease?.grant === grant ? lease : null;
    return {
      revision: grant.revision, enabled: featureEnabled && grant.enabled,
      entry: await permissionEntry().then(({ name, ours }) => ({ name, ours }), () => ({ name: "OpenWork", ours: false })),
      request: (() => {
        const request = requests.get(grant.sessionId);
        return request?.published ? describeRequest(grant, request) : null;
      })(),
      targetId: target.id,
      targets: offered().map(({ id, label, placement }) => ({ id, label, placement })),
      placement: target.placement,
      readiness: status.readiness, ...(status.permissions ? { permissions: status.permissions } : {}),
      detail: current?.cleanupPending ? "Stopping computer use. Native release has not yet been confirmed." : status.detail,
      busyElsewhere: Boolean(elsewhere),
      session: current?.session ? { ...current.session, ...(current.closing ? { state: "stopping" } : {}) } : null,
      ...(current?.cleanupPending ? { cleanupPending: true } : {}),
    };
  }
  async function run(call, signal, limit) {
    const { name, args, grant, revision } = call;
    const check = () => {
      if (!featureEnabled || call.featureGeneration !== featureGeneration || call.remoteTarget && call.remoteGeneration !== remoteGeneration || closed || resetting || !grant.enabled || grant.revision !== revision || grants.get(grant.sessionId) !== grant) {
        throw new Error("Computer use was turned off, revoked, or restarted before this call finished.");
      }
    };
    const admissionSignal = AbortSignal.any([limit.signal, signal, grant.controller.signal]);
    return serial(async () => {
      limit.check(); check();
      if (lease && (lease.grant !== grant || lease.closing)) {
        return failure("computer_busy", lease.closing
          ? "The previous computer session is still stopping. Try again in a moment. Nothing was dispatched."
          : "Another chat is using this Mac. It must finish or be stopped first. Nothing was dispatched.");
      }
      lease ??= { grant, adapter: targetFor(grant), controller: new AbortController(), nativeId: null, session: null, busy: false, handoffGeneration: 0 };
      const current = lease;
      clearTimeout(current.idleTimer);
      current.busy = true;
      // The engine cancelled this tool: end the native session, keep the chat's permission.
      const abort = () => { if (lease === current) { current.expectedClose = true; void cleanup(current); } };
      signal.addEventListener("abort", abort, { once: true });
      const active = AbortSignal.any([admissionSignal, current.controller.signal]);
      const progress = () => { limit.check(); active.throwIfAborted(); check(); };
      /** @type {ComputerResult | undefined} */
      let nativeResult;
      let handoff = false;
      let postReadFailed = false;
      current.work = Promise.resolve().then(async () => {
        progress();
        if (!current.transport) {
          try {
            current.transport = await current.adapter.connect({
              signal: active, presence,
              onUi: (value) => receiveUi(current, value),
              onClose: () => {
                clearPresentation(current); current.uiEnded = true;
                if (lease === current && !current.closing && !current.expectedClose) { disable(grant); void cleanup(current); }
              },
            });
          } catch (error) {
            // The adapter combines setup and shutdown errors when it could
            // not confirm termination and cannot return a usable handle.
            current.connectionUncertain = error instanceof AggregateError;
            throw error;
          }
          progress();
        }
        if (name === "computer_open" && current.nativeId) return failure("session_open", "A session is already open. Keep using it, or close it before requesting another app or mode. Nothing was dispatched.");
        if (!["computer_discover", "computer_open"].includes(name) && !current.nativeId) return failure("session_required", "No session is open. Call computer_open first. Nothing was dispatched.");
        if (name === "computer_open") {
          current.session = { state: "opening", purpose: args.purpose, phase: "native-approval" };
          current.opening = { args, signal: active, assertActive: progress, decisionSent: false };
        }
        current.expectedClose = name === "computer_close";
        const nativeArgs = { ...args, ...(current.nativeId && name !== "computer_discover" ? { session_id: current.nativeId } : {}),
          ...(name === "computer_act" ? { request_id: randomUUID() } : {}) };
        if (["computer_open", "computer_observe", "computer_act", "computer_close"].includes(name)) invalidateObservation(current);
        const generation = current.handoffGeneration;
        const observationGeneration = current.observationGeneration;
        progress();
        const result = name === "computer_act" && current.needsObservation
          ? failure("observation_required", "Native control paused or continued. Make a fresh observation before any action; no action was dispatched.", current.session?.state === "paused" ? { state: "paused", next: "human_takeover" } : {})
          : (nativeResult = await current.transport.callTool(COMPUTER_TOOLS[name], nativeArgs, { signal: active }));
        const state = stateOf(result);
        if (name === "computer_open") current.opening = null;
        if (name === "computer_open" && typeof state?.session_id === "string") current.nativeId = state.session_id;
        if (!state || typeof state.ok !== "boolean") throw new Error("The native computer response was unreadable; its outcome is uncertain.");
        if (name === "computer_open" && state.ok && !current.nativeId) throw new Error("The native approval returned no session identity.");
        const inputLanded = name === "computer_act" && (!result.isError && state.ok && state.status === "dispatched"
          || state.status === "partial" && state.may_have_acted === true && state.next === "observe");
        if (current.nativeId && (inputLanded || name === "computer_open" && !result.isError && state.ok && state.state === "active")) {
          call.post = { current, generation, nativeId: current.nativeId, receipt: result, captured: false,
            observationGeneration: name === "computer_open" ? current.observationGeneration : observationGeneration };
        }
        progress();
        if (nativeStopped(current, result)) return result;
        // A zoom image follows the same withholding as an observation, but never unlocks input.
        if ((name === "computer_observe" || name === "computer_zoom") && !result.isError && state.ok && !needsPerson(result)) {
          call.observation = { current, generation, nativeId: current.nativeId, observationGeneration };
          if (!observationStillOwned(call, call.observation)) return observationWarning(call, call.observation);
        }
        if (name !== "computer_discover") updateSession(current, result, name === "computer_open" ? args.purpose : undefined);
        if (!current.nativeId || name === "computer_close" || (!needsPerson(result) && current.session?.state !== "paused")) {
          if (name === "computer_observe" && !result.isError && state.ok && typeof state.observation_id === "string") current.needsObservation = false;
          // A partial batch (later step refused) still landed input; the model
          // needs the settled view exactly as much as after a full dispatch.
          if (call.post) {
            try {
              progress(); assertUiActive(current);
              if (!postStillOwned(call) || current.needsObservation) return postWarning(result, "handoff_required", "human_takeover");
              // One read in this exact tool call, never a repeated input or a
              // continuation across a person takeover. Watch frames are unrelated.
              const observation = await current.transport.callTool("computer_observe", { session_id: current.nativeId, include_image: call.includePostImage !== false }, { signal: active });
              progress(); assertUiActive(current);
              if (!postStillOwned(call)) return postWarning(result, "observation_withheld", "human_takeover");
              const observed = stateOf(observation);
              if (observation.isError || observed?.ok !== true || typeof observed.observation_id !== "string" || !observed.observation_id || needsPerson(observation)) {
                current.needsObservation = true;
                nativeStopped(current, observation); updateSession(current, observation);
                const code = typeof observed?.code === "string" && /^[a-z0-9_]{1,80}$/.test(observed.code) ? observed.code : "post_observation_failed";
                return postWarning(result, code, needsPerson(observation) ? "human_takeover" : "observe");
              }
              updateSession(current, observation);
              current.needsObservation = false;
              call.post.captured = true;
              call.post.result = withPostObservation(result, { ok: true }, observation.content);
              return result;
            } catch {
              current.needsObservation = true;
              postReadFailed = true;
              return postWarning(result, "post_observation_failed", "human_takeover");
            }
          }
          return result;
        }
        // Keep the original native tool active while the person decides.
        // Only status reads follow Continue: never resume or redispatch input.
        handoff = true;
        let status = result;
        do {
          current.needsObservation = true;
          updateSession(current, status);
          await delay(pollMs, undefined, { signal: active });
          progress();
          status = await current.transport.callTool("computer_session_status", { session_id: current.nativeId }, { signal: active });
          progress();
          if (nativeStopped(current, status)) break;
          updateSession(current, status);
        } while (needsPerson(status));
        const continued = stateOf(status);
        current.handoffFailed = status.isError === true || continued?.ok !== true;
        if (!current.handoffFailed && continued.state !== "active") throw new Error("The native handoff did not confirm active control.");
        if (name === "computer_act" || result.isError) return withHandoff(result, status);
        if (current.handoffFailed) return status;
        if (name === "computer_observe" || name === "computer_zoom") return withHandoff(failure("observation_required", "The previous observation predates the handoff. Observe again."), status);
        return { ...status, content: [{ type: "text", text: JSON.stringify({ ...state, ...continued, next: "observe", fresh_observation_required: true }) }] };
      });
      const work = current.work;
      const settled = () => { if (current.work === work) current.work = null; };
      void work.then(settled, settled);
      try {
        const result = await limit.wait(() => work);
        if (name === "computer_close" || current.nativeStopped || current.handoffFailed || postReadFailed
          || (name === "computer_open" && result.isError && !SEQUENCE_CODES.has(stateOf(result)?.code))) {
          // An app that would not open (or a window the person declined) never
          // turns the chat off; other automatic stops pause it for this turn.
          if (name !== "computer_close" && name !== "computer_open" && lease === current && grant.revision === revision) disable(grant);
          if (name === "computer_open") current.expectedClose = true;
          if (stateOf(result)?.ok === true && name === "computer_close") current.nativeId = null;
          await cleanup(current);
        }
        if (result.isError) return result;
        // Preserve a dispatched or uncertain native receipt even when Stop raced it.
        if (current.closing && !call.post && name !== "computer_act" && name !== "computer_close") return failure("revoked", "Computer control stopped before this result could be delivered.");
        return result;
      } catch (error) {
        // A failure before any native session existed (such as an unavailable
        // helper) dispatched nothing and leaves the chat's permission as it was.
        if (lease === current && grant.revision === revision && current.nativeId && !signal.aborted) disable(grant);
        current.expectedClose ||= signal.aborted;
        const stopping = cleanup(current);
        if (!limit.signal.aborted) await stopping;
        if (call.post) return postWarning(call.post.receipt, "post_observation_failed", "human_takeover");
        const interrupted = failure(handoff ? "handoff_interrupted" : name === "computer_act" ? "dispatch_uncertain" : "operation_interrupted", `${error.message} Do not replay this call; inspect the native computer controls before continuing.`);
        return nativeResult && (name === "computer_act" || nativeResult.isError) ? withHandoff(nativeResult, interrupted) : interrupted;
      } finally {
        current.busy = false;
        signal.removeEventListener("abort", abort);
        armIdleRelease(current);
      }
    }, limit, admissionSignal);
  }
  function describeRequest(grant, request) {
    const target = targetFor(grant);
    return { id: request.id, reason: request.reason, computer: target.label, placement: target.placement,
      ...(request.reason === "setup" && target.placement === "remote" && request.detail ? { detail: request.detail } : {}),
      ...(request.appId ? { appId: request.appId } : {}), ...(request.purpose ? { purpose: request.purpose } : {}) };
  }
  /**
   * One in-chat request per chat. It resolves "ready" once macOS permissions
   * are granted and the chat is allowed, without the agent asking again.
   * @returns {Promise<"ready" | "dismissed" | "timeout" | "aborted" | "unavailable">}
   */
  function askPerson(grant, args, signal) {
    let request = requests.get(grant.sessionId);
    if (!request) {
      const id = randomUUID();
      let wake = () => {};
      let settled = null;
      const finished = new Promise((resolve) => {
        request = {
          id, reason: "setup", detail: "", waiters: 0, published: false, finished: Promise.resolve("aborted"),
          ...(typeof args.app_id === "string" ? { appId: args.app_id } : {}),
          ...(typeof args.purpose === "string" ? { purpose: args.purpose } : {}),
          settle: (answer) => { if (!settled) { settled = answer; resolve(answer); } },
          wake: () => wake(),
        };
      });
      requests.set(grant.sessionId, request);
      const current = request;
      const publish = () => onRequest(grant.sessionId, describeRequest(grant, current));
      void (async () => {
        const expires = now() + requestMs;
        while (!settled && !closed && now() < expires) {
          const status = await readiness(targetFor(grant));
          if (settled) break;
          if (["unsupported", "unavailable"].includes(status.readiness)) { current.settle("unavailable"); break; }
          const reason = /** @type {const} */ ("setup");
          if (reason !== current.reason || current.published !== true || status.detail !== current.detail) {
            current.reason = reason; current.detail = status.detail; current.published = true; publish();
          }
          if (status.readiness === "ready" && grant.enabled) { current.settle("ready"); break; }
          await new Promise((resolve) => { const timer = setTimeout(resolve, 1_500); timer.unref?.(); wake = () => { clearTimeout(timer); resolve(undefined); }; });
        }
        current.settle(closed ? "aborted" : "timeout");
      })();
      void finished.then(() => {
        if (requests.get(grant.sessionId) === current) requests.delete(grant.sessionId);
        onRequest(grant.sessionId, null);
      });
      request.finished = finished;
    }
    const current = request;
    current.waiters++;
    return new Promise((resolve) => {
      const abort = () => {
        resolve("aborted");
        // The last waiting call took the question back.
        if (--current.waiters === 0) current.settle("aborted");
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void current.finished.then((answer) => { signal.removeEventListener("abort", abort); resolve(answer); });
    });
  }
  const api = {
    async presentation(input) {
      if (!input || typeof input.visible !== "boolean" || Object.keys(input).some((key) => !["sessionId", "visible"].includes(key))) throw new Error("A chat and explicit monitor visibility are required.");
      const grant = grants.get(input.sessionId);
      const current = lease;
      if (!grant || current?.grant !== grant || !current.transport?.notifyUi) return null;
      try { assertUiActive(current); } catch { clearPresentation(current); return null; }
      if (!current.presentation) return null;
      const id = current.presentation.id;
      if (!input.visible || current.watchUntil <= now()) { delete current.presentation.frame; current.presentation.inputs = []; }
      current.watchUntil = input.visible ? now() + 1500 : 0;
      try {
        await current.transport.notifyUi({ id, action: "watch", visible: input.visible });
        assertUiActive(current);
      } catch {
        clearPresentation(current);
        if (lease === current && !current.closing) { disable(grant); void cleanup(current); }
        return null;
      }
      return current.presentation?.id === id ? structuredClone(current.presentation) : null;
    },
    async interact(input) {
      if (!input || !["approve", "deny", "takeover", "resume"].includes(input.action) || !uiText(input.id, 128) || !input.id
        || Object.keys(input).some((key) => !["sessionId", "id", "action", "windowId"].includes(key))
        || (input.action === "approve" ? !uiNumber(input.windowId, 0xffffffff) || !input.windowId : input.windowId !== undefined)) throw new Error("Choose an explicit action for this computer session. Sensitive actions still require your authorization.");
      const current = lease;
      if (!current || current.grant !== grants.get(input.sessionId) || !current.transport?.notifyUi) throw new Error("This chat does not own an active computer session.");
      assertUiActive(current);
      const presentation = current.presentation;
      if (!presentation || presentation.id !== input.id) throw new Error("This computer view is out of date. Refresh before acting.");
      if (["approve", "deny"].includes(input.action) ? presentation.phase !== "approval"
        : !current.nativeId || (input.action === "resume" ? presentation.phase !== "paused" || presentation.canContinue !== true : !["working", "paused"].includes(presentation.phase))) throw new Error("This control is not available in the current native phase.");
      if (input.action === "approve" && !presentation.windows.some((window) => window.id === input.windowId)) throw new Error("Choose a window from the current request.");
      if (input.action === "deny") {
        // "Not now" refuses this window only; the chat stays allowed.
        current.expectedClose = true;
        const denied = current.transport.notifyUi({ id: input.id, action: "deny" });
        clearPresentation(current);
        try { await denied; } finally { if (!await cleanup(current)) throw new Error(COMPUTER_STOP_GUIDANCE); }
        return;
      }
      if (input.action === "takeover") {
        invalidateObservation(current);
        current.needsObservation = true;
        current.handoffGeneration++;
        if (presentation.phase === "paused") return;
        // Reducing authority must not wait on a pending resume.
        try { await current.transport.notifyUi({ id: input.id, action: "takeover" }); }
        catch (error) {
          if (lease === current && !current.closing) { disable(current.grant); await cleanup(current); }
          throw error;
        }
        return;
      }
      if (current.uiControlPending || (input.action === "approve" && current.opening?.decisionSent)) throw new Error("A control decision is already pending. Wait for its current state; do not retry it.");
      current.uiControlPending = true;
      const generation = current.handoffGeneration;
      try {
        try {
          if (input.action === "approve") { await approveWindow(current, presentation, input.windowId); return; }
          assertUiActive(current);
        } catch (error) {
          if (lease === current && !current.closing) { disable(current.grant); await cleanup(current); }
          throw error;
        }
        const live = current.presentation;
        if (live?.id !== input.id || live.phase !== "paused" || live.canContinue !== true || current.handoffGeneration !== generation) {
          throw new Error("The native controls changed before Continue. Review their current state; no control was resumed.");
        }
        invalidateObservation(current);
        current.needsObservation = true;
        current.handoffGeneration++;
        try { await current.transport.notifyUi({ id: input.id, action: "resume" }); }
        catch (error) {
          if (lease === current && !current.closing) { disable(current.grant); await cleanup(current); }
          throw error;
        }
      } finally { current.uiControlPending = false; }
    },
    /** @param {ChatInput} input */
    async snapshot({ sessionId } = {}) { return view(await grantFor(sessionId), true); },
    /**
     * Stop from the Computer view or the pill: ends this task now and keeps the
     * chat allowed for the person's next message.
     * @param {ChatInput} input
     */
    async halt({ sessionId } = {}) {
      const grant = grants.get(sessionId) ?? await grantFor(sessionId);
      if (grant.enabled) disable(grant);
      if (lease?.grant === grant && !await cleanup(lease)) throw new Error(COMPUTER_STOP_GUIDANCE);
      return view(grant);
    },
    /**
     * Point this chat at another computer: this Mac or a connected VM. The
     * chat's allowance carries over; a running session is ended first, and
     * remembered windows belong to the previous computer.
     * @param {ChatInput & { targetId?: string }} input
     */
    async choose({ sessionId, targetId } = {}) {
      const adapter = targets.get(String(targetId ?? ""));
      if (!adapter || !offered().includes(adapter)) throw new Error("Choose one of the listed computers.");
      const grant = await grantFor(sessionId);
      if (targetFor(grant) === adapter && grant.adapter === adapter) return view(grant);
      if (lease?.grant === grant && !await cleanup(lease)) throw new Error(COMPUTER_STOP_GUIDANCE);
      advance(grant);
      grant.adapter = adapter;
      grant.windows = new Map();
      grant.enabled = true;
      await remember((state) => { state.targets.delete(grant.sessionId); state.targets.set(grant.sessionId, adapter.id); });
      requests.get(grant.sessionId)?.wake();
      return view(grant);
    },
    /**
     * The renderer reports the `computerUse` feature. Turning it off (including
     * the kill switch) ends any running session and every waiting request at
     * once; saved allowances stay, so turning it back on asks nobody again.
     */
    async setFeatureEnabled(enabled) {
      if (featureEnabled !== (enabled === true)) featureGeneration++;
      featureEnabled = enabled === true;
      if (featureEnabled) return true;
      for (const program of programs.values()) program.controller.abort(new Error("Computer use was turned off."));
      for (const request of requests.values()) request.settle("unavailable");
      if (lease) {
        lease.expectedClose = true;
        if (!await cleanup(lease)) throw new Error(COMPUTER_STOP_GUIDANCE);
      }
      return false;
    },
    /**
     * The renderer reports the `remoteComputers` feature. Turning it off ends a
     * session running on a VM at once; each chat keeps its saved choice and
     * returns to it when the feature is back on.
     */
    async setRemoteEnabled(enabled) {
      const update = ++remoteUpdateRevision;
      remoteRequested = enabled === true;
      // The app window may request a refresh, but only verified Den grants it.
      const authorized = enabled === true && await readRemoteFeatureEnabled().catch(() => false);
      if (update !== remoteUpdateRevision || closed || resetting) return remoteEnabled;
      enabled = authorized;
      if (remoteEnabled !== (enabled === true)) remoteGeneration++;
      remoteEnabled = enabled === true;
      if (!remoteEnabled) for (const program of programs.values()) if (program.remote) program.controller.abort(new Error("Remote computers were turned off."));
      for (const request of requests.values()) request.wake();
      if (!remoteEnabled && lease?.adapter.placement === "remote") {
        lease.expectedClose = true;
        if (!await cleanup(lease)) throw new Error(COMPUTER_STOP_GUIDANCE);
      }
      return remoteEnabled;
    },
    /**
     * The person's answer to an in-chat request: allow this chat, always
     * allow, or not now. Setup itself is answered by macOS permissions.
     * @param {ChatInput & { answer?: "dismiss" }} input
     */
    async answerRequest({ sessionId, answer } = {}) {
      const grant = await grantFor(sessionId);
      if (answer === "dismiss") requests.get(grant.sessionId)?.settle("dismissed");
      else throw new Error("Choose Not now to dismiss setup.");
      requests.get(grant.sessionId)?.wake();
      return view(grant);
    },
    /** @param {{ permission?: "accessibility" | "screenRecording" }} input */
    async setup({ permission } = {}) {
      if (closed || resetting || lease) throw new Error("Stop computer use before opening permission setup.");
      if (!["accessibility", "screenRecording"].includes(permission)) throw new Error("Choose Accessibility or Screen Recording settings.");
      const local = [...targets.values()].find((target) => target.placement === "local" && typeof target.setup === "function");
      if (!local?.setup) throw new Error("Permission setup is only for this computer.");
      return local.setup(permission);
    },
    /** @param {{ setupId?: string }} input */
    async dismissSetup({ setupId } = {}) {
      for (const target of targets.values()) if (typeof target.dismissSetup === "function") await target.dismissSetup(typeof setupId === "string" ? setupId : undefined);
    },
    /**
     * Run bounded UI code under the same flag, chat and stop generation as
     * direct tools. Browser calls still pass through their normal task host.
     * @param {import("@openwork/computer-use/runtime").ProgramRequest & ChatInput} input
     * @param {{ signal?: AbortSignal }} options
     */
    async program(input, { signal = new AbortController().signal } = {}) {
      if (!featureEnabled || closed || resetting || !runProgram) return { ok: false, error: { code: "computer_unavailable", message: "Computer use is not enabled." } };
      if (!input || !["computer", "browser"].includes(input.surface) || typeof input.code !== "string" || input.code.length > 32_000
        || input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 60_000)) return { ok: false, error: { code: "invalid_arguments", message: "Provide a surface, bounded code and a timeout from 1000 to 60000 milliseconds." } };
      const grant = await grantFor(input.sessionId);
      if (!grant.enabled) return { ok: false, error: { code: "computer_stopped", message: "Computer use stopped for this turn. Continue with the person's next message." } };
      if (programs.has(grant.sessionId)) return { ok: false, error: { code: "program_busy", message: "A program is already running in this chat." } };
      const generation = featureGeneration;
      const revision = grant.revision;
      const remote = input.surface === "computer" && targetFor(grant).placement === "remote";
      const remoteRevision = remoteGeneration;
      const controller = new AbortController();
      const current = { controller, remote };
      const active = AbortSignal.any([signal, controller.signal, grant.controller.signal]);
      const check = () => {
        active.throwIfAborted();
        if (!featureEnabled || generation !== featureGeneration || revision !== grant.revision || closed || resetting || remote && remoteRevision !== remoteGeneration) throw new Error("The computer program stopped or its target changed.");
      };
      programs.set(grant.sessionId, current);
      try {
        check();
        return await runProgram(input, {
          computer: async (name, args, callSignal) => { check(); const result = await api.execute({ sessionId: grant.sessionId, name, args }, { signal: AbortSignal.any([active, callSignal]), includePostImage: false }); check(); return result; },
          browser: async (operation, args, callSignal) => { check(); if (!browserTask) throw new Error("The browser is unavailable."); const result = await browserTask({ sessionId: grant.sessionId, operation, args }, { signal: AbortSignal.any([active, callSignal]) }); check(); return result; },
        }, active);
      } catch {
        return { ok: false, error: { code: "program_stopped", message: "The program stopped. Previously dispatched actions were not replayed." }, mayHaveActed: true };
      } finally { if (programs.get(grant.sessionId) === current) programs.delete(grant.sessionId); }
    },
    /**
     * Tool calls from the engine, scoped to the requesting chat by the bridge.
     * @param {ChatInput & { name?: string, args?: Record<string, unknown> }} input
     * @param {{ signal?: AbortSignal, includePostImage?: boolean }} options
     * @returns {Promise<ComputerResult>}
     */
    async execute({ sessionId, name, args } = {}, { signal = new AbortController().signal, includePostImage = true } = {}) {
      let limit = null;
      try {
        if (!Object.hasOwn(COMPUTER_TOOLS, name)) return failure("unknown_tool", "This computer tool does not exist.");
        if (typeof sessionId !== "string" || !sessionId.trim()) return failure("missing_session", "Computer use requires a requesting chat.");
        if (!args || Array.isArray(args) || typeof args !== "object" || Object.keys(args).some((key) => !(ARGUMENTS[name] ?? []).includes(key))) {
          return failure("invalid_arguments", "Only native computer arguments are accepted; session and receipt identities belong to OpenWork.");
        }
        if (name === "computer_act" && (args.action === undefined) === (args.actions === undefined)) return failure("invalid_arguments", "Provide exactly one of action or actions.");
        if (closed || resetting) return failure("stopping", "Computer use is stopping or restarting. Nothing was dispatched.");
        if (!featureEnabled) return failure("computer_unavailable", "Computer use is not turned on in this OpenWork app. Use connected apps or the browser instead.");
        const generation = featureGeneration;
        const remoteRevision = remoteGeneration;
        const grant = await grantFor(sessionId);
        if (targetFor(grant).placement === "remote" && !await readRemoteFeatureEnabled().catch(() => false)) {
          await api.setRemoteEnabled(false);
          return failure("computer_unavailable", "Your organization's remote computer feature could not be verified. Nothing was dispatched.");
        }
        if (!grant.enabled) {
          return failure("not_allowed", "Computer use stopped earlier in this turn, because the person stopped it or after a failure. It turns back on with the person's next message, so do not ask them to re-enable it; tell them what failed.");
        }
        // Setup or this chat's allowance missing: ask the person in the chat and
        // carry on once they answer, so the agent never has to ask them itself.
        const status = name === "computer_discover" || name === "computer_open" ? await readiness(targetFor(grant)) : null;
        if (status && status.readiness !== "ready") {
          if (status && ["unsupported", "unavailable"].includes(status.readiness)) return failure("setup_required", status.detail);
          const answer = await askPerson(grant, args, signal);
          if (answer !== "ready") {
            return failure("not_allowed", answer === "dismissed"
              ? "The person dismissed computer setup. Nothing was dispatched. Do not ask again unless they bring it up; continue another way."
              : answer === "unavailable" ? "Computer use is not turned on in this OpenWork app. Use connected apps or the browser instead."
              : "Computer setup did not finish in time. Nothing was dispatched. Tell the person it is waiting for the Computer card in the chat.");
          }
        }
        if (!featureEnabled || generation !== featureGeneration || grant.adapter.placement === "remote" && remoteRevision !== remoteGeneration) return failure("computer_unavailable", "Computer use was turned off while this request was waiting. Nothing was dispatched.");
        const call = { name, includePostImage, args: structuredClone(args), grant, revision: grant.revision, featureGeneration: generation, remoteGeneration: remoteRevision, remoteTarget: grant.adapter.placement === "remote" };
        // The operation budget starts once the person has answered.
        limit = deadline(operationMs);
        return deliverResult(call, await run(call, signal, limit));
      } catch (error) {
        return failure("computer_error", `${error instanceof Error ? error.message : String(error)} Do not replay this call; inspect the computer controls before continuing.`);
      } finally { limit?.dispose(); }
    },
    /**
     * The chat's turn ended: release its native session and re-arm Always allow.
     * @param {ChatInput} input
     */
    async endTurn({ sessionId } = {}) {
      if (typeof sessionId !== "string" || !sessionId) return true;
      if (lease?.grant.sessionId === sessionId) return release(lease);
      await rearm(sessionId);
      return true;
    },
    /** @param {ChatInput} input */
    async revoke({ sessionId } = {}) {
      for (const grant of grants.values()) if (!sessionId || grant.sessionId === sessionId) disable(grant);
      if (lease && (!sessionId || lease.grant.sessionId === sessionId)) return cleanup(lease);
      return true;
    },
    async reset(shutdown = false) {
      resetting++;
      if (shutdown) { closed = true; clearInterval(remoteFeatureTimer); }
      try { return await api.revoke(); }
      finally { resetting--; }
    },
  };
  // Poll authority even while the renderer is on another screen or suspended.
  const remoteFeatureTimer = setInterval(() => {
    if (remoteRequested && !closed && !resetting) void api.setRemoteEnabled(true).catch(() => {});
  }, 30_000);
  remoteFeatureTimer.unref?.();
  return api;
}
