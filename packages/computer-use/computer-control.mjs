// The computer broker owns per-chat control, each chat's native session leases,
// each computer's turn at the keyboard and pointer, receipts, observations and
// handoff. A model's session_id picks only among its own chat's apps; model
// arguments never select another chat's session, a receipt identity, helper
// command or credential.
import { randomUUID } from "node:crypto";
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
  computer_open: ["app_id", "pid", "window_id", "mode", "purpose", "screenshot", "file"],
  computer_observe: ["session_id", "include_image", "elements", "menus"],
  computer_act: ["session_id", "observation_id", "action", "actions", "intent", "screenshot", "pacing", "retry_ms", "input"],
  computer_zoom: ["session_id", "observation_id", "x", "y", "width", "height"],
  computer_status: ["session_id"],
  computer_close: ["session_id"],
});
/** How many apps one chat keeps open at once on a parallel computer, each in its own window. */
export const APPS_PER_CHAT = 3;
const failure = (code, message, extra = {}) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, code, message, ...extra }) }] });
const stateOf = (result) => {
  try { return JSON.parse(result.content.find((part) => part.type === "text").text); } catch { return null; }
};
const needsPerson = (result) => stateOf(result)?.state === "paused" || ["paused", "session_paused"].includes(stateOf(result)?.code);
const withHandoff = (result, status) => {
  const state = stateOf(status);
  const continued = !status.isError && state?.ok === true && state.state === "active";
  return { ...result, isError: result.isError === true || !continued,
    content: [...result.content, { type: "text", text: JSON.stringify({ handoff: state, next: continued ? "observe" : "human_takeover", fresh_observation_required: true, actions_replayed: false }) }] };
};
const withPostObservation = (receipt, status, content = [], extra = {}) => ({ ...receipt, content: [...receipt.content,
  { type: "text", text: JSON.stringify({ post_observation: status, actions_replayed: false,
    ...(!status.ok ? { next: status.next, fresh_observation_required: true } : {}), ...extra }) }, ...content] });
const COORDINATE_ACTIONS = new Set(["move", "click", "double_click", "triple_click", "scroll", "drag"]);
const actionEntries = (args) => [args.action, ...(Array.isArray(args.actions) ? args.actions : [])].filter((entry) => entry && typeof entry === "object");
/** Command-C, Command-X or Command-V: a copy, cut or paste through the agent's clipboard. */
const isClipboardStep = (entry) => entry.type === "key" && typeof entry.key === "string" && ["c", "x", "v"].includes(entry.key.toLowerCase())
  && Array.isArray(entry.modifiers) && entry.modifiers.includes("command");
const observationPart = (content) => {
  for (const [index, part] of content.entries()) {
    if (part.type !== "text") continue;
    let value;
    try { value = JSON.parse(part.text); } catch { continue; }
    if (value && typeof value.observation_id === "string" && Array.isArray(value.elements)) return { index, value };
  }
  return null;
};
/**
 * An observation that lists only the elements changed since `previous`, the listing
 * the model last saw in full. The helper keeps each control's ref across observations
 * of a window (`refs: "stable"`), so refs the model holds stay valid; without that,
 * on another window or element filter, or when most of the list changed, it is full.
 * @param {{ window: unknown, filter: unknown, elements: Map<string, string> } | null | undefined} previous
 * @param {Array<{ type: string, text?: string }>} content
 */
export function listChanges(previous, content) {
  const found = observationPart(content);
  if (!found) return { content, listing: null };
  const { index, value } = found;
  if (value.refs !== "stable") return { content, listing: null };
  const listing = { window: value.window_id, filter: value.elements_filter,
    elements: new Map(value.elements.map((element) => [element.ref, JSON.stringify(element)])) };
  if (!previous || previous.window !== listing.window || previous.filter !== listing.filter) return { content, listing };
  const changed = value.elements.filter((element) => previous.elements.get(element.ref) !== listing.elements.get(element.ref));
  const removed = [...previous.elements.keys()].filter((ref) => !listing.elements.has(ref));
  if (changed.length + removed.length > value.elements.length / 2) return { content, listing };
  const compact = { ...value, elements: changed, elements_listing: "changes", elements_unchanged: value.elements.length - changed.length,
    ...(removed.length ? { elements_removed: removed.slice(0, 200) } : {}),
    elements_note: "Only elements that changed or appeared since your last observation are listed. Refs you already have stay valid unless listed in elements_removed." };
  return { content: content.map((part, at) => at === index ? { type: "text", text: JSON.stringify(compact) } : part), listing };
}
const postWarning = (receipt, code, next = "observe") => withPostObservation(receipt, { ok: false, code, next,
  message: "The fresh observation is unavailable. The original receipt is unchanged; do not replay the input. Review the current control state before observing again." });
/** Apps on this Mac the agent can drive through their own scripting interface. */
export const SCRIPT_APPS = Object.freeze(["applescript", "jxa", "blender"]);
const setupNotFinished = (answer) => failure("not_allowed", answer === "dismissed"
  ? "The person dismissed computer setup. Nothing was dispatched. Do not ask again unless they bring it up; continue another way."
  : answer === "unavailable" ? "Computer use is not turned on in this OpenWork app. Use connected apps or the browser instead."
  : "Computer setup did not finish in time. Nothing was dispatched. Tell the person to finish it in Settings > Computer use, then ask again.");
// A call made in the wrong order dispatched nothing: report it without revoking or closing anything.
const SEQUENCE_CODES = new Set(["session_open", "session_required"]);
const uiText = (value, limit) => typeof value === "string" && value.length <= limit;
const uiNumber = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max;
/** The Mac and Windows helpers take at most this many drag points. */
export const DRAG_POINTS = 32;
/** The most a drag may ask for; anything longer than DRAG_POINTS is fitted to it. */
export const DRAG_POINTS_ACCEPTED = 256;

/**
 * The same stroke in at most `max` of its own points. Repeatedly drops the point
 * nearest the line between its neighbours, so the start, the end and every corner
 * stay. A long or closed outline then keeps its shape instead of being refused.
 * @param {Array<{ x: number, y: number }>} path
 */
export function fitDragPath(path, max = DRAG_POINTS) {
  const points = [...path];
  const offset = (index) => {
    const { x, y } = points[index], a = points[index - 1], b = points[index + 1];
    const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length)) : 0;
    return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
  };
  while (points.length > Math.max(2, max)) {
    let drop = 1;
    for (let index = 2; index < points.length - 1; index++) if (offset(index) < offset(drop)) drop = index;
    points.splice(drop, 1);
  }
  return points;
}

/**
 * A drag marked `smooth` draws a curve through its points (Catmull-Rom) instead of straight
 * lines between them, as DRAG_POINTS points. Every given point stays on the stroke, and the
 * steps between them are shared out by length. It never leaves the box the given points
 * span, so it stays inside the observation they were checked against.
 * @param {Array<{ x: number, y: number }>} path
 */
export function smoothDragPath(path, max = DRAG_POINTS) {
  const points = path.length > max ? fitDragPath(path, max) : path.map(({ x, y }) => ({ x, y }));
  if (points.length < 3) return points;
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  const clamp = (value, values) => Math.round(Math.min(Math.max(value, Math.min(...values)), Math.max(...values)));
  // Each segment as a fine curve, with its running length.
  const segments = points.slice(0, -1).map((b, index) => {
    const a = points[Math.max(0, index - 1)], c = points[index + 1], d = points[Math.min(points.length - 1, index + 2)];
    const curve = [b];
    for (let step = 1; step <= 16; step++) {
      const t = step / 16, t2 = t * t, t3 = t2 * t;
      const at = (p0, p1, p2, p3) => 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3);
      curve.push({ x: at(a.x, b.x, c.x, d.x), y: at(a.y, b.y, c.y, d.y) });
    }
    const lengths = [0];
    for (let at = 1; at < curve.length; at++) lengths.push(lengths[at - 1] + Math.hypot(curve[at].x - curve[at - 1].x, curve[at].y - curve[at - 1].y));
    return { curve, lengths, length: lengths.at(-1) };
  });
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  if (!total) return points;
  // At least one step per segment, the rest by length, adding up to max - 1.
  const steps = segments.map((segment) => Math.max(1, Math.round(segment.length / total * (max - 1))));
  for (let extra = steps.reduce((sum, count) => sum + count, 0) - (max - 1); extra !== 0; extra += extra > 0 ? -1 : 1) {
    const order = steps.map((count, index) => index).sort((a, b) => segments[b].length / steps[b] - segments[a].length / steps[a]);
    const index = extra > 0 ? order.reverse().find((candidate) => steps[candidate] > 1) : order[0];
    if (index === undefined) break;
    steps[index] += extra > 0 ? -1 : 1;
  }
  const result = [{ ...points[0] }];
  segments.forEach(({ curve, lengths, length }, index) => {
    let at = 0;
    for (let step = 1; step < steps[index]; step++) {
      const along = length * step / steps[index];
      while (at < curve.length - 2 && lengths[at + 1] < along) at++;
      const span = lengths[at + 1] - lengths[at];
      const t = span ? Math.min(1, (along - lengths[at]) / span) : 0;
      result.push({ x: clamp(curve[at].x + (curve[at + 1].x - curve[at].x) * t, xs), y: clamp(curve[at].y + (curve[at + 1].y - curve[at].y) * t, ys) });
    }
    result.push({ ...points[index + 1] });
  });
  return result;
}

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
 * @typedef {{ sessionId?: string, rootSessionId?: string, agentName?: string }} ChatInput
 * @typedef {{ ok?: boolean, error?: { code: string, message: string }, mayHaveActed?: boolean, [key: string]: unknown }} ScriptResult
 * @typedef {{ id: string, reason: "setup" | "script" | "files" | "credential", computer: string, placement: "local" | "remote", detail?: string, appId?: string, purpose?: string, standing?: boolean, script?: { app: string, code: string }, files?: { app: string, names: string[], save?: boolean }, credential?: { site?: string, app?: string, appId?: string } }} ComputerRequest
 * @typedef {{ targets?: Record<string, string>, computer?: string }} SavedChoices
 * @typedef {{ effect: "allow" } | { effect: "ask" } | { effect: "deny", message: string }} MoveDecision
 * @typedef {{ kind: "files", app: string, names: string[], save?: boolean } | { kind: "clipboard" }} ContentMove
 * @typedef {{ answer: "allow" } | { answer: "blocked", message: string } | { answer: "dismiss" | "aborted" | "timeout" | "busy" | "too_many" }} MoveAnswer
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
 *   parallel?: boolean,
 *   readiness: () => Promise<{ readiness: string, detail: string, permissions?: { accessibility: boolean, screenRecording: boolean } }>,
 *   setup?: (permission: "accessibility" | "screenRecording") => Promise<{ setupId: string }>,
 *   dismissSetup?: (setupId?: string) => Promise<void>,
 *   connect: (options: { signal: AbortSignal, presence: { name: string, color: string } | null, background?: boolean, onUi: (value: unknown) => void, onClose: () => void }) => Promise<ComputerTransport>,
 * }} ComputerAdapter
 */


// Approving a browser app cannot say which website gets a password, so browsers take none
// through computer use; OpenWork's own browser confirms the exact site. Matched on the parts
// of Mac bundle ids, Windows executables and Linux window classes ("google-chrome",
// "microsoft-edge", "Navigator"): a false match only leaves sign-in to the person.
const WEB_BROWSER_PARTS = new Set(["chrome", "chromium", "edge", "msedge", "edgemac", "firefox", "mozilla", "navigator", "safari",
  "brave", "opera", "operasoftware", "vivaldi", "arc", "thebrowser", "browser", "iexplore", "librewolf", "waterfox", "floorp", "zen",
  "epiphany", "falkon", "konqueror", "midori", "qutebrowser", "seamonkey", "palemoon", "yandex", "whale", "thorium",
  "torbrowser", "mullvadbrowser", "duckduckgo", "kagimacos", "orion"]);
const isWebBrowser = (app) => String(app).toLowerCase().split(/[^a-z0-9]+/).some((part) => WEB_BROWSER_PARTS.has(part));
/** Cursor colors for a chat's subagents, in the order they start; none is OpenWork's own blue. */
const AGENT_COLORS = ["#30a46c", "#f76b15", "#8e4ec6", "#d6409f", "#12a594", "#e5484d"];
/** The most agents' windows a stage tiles, as the Mac helper's WindowArrangement.stageLimit. */
const STAGE_LIMIT = 6;

/**
 * Adapters are trusted main-process dependencies, never renderer or model
 * input: "This Mac" (the native helper) or "This PC" (the Windows helper), and
 * any remote computer such as a Linux VM (see computer-remote.mjs). Every
 * adapter speaks the same seven-tool contract; Settings picks one for every
 * chat, starting on this computer on a Mac or a Windows PC. connect() owns a dedicated session
 * scope; close() MUST confirm session revocation, not merely disconnect. One
 * controller across all chats and computers. A `parallel` adapter's helper
 * locks each window and keeps input apart, so each chat gets its own session
 * there and control calls take turns at the keyboard and pointer, one call at
 * a time, never through the model's thinking. Other computers serve one chat.
 * @param {{
 *   adapters: ComputerAdapter[],
 *   runProgram?: (request: import("@openwork/computer-use/runtime").ProgramRequest, host: import("@openwork/computer-use/runtime").ProgramHost, signal: AbortSignal, options: import("@openwork/computer-use/runtime").ProgramOptions) => Promise<import("@openwork/computer-use/runtime").ProgramResult>,
 *   browserTask?: (request: { sessionId: string, operation: string, args: Record<string, unknown> }, options: { signal: AbortSignal }) => Promise<unknown>,
 *   readRemoteFeatureEnabled?: () => Promise<boolean>,
 *   standing?: { read: () => Promise<SavedChoices>, write: (state: SavedChoices) => Promise<void> },
 *   presence?: { name: string, color: string } | null,
 *   permissionEntry?: () => Promise<{ name: string, ours: boolean }>,
 *   onRequest?: (sessionId: string, request: ComputerRequest | null) => void,
 *   movePolicy?: (input: { kind: "computer_files" | "computer_clipboard", sessionId: string }) => Promise<MoveDecision>,
 *   saveFolder?: (sessionId: string) => Promise<string | null>,
 *   requestMs?: number,
 *   runScript?: (request: { app: string, code: string, timeoutMs: number }, signal: AbortSignal) => Promise<ScriptResult>,
 *   onTiming?: (sessionId: string, step: { name: string, computerMs: number, modelMs?: number, followed?: boolean }) => void,
 *   cleanupMs?: number, operationMs?: number, pollMs?: number, idleMs?: number, now?: () => number, platform?: string,
 * }} options
 */
export function createComputerControl({ adapters, runProgram, runScript, onTiming = () => {}, browserTask, readRemoteFeatureEnabled = async () => false, standing = { read: async () => ({ targets: {} }), write: async (_state) => {} }, presence = null, platform = process.platform,
  permissionEntry = async () => ({ name: "OpenWork", ours: false }), onRequest = () => {}, movePolicy = async (_input) => ({ effect: "allow" }),
  saveFolder = async (_sessionId) => null,
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
  /** Before anything is chosen: this computer on a Mac or a Windows PC, an available VM elsewhere. */
  const firstTarget = ["darwin", "win32"].includes(platform) ? defaultTarget : [...targets.values()].find((target) => target.placement === "remote") ?? defaultTarget;
  const offered = () => [...targets.values()].filter((target) => target.placement === "local" || remoteEnabled);
  /** The computer a chat really uses: its choice, unless remote computers are turned off. */
  const targetFor = (grant) => { const adapter = head(grant).adapter; return adapter.placement === "remote" && !remoteEnabled ? defaultTarget : adapter; };
  for (const value of [cleanupMs, operationMs, pollMs, idleMs, requestMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error("Computer time limits must be positive bounded milliseconds.");
  const grants = new Map();
  const requests = new Map();
  const programs = new Map();
  /** Per chat: the script waiting for the person's approval. */
  const scriptRequests = new Map();
  /** Every running script, so turning computer use off stops it. */
  const scripts = new Set();
  /**
   * Native sessions by lease key: one helper connection per app window. A chat holds one on
   * most computers, and up to APPS_PER_CHAT on a parallel one.
   */
  const leases = new Map();
  /** Per chat: files a save_as step confirmed on this computer, which the person may open from the chat. */
  const savedFiles = new Map();
  /** Per computer: whose control call has the keyboard and pointer, and who waits. */
  const slots = new Map();
  /** Chats on screen in a visible OpenWork window, as the desktop reports them (debounced there). */
  const watched = new Set();
  let featureEnabled = false;
  let featureGeneration = 0;
  let remoteGeneration = 0;
  let remoteUpdateRevision = 0;
  // `remoteComputers`: off, VMs are hidden and every chat uses a local computer.
  let remoteEnabled = false;
  let remoteRequested = false;
  // `standardCodeMode`: on, programs run as standard JavaScript.
  let standardCodeMode = false;
  // `parallelComputerUse`: on, a subagent works on its chat's computer as part of the chat.
  let parallelAgents = false;
  let saved = null;
  let loadingChoices = null;
  let remembering = Promise.resolve();
  let closed = false;
  let resetting = 0;
  const mine = (grant) => [...leases.values()].filter((current) => current.grant === grant);
  /**
   * A subagent works for the chat that started it, its root in the engine's session tree. That
   * chat's computer, Stop, Take over and Continue, questions and output folder are its; its
   * apps, leases, steps and approvals stay its own.
   */
  const rootOf = (grant) => parallelAgents ? grant.root ?? null : null;
  const head = (grant) => rootOf(grant) ?? grant;
  /** The chat and every subagent working for it. */
  const crew = (grant) => [...grants.values()].filter((other) => head(other) === head(grant));
  const crewLeases = (grant) => [...leases.values()].filter((current) => head(current.grant) === head(grant));
  /** What the chat's Computer view shows: a subagent's view shows its own apps, the chat's every agent's. */
  const shownLeases = (grant) => rootOf(grant) ? mine(grant) : crewLeases(grant);
  /** A takeover of any of the chat's apps pauses all its agents until Continue. */
  const handoffOf = (grant) => crew(grant).find((other) => other.handoff) ?? null;
  /** Where the chat's questions to the person show: in the chat itself, never only in a subagent. */
  const chatKey = (grant) => head(grant).sessionId;
  /** Subagent sessions by the chat that started them, as the trusted bridge reports them. */
  const roots = new Map();
  /**
   * Who the cursor says is acting. The chat itself is OpenWork's own presence; each subagent
   * shows its short description, or else its agent's name, in a color of its own that stays
   * the same for the rest of the chat. Display only, never authority.
   */
  function presenceFor(grant) {
    // With `parallelComputerUse` off every helper shows the one presence, as before.
    const chat = rootOf(grant);
    if (!chat) return presence;
    chat.agents ??= new Map();
    if (!chat.agents.has(grant.sessionId)) chat.agents.set(grant.sessionId, chat.agents.size);
    const turn = chat.agents.get(grant.sessionId);
    return { name: grant.agentName ?? `Agent ${turn + 1}`, color: AGENT_COLORS[turn % AGENT_COLORS.length] };
  }
  /** The chat's app a call goes to when it names none: the one it opened last. */
  const appOf = (grant) => grant.apps.get(grant.latest) ?? null;
  const leaseOf = (grant, app = appOf(grant)) => mine(grant).find((current) => current.app === app) ?? null;
  /** The session Watch live shows: one the person took over, else the app being worked in, else the one used last. */
  const shownLease = (grant) => { const own = shownLeases(grant); return own.find((current) => current.presentation?.phase === "paused") ?? own.find((current) => current.busy)
    ?? own.reduce((shown, current) => !shown || (current.usedAt ?? 0) > (shown.usedAt ?? 0) ? current : shown, null); };
  const leased = (current) => leases.get(current.key) === current;
  /**
   * The person watches this chat, so This Mac's helper works in front, beside OpenWork, and
   * otherwise in the background. `beside` is false while the chat has several apps open:
   * the agent arranges those itself.
   */
  const followArgs = (grant, current) => current.adapter.parallel === true
    ? { following: isWatched(grant), beside: [...grant.apps.values()].every((app) => app === current.app) && !othersOpen(grant), ...stageOf(grant, current) } : {};
  /**
   * While the person watches a chat with two or more agents working in apps, the chat owns one
   * stage: each agent's window gets a tile, in the order the apps opened, and every helper
   * moves only its own window there (see WindowArrangement.stage). A count of zero clears it.
   */
  function stageOf(grant, current) {
    if (!parallelAgents) return {};
    const members = crewLeases(grant).filter((other) => other.adapter.parallel === true && !other.closing && (other.app || other === current))
      .sort((a, b) => (a.openedAt ?? 0) - (b.openedAt ?? 0));
    const slot = members.indexOf(current);
    const staged = watched.has(chatKey(grant)) && new Set(members.map((other) => other.grant)).size >= 2 && slot >= 0 && members.length <= STAGE_LIMIT;
    return staged ? { stage_slot: slot, stage_count: members.length } : { stage_count: 0 };
  }
  /** A subagent's work is in view while the person watches its chat, or its own thread. */
  const isWatched = (grant) => watched.has(grant.sessionId) || watched.has(chatKey(grant));
  /** Another of the chat's agents has an app open, so neither goes beside OpenWork on its own. */
  const othersOpen = (grant) => crewLeases(grant).some((other) => other.grant !== grant && !other.closing);
  /** Tells each helper of the chat's agents whether the person watches. Their own close handling covers a lost helper. */
  function tellFollowing(grant) {
    for (const current of crewLeases(grant)) {
      const id = current.presentation?.id;
      if (!id || !current.transport?.notifyUi || current.closing || current.adapter.parallel !== true) continue;
      void current.transport.notifyUi({ id, action: "watch", ...followArgs(current.grant, current) }).catch(() => {});
    }
  }
  /** Orders the chat's apps by their last call. */
  let uses = 0;
  const listApps = (grant) => [...grant.apps.values()].map((app) => ({ session_id: app.id, app_id: app.lastOpen.app_id,
    ...(Number.isSafeInteger(app.lastOpen.window_id) ? { window_id: app.lastOpen.window_id } : {}) }));
  function forget(grant, app) {
    if (!app || grant.apps.get(app.id) !== app) return;
    grant.apps.delete(app.id);
    if (grant.latest === app.id) grant.latest = [...grant.apps.keys()].at(-1) ?? null;
  }
  /** Only the Mac's own helper opens an app onto a file and keeps an agent clipboard. */
  const opensOnFiles = (target) => platform === "darwin" && target.placement === "local";
  /**
   * The open request with this chat's clipboard key: every helper of the chat keeps the
   * agent's copy, and the person's clipboard, under it, so a paste in another app's
   * session finds what one copied, and the person's clipboard comes back once.
   */
  const withClipboard = (current, args) => opensOnFiles(current.adapter) ? { ...args, clipboard: head(current.grant).clipboardKey ??= randomUUID() } : args;
  /** The person took over another chat's session on this chat's computer. */
  const takenOverElsewhere = (grant) => [...grants.values()].some(owner => head(owner) !== head(grant) && owner.handoff && owner.handoffTarget === targetFor(grant).id);
  /**
   * Waits for this computer's keyboard and pointer, first come first served.
   * Resolves to a release function that is safe to call more than once.
   * @param {string} targetId
   * @param {AbortSignal} signal
   * @returns {Promise<() => void>}
   */
  function focusSlot(targetId, signal) {
    signal.throwIfAborted();
    let slot = slots.get(targetId);
    if (!slot) slots.set(targetId, slot = { held: false, waiting: [] });
    const take = () => {
      slot.held = true;
      let released = false;
      return () => {
        if (released) return;
        released = true; slot.held = false;
        const next = slot.waiting.shift();
        if (next) next();
        else if (slots.get(targetId) === slot) slots.delete(targetId);
      };
    };
    if (!slot.held) return Promise.resolve(take());
    return new Promise((resolve, reject) => {
      const admit = () => { signal.removeEventListener("abort", abort); resolve(take()); };
      const abort = () => {
        const index = slot.waiting.indexOf(admit);
        if (index >= 0) slot.waiting.splice(index, 1);
        reject(signal.reason);
      };
      slot.waiting.push(admit);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  function invalidateObservation(current) {
    current.observationGeneration = (current.observationGeneration ?? 0) + 1;
  }
  /**
   * Per chat: how long the computer took for each step, and how long the model took
   * since the previous step returned. Both stay on this computer.
   */
  function recordStep(grant, name, startedAt, followed) {
    const finished = now();
    const computerMs = Math.max(0, finished - startedAt);
    const modelMs = grant.lastStepAt === undefined ? undefined : Math.max(0, startedAt - grant.lastStepAt);
    grant.lastStepAt = finished;
    const timing = grant.timing ??= { steps: 0, computerMs: 0, modelMs: 0 };
    timing.steps++; timing.computerMs += computerMs; timing.modelMs += modelMs ?? 0;
    timing.last = { name, computerMs, ...(modelMs === undefined ? {} : { modelMs }), ...(typeof followed === "boolean" ? { followed } : {}) };
    try { onTiming(grant.sessionId, timing.last); } catch { /* Reporting never affects the step. */ }
  }
  /**
   * Shows the full script in the chat and waits for Run or Don't run: only for an
   * organization that asks before each script, so nothing is remembered. Stop, turning
   * computer use off and the call's own cancellation answer no.
   * @returns {Promise<"allow" | "always" | "dismiss" | "aborted" | "timeout">}
   */
  function approveScript(grant, app, code, signal) {
    const target = targetFor(grant);
    return approve(grant, { id: randomUUID(), reason: /** @type {const} */ ("script"), computer: target.label, placement: target.placement,
      standing: false, script: { app, code } }, signal);
  }
  /**
   * The one check for content the agent moves between apps: files it hands to an app (a
   * file panel, `open_file`, `computer_open({ file })`), files it saves or exports
   * (`save_as`), and its own clipboard. The organization decides in Agent permissions.
   * With no rule the agent goes ahead and nothing asks; Ask first shows each file, every
   * time; Block refuses. The clipboard is on or off.
   * Callers: `approveMove(grant, { kind: "files" | "clipboard", app?, names?, save? }, signal)`.
   * Saves (`save_as`, `save_image`) and Open-panel picks are kind `files`. A shortcut for
   * the chat's own files may skip only the Ask first card, never a block. A policy that
   * cannot be read refuses with a clear message; it never falls back to asking.
   * @param {ContentMove} move
   * @param {AbortSignal} signal
   * @returns {Promise<MoveAnswer>}
   */
  async function approveMove(grant, move, signal) {
    const files = move.kind === "files";
    /** @type {MoveDecision} */
    let decision;
    try { decision = await movePolicy({ kind: files ? "computer_files" : "computer_clipboard", sessionId: grant.sessionId }); }
    catch { decision = { effect: "deny", message: "Your organization's agent permissions could not be checked." }; }
    if (decision?.effect === "allow") return { answer: "allow" };
    // A switch cannot ask: copy and paste that asks is blocked, as Den stores it.
    if (decision?.effect !== "ask" || !files) {
      return { answer: "blocked", message: decision?.effect === "deny" && typeof decision.message === "string" ? decision.message : "Your organization's agent permissions block this." };
    }
    const answer = await approveFiles(grant, { app: move.app, names: move.names, ...(move.save ? { save: true } : {}), everyTime: true }, signal);
    return answer === "always" || answer === "allow" ? { answer: "allow" } : { answer };
  }
  /**
   * Shows which files an app or page is about to receive and waits for Send, Always
   * allow in this chat, or Don't send. Files leave this computer only on that answer.
   * `everyTime`: the organization asks about each file, so nothing is remembered.
   * `save`: the one name is where the app will save a file; the card asks to save it there.
   * @param {{ app: string, names: string[], save?: boolean, everyTime?: boolean }} files
   * @returns {Promise<"allow" | "always" | "dismiss" | "aborted" | "timeout" | "busy" | "too_many">}
   */
  async function approveFiles(grant, files, signal) {
    // The card lists every file exactly; anything it could not show is never approved.
    if (files.names.length > 20 || files.names.some((name) => typeof name !== "string" || !name || name.length > 1024)) return "too_many";
    // The recipient is the approval's key: refused when too long to show, never shortened.
    const app = String(files.app);
    if (!app || app.length > 200) return "too_many";
    const everyTime = files.everyTime === true;
    const save = files.save === true && files.names.length === 1;
    // "Always" covers only the recipient it was given for, and only handing over files.
    if (files.names.length && !everyTime && grant.filesAlwaysFor?.has(app)) return "always";
    if (scriptRequests.has(chatKey(grant))) return "busy";
    const target = targetFor(grant);
    const names = [...files.names];
    const answer = await approve(grant, { id: randomUUID(), reason: /** @type {const} */ ("files"), computer: target.label, placement: target.placement,
      ...(everyTime ? { standing: false } : {}), files: { app, names, ...(save ? { save } : {}) } }, signal);
    if (everyTime) return answer === "always" ? "allow" : answer;
    // Allowing a panel to be browsed lists no files, so it never becomes a standing approval.
    if (answer === "always" && !names.length) return "allow";
    if (answer === "always") (grant.filesAlwaysFor ??= new Set()).add(app);
    return answer;
  }
  /**
   * A password or one-time code is about to be typed: into a page of the built-in
   * browser (`site`, an exact origin) or into a native app (`app`, its id). The person
   * confirms that recipient, so a credential given for one never reaches another
   * (a redirect, a lookalike, a window the agent was steered to) without their yes.
   * "Always" covers one exact site. An app is asked about every time: another program
   * can carry the same id, so nothing standing may rest on it.
   * @param {{ site?: string, app?: string, label?: string }} recipient
   * @returns {Promise<"allow" | "always" | "dismiss" | "aborted" | "timeout" | "busy" | "too_many">}
   */
  async function approveCredential(grant, recipient, signal) {
    const { site, app, label } = recipient;
    const shown = site ?? label ?? app;
    if (!(site || app) || !shown || shown.length > 200) return "too_many";
    if (site && grant.credentialsAlwaysFor?.has(site)) return "always";
    if (scriptRequests.has(chatKey(grant))) return "busy";
    const target = targetFor(grant);
    // An app's name can be copied by another app; its id is shown beside it.
    const answer = await approve(grant, { id: randomUUID(), reason: /** @type {const} */ ("credential"), computer: target.label, placement: target.placement,
      ...(site ? { credential: { site } } : { standing: false, credential: { app: shown, appId: app } }) }, signal);
    if (site && answer === "always") (grant.credentialsAlwaysFor ??= new Set()).add(site);
    return answer;
  }
  function canonicalBrowserSite(site) {
    try {
      const url = new URL(site);
      return ["http:", "https:"].includes(url.protocol) && url.origin === site;
    } catch { return false; }
  }
  /** One in-chat approval at a time per chat; answered through answerRequest. */
  function approve(grant, request, signal) {
    const key = chatKey(grant);
    return new Promise((resolve) => {
      let timer;
      const stop = () => pending.settle("aborted");
      const pending = { request, settle: (answer) => {
        if (scriptRequests.get(key) !== pending) return;
        scriptRequests.delete(key);
        clearTimeout(timer); signal.removeEventListener("abort", stop); grant.controller.signal.removeEventListener("abort", stop);
        onRequest(key, null);
        resolve(answer);
      } };
      scriptRequests.set(key, pending);
      timer = setTimeout(() => pending.settle("timeout"), requestMs);
      timer.unref?.();
      signal.addEventListener("abort", stop, { once: true });
      grant.controller.signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted || grant.controller.signal.aborted) { stop(); return; }
      onRequest(key, request);
    });
  }
  function humanPaused(grant) {
    return Boolean(handoffOf(grant) || crewLeases(grant).some((current) => current.session?.state === "paused") || takenOverElsewhere(grant));
  }
  function pausePrograms(grant, targetId) {
    for (const [sessionId, program] of programs) {
      const owner = grants.get(sessionId);
      if (owner && (owner === grant || targetFor(owner).id === targetId)) program.controller.abort(new Error("The person took over. Continue is required before new work."));
    }
  }
  function advance(grant) {
    programs.get(grant.sessionId)?.controller.abort(new Error("Computer control stopped or changed."));
    grant.controller.abort(new Error("Computer use was turned off, revoked, or restarted."));
    grant.controller = new AbortController();
    return ++grant.revision;
  }
  function disable(grant) {
    grant.enabled = false; advance(grant);
    for (const current of mine(grant)) invalidateObservation(current);
  }
  /** Stop on any of the chat's apps, its own or a subagent's, stops all of them. Resolves each cleanup. */
  function stopChat(grant, except = null) {
    for (const member of crew(grant)) { member.handoff = null; if (member.enabled) disable(member); }
    return crewLeases(grant).filter((current) => current !== except).map(cleanup);
  }
  async function choices() {
    if (!saved) {
      loadingChoices ??= Promise.resolve().then(() => standing.read()).catch(() => null).then((state) => {
        const chosen = state?.targets && typeof state.targets === "object" ? Object.entries(state.targets).filter(([id, target]) => typeof id === "string" && typeof target === "string") : [];
        saved = { targets: new Map(chosen), computer: typeof state?.computer === "string" ? state.computer : null };
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
      await standing.write({ targets: Object.fromEntries(state.targets), ...(state.computer ? { computer: state.computer } : {}) });
    });
    remembering = result.catch(() => {});
    return result;
  }
  // An automatic stop (helper exit, failed handoff) pauses a chat for the rest
  // of its turn. The next turn re-arms every chat the person allowed.
  async function rearm(sessionId) {
    if (closed || resetting) return;
    for (const grant of grants.values()) {
      if (sessionId && grant.sessionId !== sessionId && chatKey(grant) !== sessionId) continue;
      if (!grant.enabled && !mine(grant).length) grant.enabled = true;
    }
  }
  // One call at a time per chat. Chats wait on each other only for a computer's focusSlot.
  const serial = (grant, work, limit, signal) => {
    const previous = grant.tail ?? Promise.resolve();
    const ready = limit ? limit.wait(() => previous, signal) : previous;
    const result = ready.then(() => { limit?.check(); signal?.throwIfAborted(); return work(); });
    grant.tail = Promise.all([previous, result.then(() => undefined, () => undefined)]).then(() => undefined);
    return result;
  };
  /** Records the chat a subagent works for. The first answer stands; a chat is never another's subagent. */
  function relate(sessionId, rootSessionId) {
    if (typeof rootSessionId !== "string" || !rootSessionId.trim() || rootSessionId.length > 256 || rootSessionId === sessionId || roots.has(sessionId)) return;
    const root = roots.get(rootSessionId) ?? rootSessionId;
    if (root === sessionId || [...roots.values()].includes(sessionId)) return;
    if (roots.size >= 1000) roots.delete(roots.keys().next().value);
    roots.set(sessionId, root);
  }
  async function grantFor(sessionId, rootSessionId, agentName) {
    if (closed || resetting) throw new Error("Computer use is stopping.");
    if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("A chat is required.");
    if (parallelAgents) relate(sessionId, rootSessionId);
    const rootId = parallelAgents ? roots.get(sessionId) : undefined;
    const root = rootId ? await grantFor(rootId) : null;
    let grant = grants.get(sessionId);
    if (!grant) {
      const state = await choices();
      grant = grants.get(sessionId);
      if (!grant) {
        // A chat uses the computer chosen in Settings; one that went away falls back to the first.
        const adapter = targets.get(state.targets.get(sessionId) ?? state.computer ?? "") ?? firstTarget;
        // `apps`: each app the chat opened, by its session_id, to renew it after idle cleanup.
        grant = { sessionId, revision: 0, controller: new AbortController(), enabled: true, handoff: null, apps: new Map(), latest: null, adapter };
        grants.set(sessionId, grant);
      }
    }
    // A subagent joins its chat once, before or after its first call; nothing nests deeper.
    if (root && !grant.root && root !== grant && !root.root && !crew(grant).some((other) => other.root === grant)) grant.root = root;
    // The subagent's name for its cursor, set once by the bridge.
    const name = typeof agentName === "string" ? agentName.replace(/\s+/g, " ").trim().slice(0, 32).trim() : "";
    if (grant.root && name) grant.agentName ??= name;
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
    if (!leased(current) || current.closing || current.uiEnded || !current.grant.enabled
      || current.controller.signal.aborted) {
      throw new Error("This computer session ended. Open a fresh session for the requested work.");
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
  function receiveUi(current, value) {
    try { assertUiActive(current); } catch { clearPresentation(current); return; }
    if (!value || !uiText(value.id, 128) || !value.id || !["state", "frame", "input"].includes(value.kind)) return;
    const presentation = current.presentation;
    if (value.kind === "state") {
      if (!["working", "paused", "closed"].includes(value.phase)) return;
      // Only the exact admitted open can introduce an identity. Never adopt a
      // different native ID on this lease, even if a late notification looks valid.
      if (current.uiId && value.id !== current.uiId) {
        clearPresentation(current); current.uiEnded = true;
        disable(current.grant); void cleanup(current);
        return;
      }
      if (!current.uiId && (!["working", "paused"].includes(value.phase) || !matchesOpening(current, value))) return;
      if (value.phase === "closed") {
        clearPresentation(current); current.uiEnded = true;
        if (!current.expectedClose) {
          if (value.cause === "human_stop") stopChat(current.grant, current);
          else advance(current.grant); // Cancel interrupted work, retain enabled access.
          void cleanup(current);
        }
        return;
      }
      for (const [key, limit] of [["appName", 512], ["appID", 512], ["windowTitle", 2048], ["task", 500], ["mode", 32], ["status", 2048]]) {
        if (value[key] !== undefined && !uiText(value[key], limit)) return;
      }
      if (value.pid !== undefined && (!uiNumber(value.pid, 0x7fffffff) || value.pid === 0)) return;
      if (value.canContinue !== undefined && typeof value.canContinue !== "boolean") return;
      if (!current.uiId) { clearPresentation(current); current.uiId = value.id; }
      const next = { id: value.id, phase: value.phase, inputs: presentation?.inputs ?? [] };
      for (const key of ["appName", "windowTitle", "task", "mode", "status", "canContinue"]) if (value[key] !== undefined) next[key] = value[key];
      if (value.phase === "working" && presentation?.frame) next.frame = presentation.frame;
      if (value.phase === "paused") {
        if (presentation?.phase !== "paused") current.handoffGeneration++;
        invalidateObservation(current);
        current.needsObservation = true; next.inputs = [];
      }
      current.presentation = next;
      // Human handoff survives routine transport/session cleanup. Only Continue clears it.
      if (value.phase === "paused") {
        current.grant.handoff = { ...next, inputs: [] };
        current.grant.handoffTarget = current.adapter.id;
        pausePrograms(current.grant, current.adapter.id);
      } else if (!current.grant.handoff || presentation?.phase === "paused") {
        // A working update already in flight before Take over is not Continue.
        current.grant.handoff = null; current.grant.handoffTarget = null;
        if (presentation?.phase === "paused" && current.session) current.session = { ...current.session, state: "active", phase: "refreshing", reason: "" };
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
        || !["move", "click", "double_click", "triple_click", "drag", "scroll", "key", "type", "press", "set_value", "enter_value", "focus", "right_click", "press_and_hold", "show_menu"].includes(value.action)
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
    const paused = needsPerson(result);
    if (paused && current.nativeId) {
      invalidateObservation(current); current.needsObservation = true;
      if (current.presentation?.phase === "paused") current.grant.handoff = { ...current.presentation, inputs: [] };
    }
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
        if (current.grant.handoff) current.grant.handoff.canContinue = true;
        if (leased(current)) leases.delete(current.key);
        // One agent fewer on the chat's stage: the others re-tile.
        if (parallelAgents) tellFollowing(current.grant);
        return true;
      })().catch(() => false).finally(() => { current.cleanup = null; });
    }
    try { return await bounded(current.cleanup, cleanupMs); }
    catch {
      // Closing the dedicated transport revokes the native session.
      // Keep the reservation until the in-flight operation actually settles.
      if (current.transport && !current.transportClosed) {
        try { await bounded(current.transport.close(), cleanupMs); current.transportClosed = true; } catch { /* Still uncertain; Stop can retry cleanup. */ }
      }
      return !current.cleanupPending;
    }
  }
  // An idle or finished session hands the Mac back without turning the chat off.
  async function release(current, rearmAfter = false) {
    if (!leased(current) || current.closing) return true;
    if (rearmAfter) current.releaseRevision = current.grant.revision;
    if (current.busy) { current.releaseWhenIdle = true; return true; }
    current.expectedClose = true;
    const confirmed = await cleanup(current);
    if (current.releaseRevision !== undefined && current.grant.revision === current.releaseRevision) await rearm(current.grant.sessionId);
    return confirmed;
  }
  function armIdleRelease(current) {
    clearTimeout(current.idleTimer);
    if (!leased(current) || current.busy || current.closing) return;
    if (current.releaseWhenIdle) { void release(current); return; }
    current.idleTimer = setTimeout(() => { void release(current); }, idleMs);
    current.idleTimer.unref?.();
  }
  async function view(grant, poll = false) {
    const polled = shownLease(grant);
    if (poll && polled?.nativeId && !polled.closing && !polled.busy) {
      const limit = deadline(cleanupMs);
      try {
        await serial(polled.grant, async () => {
          const current = leased(polled) ? polled : null;
          if (!current || current.closing || !current.nativeId || current.busy) return;
          const revision = grant.revision;
          const signal = AbortSignal.any([limit.signal, current.controller.signal]);
          current.work = current.transport.callTool("computer_session_status", { session_id: current.nativeId }, { signal });
          try {
            const result = await limit.wait(() => current.work, signal);
            if (!leased(current) || current.closing || grant.revision !== revision) return;
            if (nativeStopped(current, result)) {
              await cleanup(current);
            } else if (result.isError || stateOf(result)?.ok !== true) {
              current.session = { ...current.session, state: "unavailable", reason: stateOf(result)?.message ?? "Native status is unavailable." };
            } else updateSession(current, result);
          } catch {
            if (leased(current) && grant.revision === revision) advance(grant);
            await cleanup(current);
          }
        }, limit);
      } catch { /* The snapshot below reports the last known state. */ }
      finally { limit.dispose(); }
    }
    const target = targetFor(grant);
    const status = await readiness(target);
    const sharedElsewhere = !target.parallel && [...leases.values()].some((other) => head(other.grant) !== head(grant) && other.adapter.id === target.id);
    const elsewhere = sharedElsewhere || takenOverElsewhere(grant);
    const current = shownLease(grant);
    const handoff = handoffOf(grant);
    return {
      revision: grant.revision, enabled: featureEnabled && (grant.enabled && head(grant).enabled || Boolean(handoff)),
      ...(grant.timing ? { timing: structuredClone(grant.timing) } : {}),
      entry: await permissionEntry().then(({ name, ours }) => ({ name, ours }), () => ({ name: "OpenWork", ours: false })),
      request: (() => {
        const pending = scriptRequests.get(chatKey(grant));
        if (pending) return pending.request;
        const request = requests.get(chatKey(grant));
        return request?.published ? describeRequest(grant, request) : null;
      })(),
      targetId: target.id,
      targets: offered().map(({ id, label, placement }) => ({ id, label, placement })),
      placement: target.placement,
      readiness: status.readiness, ...(status.permissions ? { permissions: status.permissions } : {}),
      detail: current?.cleanupPending ? "Stopping computer use. Native release has not yet been confirmed." : status.detail,
      busyElsewhere: Boolean(elsewhere),
      session: current?.session ? { ...current.session, ...(current.closing ? { state: "stopping" } : {}) }
        : handoff ? { state: "paused", purpose: handoff.handoff.task ?? "", appName: handoff.handoff.appName,
          windowTitle: handoff.handoff.windowTitle, reason: "You have control. Choose Continue when ready." } : null,
      ...(current?.cleanupPending ? { cleanupPending: true } : {}),
    };
  }
  /**
   * The newest frame of one agent's app for the crew view's thumbnail. Asking keeps the
   * helper streaming frames for a moment, as Watch live does; nothing here acts or disables.
   */
  async function thumbnail(current, visible) {
    const id = current.presentation?.id;
    if (!id || !current.transport?.notifyUi || current.closing || !leased(current)) return null;
    if (!visible) {
      if (current.watchUntil > 0) { current.watchUntil = 0; await current.transport.notifyUi({ id, action: "watch", visible: false }).catch(() => {}); }
      return null;
    }
    current.watchUntil = now() + 1500;
    try { await current.transport.notifyUi({ id, action: "watch", visible: true }); } catch { return null; }
    const frame = current.presentation?.id === id ? current.presentation.frame : null;
    return frame ? { mimeType: frame.mimeType, data: frame.data, width: frame.width, height: frame.height } : null;
  }
  /** The computer every chat uses and whether it is set up, with no chat involved. */
  async function computerStatus() {
    if (closed || resetting) throw new Error("Computer use is stopping.");
    const state = await choices();
    const chosen = targets.get(state.computer ?? "") ?? firstTarget;
    const target = chosen.placement === "remote" && !remoteEnabled ? defaultTarget : chosen;
    const status = await readiness(target);
    return {
      enabled: featureEnabled,
      entry: await permissionEntry().then(({ name, ours }) => ({ name, ours }), () => ({ name: "OpenWork", ours: false })),
      targetId: target.id,
      targets: offered().map(({ id, label, placement }) => ({ id, label, placement })),
      placement: target.placement,
      readiness: status.readiness, ...(status.permissions ? { permissions: status.permissions } : {}),
      detail: status.detail,
    };
  }
  async function run(call, signal, limit) {
    const { name, args, grant, revision } = call;
    const check = () => {
      if (!featureEnabled || call.featureGeneration !== featureGeneration || call.remoteTarget && call.remoteGeneration !== remoteGeneration || closed || resetting || !grant.enabled || !head(grant).enabled || grant.revision !== revision || grants.get(grant.sessionId) !== grant) {
        throw new Error("Computer use was turned off, revoked, or restarted before this call finished.");
      }
    };
    const admissionSignal = AbortSignal.any([limit.signal, signal, grant.controller.signal]);
    const takenOver = () => failure("computer_busy", "The person took over this computer. They return control with Continue in its owning chat. Nothing was dispatched.");
    return serial(grant, async () => {
      limit.check(); check();
      if (handoffOf(grant) && !["computer_status", "computer_close"].includes(name)) return failure("session_paused", "The person took over. Wait for Continue in the Computer view.", { state: "paused", next: "human_takeover" });
      if (takenOverElsewhere(grant)) return takenOver();
      const target = targetFor(grant);
      const opening = name === "computer_open";
      // A parallel computer gives each of the chat's apps its own helper; elsewhere a chat holds one session.
      const several = target.parallel === true;
      const own = !several ? mine(grant)[0] ?? null
        : opening ? mine(grant).find((other) => !other.app && !other.nativeId && !other.closing) ?? null
        : leaseOf(grant, call.app);
      const others = [...leases.values()].filter((other) => other.grant !== grant && other.adapter.id === target.id);
      if (own?.closing || !several && others.length) {
        return failure("computer_busy", own?.closing || others.some((other) => other.closing)
          ? "The previous computer session is still stopping. Try again in a moment. Nothing was dispatched."
          : "Another chat is using this computer. It must finish or be stopped first. Nothing was dispatched.");
      }
      // The helper refuses a window another chat holds; say so before starting one.
      const window = opening ? args.window_id : call.app?.lastOpen?.window_id;
      if (Number.isSafeInteger(window) && others.some((other) => other.windowId === window)) {
        return failure("window_busy", "Another chat is working in this window. Choose another window, or wait for that chat to finish. Nothing was dispatched.");
      }
      if (opening && several) {
        // Each app has one session in the chat: the same window again is the session already there.
        const there = [...grant.apps.values()].find((app) => Number.isSafeInteger(window) && app.lastOpen.window_id === window);
        if (there && leaseOf(grant, there)?.nativeId) return failure("session_open", `This chat already works in this window as session ${there.id}. Pass that session_id instead. Nothing was dispatched.`, { session_id: there.id });
        if (grant.apps.size - (there ? 1 : 0) >= APPS_PER_CHAT) {
          return failure("too_many_sessions", `This chat already has ${APPS_PER_CHAT} apps open. Close one with computer_close and its session_id first. Nothing was dispatched.`, { open_sessions: listApps(grant) });
        }
      }
      // Closing an app whose helper idle cleanup already ended only forgets it.
      if (name === "computer_close" && call.app && !own?.nativeId) {
        if (own && !await cleanup(own)) throw new Error(COMPUTER_STOP_GUIDANCE);
        forget(grant, call.app);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, state: "closed" }) }] };
      }
      const current = own ?? { key: randomUUID(), grant, app: opening ? null : call.app, adapter: target, background: several, controller: new AbortController(), nativeId: null, session: null, busy: false, handoffGeneration: 0, openedAt: ++uses };
      if (!own) leases.set(current.key, current);
      if (!opening) current.app ??= call.app;
      clearTimeout(current.idleTimer);
      current.busy = true; current.usedAt = ++uses;
      // The engine cancelled this tool: end the native session, keep the chat's permission.
      const abort = () => { if (leased(current)) { current.expectedClose = true; void cleanup(current); } };
      signal.addEventListener("abort", abort, { once: true });
      const active = AbortSignal.any([admissionSignal, current.controller.signal]);
      const progress = () => { limit.check(); active.throwIfAborted(); check(); };
      /** @type {ComputerResult | undefined} */
      let nativeResult;
      let handoff = false;
      let postReadFailed = false;
      /** @type {(() => void) | null} */
      let releaseFocus = null;
      current.work = Promise.resolve().then(async () => {
        progress();
        // Foreground control brings the window forward to look or act, renewals included: take
        // this computer's turn for the one call, then hand it on while the model thinks. Background
        // sessions work behind other windows and skip this queue; until the helper names the delivery,
        // the session's setting decides (the helper still takes the front for canvas apps). Sessions
        // in one app still take turns there: each helper holds that app's key-window lock from
        // selecting its window until its input is sent, so keys never land in another chat's window.
        const mode = name === "computer_open" ? args.mode : current.app?.lastOpen?.mode;
        const renewing = !current.nativeId && current.app?.lastTarget === current.adapter.id && !["computer_discover", "computer_close"].includes(name);
        // A chat the person watches works in front, so it takes turns at the keyboard too.
        const delivery = current.adapter.parallel === true && isWatched(grant) ? "foreground"
          : current.delivery ?? (current.background ? "background" : "foreground");
        if (mode === "control" && delivery === "foreground" && (["computer_open", "computer_observe", "computer_act"].includes(name) || renewing)) {
          // Waiting for its turn shows on the chat's crew view.
          current.waitingTurn = true;
          try { releaseFocus = await focusSlot(current.adapter.id, active); } finally { current.waitingTurn = false; }
          progress();
          if (takenOverElsewhere(grant)) return takenOver();
        }
        if (!current.transport) {
          try {
            current.transport = await current.adapter.connect({
              signal: active, presence: presenceFor(grant),
              background: current.background,
              onUi: (value) => receiveUi(current, value),
              onClose: () => {
                clearPresentation(current); current.uiEnded = true;
                if (leased(current) && !current.closing && !current.expectedClose) { advance(grant); void cleanup(current); }
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
        if (name === "computer_open" && current.nativeId) return failure("session_open", "A session is already open, and this computer runs one app per chat. Keep using it, or close it before requesting another app or mode. Nothing was dispatched.");
        if (!["computer_discover", "computer_open", "computer_close"].includes(name) && !current.nativeId && current.app?.lastTarget === current.adapter.id) {
          // Renew a released technical session from the validated target request.
          // Input from its old observation is never replayed into the new session.
          const args = current.app.lastOpen;
          current.opening = { args, signal: active, assertActive: progress };
          const opened = await current.transport.callTool("computer_open_session", { ...withClipboard(current, args), ...followArgs(grant, current) }, { signal: active });
          progress();
          current.opening = null;
          const state = stateOf(opened);
          if (opened.isError || !state?.ok || typeof state.session_id !== "string") return opened;
          current.nativeId = state.session_id;
          if (Number.isSafeInteger(state.window_id)) current.windowId = state.window_id;
          if (["background", "foreground"].includes(state.delivery)) current.delivery = state.delivery;
          invalidateObservation(current); current.needsObservation = true;
          updateSession(current, opened, args.purpose);
          if (["computer_act", "computer_zoom"].includes(name)) return failure("observation_required", "The internal session was renewed. Observe the current window before input; nothing was dispatched.", { next: "observe", actions_replayed: false });
        }
        if (!["computer_discover", "computer_open"].includes(name) && !current.nativeId) return failure("session_required", "No session is open. Call computer_open first. Nothing was dispatched.");
        if (name === "computer_open") {
          current.session = { state: "opening", purpose: args.purpose, phase: "starting" };
          current.opening = { args, signal: active, assertActive: progress,  };
        }
        current.expectedClose = name === "computer_close";
        const nativeArgs = { ...(name === "computer_open" ? withClipboard(current, args) : args), ...(current.nativeId && name !== "computer_discover" ? { session_id: current.nativeId } : {}),
          ...(name === "computer_act" ? { request_id: randomUUID() } : {}), ...(name === "computer_open" ? followArgs(grant, current) : {}) };
        if (["computer_open", "computer_observe", "computer_act", "computer_close"].includes(name)) invalidateObservation(current);
        const generation = current.handoffGeneration;
        const observationGeneration = current.observationGeneration;
        progress();
        const result = name === "computer_act" && current.needsObservation
          ? failure("observation_required", "Native control paused or continued. Make a fresh observation before any action; no action was dispatched.", current.session?.state === "paused" ? { state: "paused", next: "human_takeover" } : {})
          : (nativeResult = await current.transport.callTool(COMPUTER_TOOLS[name], nativeArgs, { signal: active }));
        const state = stateOf(result);
        if (name === "computer_open") current.opening = null;
        // Nothing opened yet, such as while the person is asked about a file: no session to show.
        if (name === "computer_open" && state?.ok === false && !result.isError && !current.nativeId) current.session = null;
        if (name === "computer_open" && state?.ok && typeof state.session_id === "string") {
          current.nativeId = state.session_id;
          if (Number.isSafeInteger(state.window_id)) current.windowId = state.window_id;
          if (["background", "foreground"].includes(state.delivery)) current.delivery = state.delivery;
          // A renewal reopens the window, never the file again.
          const { file: _file, file_approval: _approval, ...reopen } = args;
          const app = { id: state.session_id, lastTarget: current.adapter.id, lastOpen: { ...reopen, ...(Number.isSafeInteger(state.window_id) ? { window_id: state.window_id } : {}) } };
          // Elsewhere the new app replaces the chat's one; here it replaces only a released session in its window.
          for (const other of [...grant.apps.values()]) if (!several || other.lastOpen.window_id === app.lastOpen.window_id && !leaseOf(grant, other)) forget(grant, other);
          grant.apps.set(app.id, app); grant.latest = app.id; current.app = app;
          // A second app open, the chat's or another agent's: the first no longer goes beside OpenWork on its own.
          if (grant.apps.size > 1 || othersOpen(grant)) tellFollowing(grant);
        }
        if (!state || typeof state.ok !== "boolean") throw new Error("The native computer response was unreadable; its outcome is uncertain.");
        if (name === "computer_open" && state.ok && !current.nativeId) throw new Error("The native helper returned no session identity.");
        const inputLanded = name === "computer_act" && (!result.isError && state.ok && state.status === "dispatched"
          || state.status === "partial" && state.may_have_acted === true && state.next === "observe");
        // The helper refused before sending anything and asks for a new look, such as when
        // the window image changed: the model would observe next, so it gets that look now.
        // The refused input is never retried; the model decides again from the fresh view.
        const refusedUnsent = name === "computer_act" && !call.program && nativeResult !== undefined && state.ok === false
          && state.status === "failed" && state.completed === 0 && state.may_have_acted === false && state.next === "observe";
        if (current.nativeId && (inputLanded || refusedUnsent || name === "computer_open" && !result.isError && state.ok && state.state === "active")) {
          call.post = { current, generation, nativeId: current.nativeId, receipt: result, captured: false, refused: refusedUnsent,
            observationGeneration: name === "computer_open" ? current.observationGeneration : observationGeneration };
          // Coordinates are read off the image, so a refused pointer step gets one unless the model declined it.
          if (refusedUnsent && call.postImage === undefined && actionEntries(call.args).some((entry) => COORDINATE_ACTIONS.has(entry.type))) call.postImage = true;
          // Input the app gave no read-back for (target focused) is checked by eye: the look carries the image.
          if (inputLanded && call.postImage === undefined && Array.isArray(state.steps) && state.steps.some((step) => step?.path === "raw_input_unverified")) call.postImage = true;
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
          if (name === "computer_observe" && !result.isError && state.ok && typeof state.observation_id === "string") {
            current.needsObservation = false;
            // The model now holds this full listing; a program's reads are not shown to it.
            if (!call.program) current.listing = listChanges(null, result.content).listing;
          }
          // A partial batch (later step refused) still landed input; the model
          // needs the settled view exactly as much as after a full dispatch.
          if (call.post) {
            try {
              progress(); assertUiActive(current);
              if (!postStillOwned(call) || current.needsObservation) return postWarning(result, "handoff_required", "human_takeover");
              // One read in this exact tool call, never a repeated input or a
              // continuation across a person takeover. Watch frames are unrelated.
              // Unless the model chose, the computer decides whether an image adds anything.
              // Opening an app also lists its menu-bar commands, so the agent can run one at once.
              const observation = await current.transport.callTool("computer_observe", { session_id: current.nativeId,
                ...(call.postImage === undefined ? {} : { include_image: call.postImage }),
                ...(name === "computer_open" && platform === "darwin" && current.adapter?.placement === "local" && !call.program ? { menus: true } : {}) }, { signal: active });
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
              // After the model's own act, list only what changed since the listing it holds.
              // Programs read every element themselves and always get the full list.
              let shown = observation.content;
              if (!call.program) {
                const listed = listChanges(name === "computer_act" ? current.listing : null, observation.content);
                current.listing = listed.listing; shown = listed.content;
              }
              call.post.result = withPostObservation(result, { ok: true }, shown,
                call.post.refused ? { next: "act", note: "Nothing was sent. Act on this fresh observation." } : {});
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
        releaseFocus?.();
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
      // The turn ends when the native call does, even after this call timed out.
      const settled = () => { if (current.work === work) current.work = null; releaseFocus?.(); };
      void work.then(settled, settled);
      try {
        const result = await limit.wait(() => work);
        if (name === "computer_close" || current.nativeStopped || current.handoffFailed || postReadFailed
          || (name === "computer_open" && result.isError && !SEQUENCE_CODES.has(stateOf(result)?.code))) {
          // Technical cleanup retains access and human handoffs. No interrupted
          // action is retried; subsequent work starts from a fresh observation.
          if (name === "computer_open") current.expectedClose = true;
          if (stateOf(result)?.ok === true && name === "computer_close") { current.nativeId = null; current.listing = null; forget(grant, current.app); }
          await cleanup(current);
        }
        if (result.isError) return result;
        // Preserve a dispatched or uncertain native receipt even when Stop raced it.
        if (current.closing && !call.post && name !== "computer_act" && name !== "computer_close") return failure("revoked", "Computer control stopped before this result could be delivered.");
        return result;
      } catch (error) {
        // A failure before any native session existed (such as an unavailable
        // helper) dispatched nothing and leaves the chat's permission as it was.

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
    const key = chatKey(grant);
    let request = requests.get(key);
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
      requests.set(key, request);
      const current = request;
      const publish = () => onRequest(key, describeRequest(grant, current));
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
        if (requests.get(key) === current) requests.delete(key);
        onRequest(key, null);
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
  /**
   * macOS took a permission back mid-chat, or no longer matches this build.
   * Free the helper (a running one keeps its old Screen Recording answer), ask
   * in the chat again, then have the agent pick up from a fresh look.
   */
  async function recoverPermissions(grant, name, args, signal) {
    lastReadiness.delete(targetFor(grant).id);
    // Every helper of the chat keeps its old answer.
    await Promise.all(mine(grant).map((own) => release(own)));
    const answer = await askPerson(grant, name === "computer_open" ? args : appOf(grant)?.lastOpen ?? args, signal);
    if (answer !== "ready") return setupNotFinished(answer);
    return failure("permissions_restored", name === "computer_open"
      ? "The person turned the macOS permissions back on. Nothing was dispatched. Open the app again."
      : "The person turned the macOS permissions back on. Nothing was dispatched. Observe again before any action.",
    { next: name === "computer_open" ? "open_session" : "observe", actions_replayed: false });
  }
  const api = {
    async presentation(input) {
      if (!input || typeof input.visible !== "boolean" || Object.keys(input).some((key) => !["sessionId", "visible"].includes(key))) throw new Error("A chat and explicit monitor visibility are required.");
      const grant = grants.get(input.sessionId);
      const current = grant ? shownLease(grant) : null;
      const handoff = grant ? handoffOf(grant)?.handoff : null;
      if (!grant || !featureEnabled || !grant.enabled && !handoff) return null;
      if (!current || !current.transport?.notifyUi || current.closing) return handoff ? structuredClone(handoff) : null;
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
        if (leased(current) && !current.closing) { disable(current.grant); void cleanup(current); }
        return null;
      }
      return current.presentation?.id === id ? structuredClone(current.presentation) : null;
    },
    /**
     * Whether the person watches this chat: it is on screen in a visible OpenWork window.
     * The desktop debounces the signal, so quick thread switches do not flip it.
     */
    follow(input) {
      if (!input || typeof input.watching !== "boolean" || typeof input.sessionId !== "string" || !input.sessionId
        || Object.keys(input).some((key) => !["sessionId", "watching"].includes(key))) throw new Error("A chat and whether it is watched are required.");
      if (input.watching === watched.has(input.sessionId)) return;
      if (input.watching) {
        // A few chats are on screen at once; an unbounded set would only grow from a broken renderer.
        if (watched.size >= 16) watched.delete(watched.values().next().value);
        watched.add(input.sessionId);
      } else watched.delete(input.sessionId);
      const grant = grants.get(input.sessionId);
      if (grant) tellFollowing(grant);
    },
    async interact(input) {
      if (!input || !["takeover", "resume"].includes(input.action) || !uiText(input.id, 128) || !input.id
        || Object.keys(input).some((key) => !["sessionId", "id", "action"].includes(key))) throw new Error("Choose Take over or Continue for this computer session.");
      const chat = grants.get(input.sessionId);
      // The control the person used names the app's session, a subagent's too; a handoff whose session already ended has none.
      const paused = chat ? crew(chat).find((other) => other.handoff?.id === input.id) : null;
      const current = !chat ? null : shownLeases(chat).find((other) => other.presentation?.id === input.id)
        ?? (paused ? null : shownLease(chat));
      const grant = current?.grant ?? paused ?? chat;
      if (featureEnabled && grant?.handoff?.id === input.id && input.action === "resume"
        && (!current || current.closing)) {
        if (current && !await cleanup(current)) throw new Error(COMPUTER_STOP_GUIDANCE);
        advance(grant); grant.handoff = null; grant.enabled = true;
        return; // Future work opens a fresh target; interrupted actions stay cancelled.
      }
      if (!current || !current.transport?.notifyUi) throw new Error("This chat does not own an active computer session.");
      assertUiActive(current);
      const presentation = current.presentation;
      if (!presentation || presentation.id !== input.id) throw new Error("This computer view is out of date. Refresh before acting.");
      if (!current.nativeId || (input.action === "resume" ? presentation.phase !== "paused" || presentation.canContinue !== true : !["working", "paused"].includes(presentation.phase))) throw new Error("This control is not available in the current native phase.");
      if (input.action === "takeover") {
        invalidateObservation(current);
        current.needsObservation = true;
        current.handoffGeneration++;
        current.grant.handoff = { ...presentation, phase: "paused", canContinue: true, inputs: [] };
        current.grant.handoffTarget = current.adapter.id;
        pausePrograms(current.grant, current.adapter.id);
        if (current.closing) {
          if (!await cleanup(current)) throw new Error(COMPUTER_STOP_GUIDANCE);
          return;
        }
        if (presentation.phase === "paused") return;
        // Reducing authority must not wait on a pending resume.
        try { await current.transport.notifyUi({ id: input.id, action: "takeover" }); }
        catch (error) {
          if (leased(current) && !current.closing) { disable(current.grant); await cleanup(current); }
          throw error;
        }
        return;
      }
      if (current.uiControlPending) throw new Error("A control decision is already pending. Wait for its current state; do not retry it.");
      current.uiControlPending = true;
      const generation = current.handoffGeneration;
      try {
        try {
          assertUiActive(current);
        } catch (error) {
          if (leased(current) && !current.closing) { disable(current.grant); await cleanup(current); }
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
          if (leased(current) && !current.closing) { disable(current.grant); await cleanup(current); }
          throw error;
        }
      } finally { current.uiControlPending = false; }
    },
    /** @param {ChatInput} input */
    async snapshot({ sessionId } = {}) { return view(await grantFor(sessionId), true); },
    /**
     * The chat's crew: one row per subagent that worked on its computer, in the order they
     * started, with its cursor name and color, app, state and latest step, and with
     * `thumbnails` its app's newest frame. Empty with `parallelComputerUse` off, for a
     * subagent's own thread, and for a chat whose agents never used the computer.
     * @param {{ sessionId?: string, thumbnails?: boolean }} input
     */
    async crew({ sessionId, thumbnails = false } = {}) {
      const chat = typeof sessionId === "string" ? grants.get(sessionId) : undefined;
      if (!parallelAgents || !featureEnabled || !chat || rootOf(chat)) return [];
      const paused = Boolean(handoffOf(chat));
      const rows = [];
      for (const id of chat.agents?.keys() ?? []) {
        const agent = grants.get(id);
        if (!agent || rootOf(agent) !== chat) continue;
        const own = mine(agent).filter((current) => !current.closing);
        const shown = shownLease(agent);
        const { name, color } = presenceFor(agent);
        /** @type {"working" | "waiting" | "paused" | "done"} */
        const state = own.length && (paused || own.some((current) => current.presentation?.phase === "paused")) ? "paused"
          : own.some((current) => current.waitingTurn) ? "waiting" : own.length ? "working" : "done";
        const frame = shown ? await thumbnail(shown, thumbnails && state !== "done") : null;
        const app = shown?.presentation?.appName ?? shown?.session?.appName ?? appOf(agent)?.lastOpen?.app_id ?? null;
        rows.push({ sessionId: id, name, color, app, state, intent: agent.lastIntent ?? null, ...(frame ? { frame } : {}) });
      }
      return rows;
    },
    /** Settings: the computer chats use and its setup, without a chat. */
    async status() { return computerStatus(); },
    /** Whether the renderer reported the `computerUse` feature on. */
    featureEnabled() { return featureEnabled && !closed; },
    /**
     * Settings: point every chat at this computer or a connected VM. Earlier
     * per-chat choices are dropped, and work on another computer stops first.
     * @param {{ targetId?: string }} input
     */
    async chooseComputer({ targetId } = {}) {
      const adapter = targets.get(String(targetId ?? ""));
      if (!adapter || !offered().includes(adapter)) throw new Error("Choose one of the listed computers.");
      const elsewhere = [...leases.values()].filter((current) => current.adapter !== adapter);
      if ((await Promise.all(elsewhere.map(cleanup))).includes(false)) throw new Error(COMPUTER_STOP_GUIDANCE);
      for (const grant of grants.values()) {
        if (grant.adapter === adapter) continue;
        advance(grant);
        grant.adapter = adapter;
        grant.apps.clear(); grant.latest = null;
        requests.get(chatKey(grant))?.wake();
      }
      await remember((state) => { state.targets.clear(); state.computer = adapter.id; });
      return computerStatus();
    },
    /**
     * Stop from the Computer view or the pill: ends this task now and keeps the
     * chat allowed for the person's next message.
     * @param {ChatInput} input
     */
    async halt({ sessionId } = {}) {
      const grant = grants.get(sessionId) ?? await grantFor(sessionId);
      // Stop ends every app the chat has open, and every subagent's.
      if ((await Promise.all(stopChat(grant))).includes(false)) throw new Error(COMPUTER_STOP_GUIDANCE);
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
      const asked = await grantFor(sessionId);
      // A subagent uses its chat's computer, so the choice is the chat's.
      const grant = head(asked);
      if (targetFor(grant) === adapter && grant.adapter === adapter) return view(asked);
      if ((await Promise.all(crewLeases(grant).map(cleanup))).includes(false)) throw new Error(COMPUTER_STOP_GUIDANCE);
      for (const member of crew(grant)) { advance(member); member.adapter = adapter; member.apps.clear(); member.latest = null; }
      await remember((state) => { state.targets.delete(grant.sessionId); state.targets.set(grant.sessionId, adapter.id); });
      requests.get(grant.sessionId)?.wake();
      return view(asked);
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
      for (const script of scripts) script.abort(new Error("Computer use was turned off."));
      for (const pending of scriptRequests.values()) pending.settle("aborted");
      for (const request of requests.values()) request.settle("unavailable");
      const running = [...leases.values()];
      for (const current of running) current.expectedClose = true;
      if ((await Promise.all(running.map(cleanup))).includes(false)) throw new Error(COMPUTER_STOP_GUIDANCE);
      return false;
    },
    /**
     * Compatibility for older renderers. Background delivery is part of
     * `computerUse` now; a stale child-flag value must not change its behavior.
     * Remove with the corresponding desktop IPC when old renderers are unsupported.
     * @param {boolean} [_enabled] Retired child-flag value; intentionally ignored.
     */
    async setBackgroundEnabled(_enabled) {
      return featureEnabled;
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
      if (!remoteEnabled) {
        const remote = [...leases.values()].filter((current) => current.adapter.placement === "remote");
        for (const current of remote) current.expectedClose = true;
        if ((await Promise.all(remote.map(cleanup))).includes(false)) throw new Error(COMPUTER_STOP_GUIDANCE);
      }
      return remoteEnabled;
    },
    /**
     * The renderer reports the `standardCodeMode` feature. It picks the
     * interpreter for programs that start afterwards; a running program
     * finishes on the one it started on. It grants nothing: both interpreters
     * run the same tools under the same checks.
     */
    setStandardCodeMode(enabled) {
      standardCodeMode = enabled === true;
      return standardCodeMode;
    },
    /**
     * The renderer reports the `parallelComputerUse` feature. Off, every session is its own
     * chat, as before; a subagent's link to its chat counts again once it is back on.
     */
    setParallelAgents(enabled) {
      parallelAgents = enabled === true;
      return parallelAgents;
    },
    parallelAgents() { return parallelAgents; },
    /**
     * The person's answer to an in-chat request: allow this chat, always
     * allow, or not now. Setup itself is answered by macOS permissions.
     * @param {ChatInput & { answer?: "dismiss" | "allow" | "always" | "remember", id?: string }} input
     */
    async answerRequest({ sessionId, answer, id } = {}) {
      const grant = await grantFor(sessionId);
      const pending = scriptRequests.get(chatKey(grant));
      if (pending) {
        // A script runs only on the person's answer to the exact request they saw.
        if (typeof id !== "string" || id !== pending.request.id) throw new Error("This script request changed. Review the current one.");
        if (!["allow", "always", "dismiss", "remember"].includes(answer)) throw new Error("Choose allow, always allow or don't allow.");
        if (answer === "remember" && !(pending.request.reason === "files" && pending.request.files?.canRemember === true && canonicalBrowserSite(pending.request.files.site))) {
          throw new Error("Remembering is only available for this browser file request.");
        }
        if (answer === "always" && pending.request.reason === "files" && pending.request.files?.site && pending.request.files.canRemember !== true) {
          throw new Error("This browser upload needs approval each time.");
        }
        pending.settle(answer);
        return view(grant);
      }
      if (answer === "dismiss") requests.get(chatKey(grant))?.settle("dismissed");
      else throw new Error("Choose Not now to dismiss setup.");
      requests.get(chatKey(grant))?.wake();
      return view(grant);
    },
    /** @param {{ permission?: "accessibility" | "screenRecording" }} input */
    async setup({ permission } = {}) {
      if (closed || resetting || leases.size) throw new Error("Stop computer use before opening permission setup.");
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
    /**
     * Drive a scriptable app on this Mac through its own interface: AppleScript or JXA for
     * apps with a scripting dictionary, Python for Blender. Same flag, chat and stop rules
     * as direct tools; the engine asks the person before each new app.
     * @param {ChatInput & { app?: string, code?: string, timeoutMs?: number }} input
     * @returns {Promise<ScriptResult>}
     */
    /**
     * The built-in browser is about to give a page these files: ask the person in
     * the chat first, as for a native file panel. Resolves whether they allowed it.
     * @param {ChatInput & { app?: string, files?: string[] }} input
     */
    async approveFiles({ sessionId, app, files } = {}, { signal = new AbortController().signal } = {}) {
      if (!featureEnabled || closed || resetting || !Array.isArray(files) || !files.length) return false;
      const grant = await grantFor(sessionId);
      if (!grant.enabled) return false;
      return ["allow", "always"].includes(await approveFiles(grant, { app: String(app ?? "a website"), names: files }, signal));
    },
    /**
     * Browser file consent is independent of computer use and native file panels.
     * The trusted browser service alone decides whether a durable grant is available.
     * @param {ChatInput & { site?: string, files?: string[], canRemember?: boolean, accountScope?: string }} input
     * @returns {Promise<"allow" | "always" | "dismiss" | "aborted" | "timeout" | "remember">}
     */
    async requestBrowserFiles({ sessionId, site, files, canRemember, accountScope } = {}, { signal = new AbortController().signal } = {}) {
      if (closed || resetting) return "aborted";
      if (!canonicalBrowserSite(site) || site.length > 200 || !Array.isArray(files) || !files.length || files.length > 20 || files.some((name) => typeof name !== "string" || !name || name.length > 1024)) return "dismiss";
      const grant = await grantFor(sessionId);
      if (signal.aborted) return "aborted";
      // Even chat-only approvals belong to one verified account, not just the
      // session id. Never inherit another member's Always after switching sign-in.
      const account = typeof accountScope === "string" && /^[a-f0-9]{64}$/.test(accountScope) ? accountScope : null;
      const approvalKey = account ? JSON.stringify([account, site]) : null;
      canRemember = canRemember === true && approvalKey !== null;
      if (canRemember && grant.browserFilesAlwaysFor?.has(approvalKey)) return "always";
      if (scriptRequests.has(chatKey(grant))) return "dismiss";
      const local = [...targets.values()].find((target) => target.placement === "local");
      const answer = await approve(grant, { id: randomUUID(), reason: /** @type {const} */ ("files"), computer: local?.label ?? "This computer", placement: "local",
        ...(canRemember === true ? {} : { standing: false }),
        files: { app: site, names: [...files], site, canRemember: canRemember === true } }, signal);
      if (answer === "always" && canRemember === true && approvalKey) (grant.browserFilesAlwaysFor ??= new Set()).add(approvalKey);
      return answer;
    },
    /**
     * Asks the person before the built-in browser types a password or code on `site`
     * (an exact origin). The browser is its own feature, so this works with computer use off.
     * @param {ChatInput & { site?: string }} input
     */
    async approveCredential({ sessionId, site } = {}, { signal = new AbortController().signal } = {}) {
      if (closed || resetting || typeof site !== "string") return false;
      const grant = await grantFor(sessionId);
      return ["allow", "always"].includes(await approveCredential(grant, { site }, signal));
    },
    /**
     * @param {ChatInput & { app?: string, code?: string, timeoutMs?: number }} input
     * @param {{ signal?: AbortSignal, approveEachScript?: boolean }} options
     * @returns {Promise<ScriptResult>}
     */
    async script(input, { signal = new AbortController().signal, approveEachScript = false } = {}) {
      if (!featureEnabled || closed || resetting || !runScript) return { ok: false, error: { code: "computer_unavailable", message: "App scripting is not available in this OpenWork app." } };
      if (!input || !SCRIPT_APPS.includes(input.app) || typeof input.code !== "string" || !input.code.trim() || input.code.length > 32_000
        || input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 120_000)) {
        return { ok: false, error: { code: "invalid_arguments", message: `Provide app (${SCRIPT_APPS.join(", ")}), code up to 32000 characters and a timeout from 1000 to 120000 milliseconds.` } };
      }
      const grant = await grantFor(input.sessionId, input.rootSessionId, input.agentName);
      if (!grant.enabled || !head(grant).enabled) return { ok: false, error: { code: "computer_stopped", message: "Computer use stopped for this turn. Continue with the person's next message." } };
      if (humanPaused(grant)) return { ok: false, error: { code: "computer_paused", message: "The person took over. They return control with Continue. No script was run." } };
      if (targetFor(grant).placement !== "local") return { ok: false, error: { code: "script_unavailable", message: "App scripting runs on this Mac only. Use computer_run on remote computers." } };
      if (scriptRequests.has(chatKey(grant)) || [...scripts].some((script) => script.sessionId === grant.sessionId)) return { ok: false, error: { code: "script_busy", message: "A script is already waiting or running in this chat." } };
      const generation = featureGeneration;
      const revision = grant.revision;
      // Computer use on for this chat lets its agent run app scripts, as it lets it click and
      // type. An organization that asks before each script gets the whole script here, in
      // OpenWork: an engine-side prompt is not enough because anything holding the bridge
      // token can reach this call.
      if (approveEachScript) {
        const answer = await approveScript(grant, input.app, input.code, signal);
        if (answer !== "allow" && answer !== "always") {
          return { ok: false, error: { code: "script_declined", message: answer === "dismiss"
            ? "The person chose not to run this script. Nothing ran. Continue another way or ask what they want."
            : "The script was not approved in time, or computer use stopped. Nothing ran." } };
        }
      }
      if (!featureEnabled || generation !== featureGeneration || revision !== grant.revision || closed || resetting) {
        return { ok: false, error: { code: "computer_stopped", message: "Computer use stopped before the script started. Nothing ran." } };
      }
      const controller = Object.assign(new AbortController(), { sessionId: grant.sessionId });
      scripts.add(controller);
      const started = now();
      try {
        return await runScript({ app: input.app, code: input.code, timeoutMs: input.timeoutMs ?? 30_000 }, AbortSignal.any([signal, grant.controller.signal, controller.signal]));
      } catch (error) {
        return { ok: false, error: { code: "script_failed", message: error instanceof Error ? error.message : String(error) }, mayHaveActed: true };
      } finally { scripts.delete(controller); recordStep(grant, "computer_script", started); }
    },
    async program(input, { signal = new AbortController().signal } = {}) {
      if (!featureEnabled || closed || resetting || !runProgram) return { ok: false, error: { code: "computer_unavailable", message: "Computer use is not enabled." } };
      if (!input || !["computer", "browser"].includes(input.surface) || typeof input.code !== "string" || input.code.length > 32_000
        || input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 60_000)) return { ok: false, error: { code: "invalid_arguments", message: "Provide a surface, bounded code and a timeout from 1000 to 60000 milliseconds." } };
      // Before any await: an off/on toggle while the grant resolves must still stop this program.
      const generation = featureGeneration;
      const grant = await grantFor(input.sessionId, input.rootSessionId, input.agentName);
      if (!grant.enabled || !head(grant).enabled) return { ok: false, error: { code: "computer_stopped", message: "Computer use stopped for this turn. Continue with the person's next message." } };
      if (humanPaused(grant)) return { ok: false, error: { code: "computer_paused", message: "The person took over. They return control with Continue. No program was started." } };
      if (programs.has(grant.sessionId)) return { ok: false, error: { code: "program_busy", message: "A program is already running in this chat." } };
      const revision = grant.revision;
      const options = { standardCodeMode };
      const remote = input.surface === "computer" && targetFor(grant).placement === "remote";
      const remoteRevision = remoteGeneration;
      const controller = new AbortController();
      const current = { controller, remote };
      const active = AbortSignal.any([signal, controller.signal, grant.controller.signal]);
      const check = () => {
        active.throwIfAborted();
        if (humanPaused(grant)) throw new Error("The person took over. Continue is required; interrupted actions are not replayed.");
        if (!featureEnabled || generation !== featureGeneration || revision !== grant.revision || closed || resetting || remote && remoteRevision !== remoteGeneration) throw new Error("The computer program stopped or its target changed.");
      };
      programs.set(grant.sessionId, current);
      try {
        check();
        return await runProgram(input, {
          computer: async (name, args, callSignal) => { check(); const result = await api.execute({ sessionId: grant.sessionId, name, args }, { signal: AbortSignal.any([active, callSignal]), includePostImage: false, program: true }); check(); return result; },
          browser: async (operation, args, callSignal) => { check(); if (!browserTask) throw new Error("The browser is unavailable."); const result = await browserTask({ sessionId: grant.sessionId, operation, args }, { signal: AbortSignal.any([active, callSignal]) }); check(); return result; },
        }, active, options);
      } catch {
        return { ok: false, error: { code: "program_stopped", message: "The program stopped. Previously dispatched actions were not replayed." }, mayHaveActed: true };
      } finally { if (programs.get(grant.sessionId) === current) programs.delete(grant.sessionId); }
    },
    /**
     * Tool calls from the engine, scoped to the requesting chat by the bridge.
     * @param {ChatInput & { name?: string, args?: Record<string, unknown> }} input
     * @param {{ signal?: AbortSignal, includePostImage?: boolean, program?: boolean }} options
     * @returns {Promise<ComputerResult>}
     */
    async execute({ sessionId, rootSessionId, agentName, name, args } = {}, { signal = new AbortController().signal, includePostImage = true, program = false } = {}) {
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
        const grant = await grantFor(sessionId, rootSessionId, agentName);
        if (targetFor(grant).placement === "remote" && !await readRemoteFeatureEnabled().catch(() => false)) {
          await api.setRemoteEnabled(false);
          return failure("computer_unavailable", "Your organization's remote computer feature could not be verified. Nothing was dispatched.");
        }
        if (!grant.enabled || !head(grant).enabled) {
          return failure("not_allowed", "Computer use stopped earlier in this turn, because the person stopped it or after a failure. It turns back on with the person's next message, so do not ask them to re-enable it; tell them what failed.");
        }
        // Setup or this chat's allowance missing: ask the person in the chat and
        // carry on once they answer, so the agent never has to ask them itself.
        const status = name === "computer_discover" || name === "computer_open" ? await readiness(targetFor(grant)) : null;
        if (status && status.readiness !== "ready") {
          if (status && ["unsupported", "unavailable"].includes(status.readiness)) return failure("setup_required", status.detail);
          const answer = await askPerson(grant, args, signal);
          if (answer !== "ready") return setupNotFinished(answer);
        }
        if (!featureEnabled || generation !== featureGeneration || targetFor(grant).placement === "remote" && remoteRevision !== remoteGeneration) return failure("computer_unavailable", "Computer use was turned off while this request was waiting. Nothing was dispatched.");
        if (args.screenshot !== undefined && typeof args.screenshot !== "boolean") return failure("invalid_arguments", "screenshot must be true or false.");
        if (args.file !== undefined && !opensOnFiles(targetFor(grant))) return failure("file_unavailable", "Opening an app onto a file works on a Mac only. Open the app, then use its own Open command. Nothing was opened.");
        // screenshot:false returns the settled elements without an image and true always attaches one;
        // omitted, the computer adds one only when it helps. The native act never sees it.
        // The model picks among this chat's own apps by session_id, the one it was given on open or a
        // renewed one; omitted, the call goes to the app it opened last.
        const { screenshot, session_id: chosen, ...nativeArgs } = args;
        // The agent's latest step, as the person watching sees it on the cursor and the crew view.
        if (typeof args.intent === "string" && args.intent.trim()) grant.lastIntent = args.intent.trim().slice(0, 120);
        if (chosen !== undefined && (typeof chosen !== "string" || !chosen)) return failure("invalid_arguments", "session_id must be a session_id from computer_open.");
        const app = name === "computer_open" || name === "computer_discover" ? null
          : chosen === undefined ? appOf(grant)
          : grant.apps.get(chosen) ?? mine(grant).find((current) => current.nativeId === chosen && current.app)?.app ?? null;
        if (chosen !== undefined && !app) return failure("session_unknown", "This chat has no open app with that session_id. Nothing was dispatched.", { open_sessions: listApps(grant) });
        const call = { name, program, app, postImage: !includePostImage || screenshot === false ? false : screenshot, args: structuredClone(nativeArgs), grant, revision: grant.revision, featureGeneration: generation, remoteGeneration: remoteRevision, remoteTarget: targetFor(grant).placement === "remote" };
        // Text marked secret is a password or code the person gave: they confirm the app it
        // goes to first. The mark is the broker's; the native call never sees it.
        const entries = name === "computer_act" ? actionEntries(call.args) : [];
        const secret = entries.some((entry) => entry.secret === true);
        // Moving and resizing a window is a Mac step; Windows and Linux helpers have no such step.
        if (entries.some((entry) => entry.type === "arrange") && (platform !== "darwin" || targetFor(grant).placement !== "local")) {
          return failure("arrange_unavailable", "Arranging windows works on a Mac only. Nothing was sent.");
        }
        for (const entry of entries) delete entry.secret;
        // A stroke longer than the helpers take is fitted to them, and the receipt says so.
        const fitted = [];
        for (const entry of entries) {
          if (entry.type !== "drag" || !Array.isArray(entry.path)) continue;
          // The mark is the broker's: the helpers take only points.
          const smooth = entry.smooth === true;
          delete entry.smooth;
          if (entry.path.length > DRAG_POINTS_ACCEPTED) return failure("invalid_arguments", `A drag takes at most ${DRAG_POINTS_ACCEPTED} points. Nothing was dispatched.`);
          if (!entry.path.every((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))) continue;
          if (smooth) entry.path = smoothDragPath(entry.path);
          else if (entry.path.length > DRAG_POINTS) {
            fitted.push({ from: entry.path.length, to: DRAG_POINTS });
            entry.path = fitDragPath(entry.path);
          }
        }
        // Copy, cut and paste move content between apps: the organization's rule applies first.
        if (entries.some(isClipboardStep)) {
          const checked = await approveMove(grant, { kind: "clipboard" }, signal);
          if (checked.answer === "blocked") return failure("organization_policy_denied", `${checked.message} Nothing was copied or pasted; type the text or use the app's own controls instead.`);
        }
        let confirmedApp = null;
        if (secret) {
          const app = typeof call.app?.lastOpen?.app_id === "string" ? call.app.lastOpen.app_id : "";
          // Only an app on the person's own computer: a remote whole-screen session names no app to confirm.
          if (targetFor(grant).placement === "remote") return failure("remote_computer", "A password or code goes only to an app on this computer. On a remote computer, ask the person to take over. Nothing was sent.");
          if (isWebBrowser(app)) return failure("browser_app", "Web pages take a password or code only in OpenWork's browser, which confirms the exact site. Use it, or ask the person to take over. Nothing was sent.");
          const answer = app ? await approveCredential(grant, { app }, signal) : "too_many";
          if (!["allow", "always"].includes(answer)) return failure("credential_declined", app
            ? "The person did not confirm entering a password or code in this app. Nothing was sent."
            : "Open the app first: a password or code goes only to an app the person confirms. Nothing was sent.");
          confirmedApp = app;
          // Sent with the step, so the helper skips asking again for this app and never types
          // the text into an editor it cannot name as a field.
          call.args = { ...call.args, credential_approval: app };
        }
        // Only the Mac helper saves what the agent sees; it asks the organization's file rule
        // through the handover below, as save_as does.
        if (entries.some((step) => step.type === "save_image") && (platform !== "darwin" || targetFor(grant).placement !== "local")) {
          return failure("unsupported_platform", "save_image works on a Mac only. Nothing was saved.");
        }
        // The operation budget starts once the person has answered.
        limit = deadline(operationMs);
        const started = now();
        let result = await run(call, signal, limit);
        const asked = stateOf(result);
        // The helper saw a password field in the window: the person confirms this app, then
        // the same step is sent once more with that approval, which the helper checks again.
        if (name === "computer_act" && asked?.code === "credential_approval_required" && asked.dispatched === false) {
          const app = typeof asked.app_id === "string" ? asked.app_id : "";
          const answer = !app ? "too_many" : app === confirmedApp ? "allow"
            : await approveCredential(grant, { app, label: typeof asked.app === "string" ? asked.app : app }, signal);
          if (!["allow", "always"].includes(answer)) result = failure("credential_declined", "The person did not confirm entering a password or code in this app. Nothing was sent.");
          else {
            limit.dispose(); limit = deadline(operationMs);
            call.args = { ...call.args, credential_approval: app };
            result = await run(call, signal, limit);
          }
        }
        // The helper stopped before a file panel, a selection being handed over, or a file being
        // opened in an app. The organization's rule decides, so by default the agent goes ahead;
        // when it asks, the person answers in the chat. The approval sent back is bound to
        // exactly these files or this panel, and the helper checks it again.
        const panel = name === "computer_observe" && asked?.code === "file_panel_approval_required";
        const handover = (name === "computer_act" || name === "computer_open") && asked?.code === "files_approval_required";
        if ((panel || handover) && asked.dispatched === false) {
          const names = handover && Array.isArray(asked.files) ? asked.files : [];
          const save = handover && asked.save === true;
          const checked = handover && !names.length ? /** @type {const} */ ({ answer: "unreadable" })
            : await approveMove(grant, { kind: "files", app: typeof asked.app === "string" ? asked.app : "the app", names, ...(save ? { save } : {}) }, signal);
          const answer = checked.answer;
          if (checked.answer === "blocked") {
            result = failure("organization_policy_denied", name === "computer_open" ? `${checked.message} Nothing was opened.`
              : save ? `${checked.message} Nothing was saved; cancel the sheet or ask the person to save it.`
              : `${checked.message} ${panel ? "The agent cannot look through files here; cancel the panel" : "Nothing was sent; cancel the panel"} or ask the person to choose.`);
          } else if (answer !== "allow") {
            result = failure(panel ? "file_panel_declined" : save ? "save_declined" : "files_declined", answer === "dismiss"
              ? panel ? "The person chose not to let the agent look through their files. Cancel the panel or ask what to choose."
                : save ? "The person chose not to save this file there. Nothing was saved; ask where to save it."
                : name === "computer_open" ? "The person chose not to hand this file to the app. Nothing was opened; ask what to use instead."
                : "The person chose not to hand these files to the app. Nothing was sent; cancel the panel or ask what to choose."
              : answer === "too_many" ? "More files are selected than one approval can show. Select at most 20. Nothing was sent."
              : answer === "unreadable" ? "The panel's selection could not be read, so it cannot be approved. Type the file's path in the panel, or ask the person to choose it. Nothing was sent."
              : "The files were not approved in time, or computer use stopped. Nothing was sent.");
          } else {
            // Same call and revision: a Stop during the question still cancels it.
            limit.dispose(); limit = deadline(operationMs);
            // Bound to what the person answered for: this panel's window, or exactly these names.
            if (panel && !Number.isSafeInteger(asked.panel_id)) result = failure("file_panel_declined", "The panel could not be identified, so it was not opened to the agent.");
            else {
              call.args = { ...call.args, ...(panel ? { file_panel_access: asked.panel_id } : { file_approval: names }) };
              result = await run(call, signal, limit);
            }
          }
        }
        const saved = name === "computer_act" && !result.isError && targetFor(grant).placement === "local" ? stateOf(result) : null;
        if (saved?.path === "file_saved" && typeof saved.saved_file?.path === "string") {
          // The chat that started a subagent can open what it saved, as the subagent can.
          for (const id of new Set([grant.sessionId, chatKey(grant)])) {
            const files = savedFiles.get(id) ?? new Set();
            if (files.size < 200) savedFiles.set(id, files.add(saved.saved_file.path));
          }
        }
        recordStep(grant, name, started, stateOf(result)?.desktop?.followed);
        if (result.isError && stateOf(result)?.code === "permissions_required" && targetFor(grant).placement === "local") return await recoverPermissions(grant, name, args, signal);
        let delivered = deliverResult(call, result);
        // With several apps open, the model gets every session_id it can pass.
        if (name === "computer_open" && !delivered.isError && grant.apps.size > 1) {
          delivered = { ...delivered, content: [...delivered.content, { type: "text", text: JSON.stringify({ open_sessions: listApps(grant),
            note: "Pass session_id to observe, act, zoom, status or close another app; without it, calls go to the app opened last." }) }] };
        }
        // Where this chat saves when the person names no folder: the agent's default, not an approval.
        // A subagent saves in its chat's folder, so the agents of one task pass files by path.
        const chat = head(grant);
        if (name === "computer_open" && !result.isError && platform === "darwin" && targetFor(grant).placement === "local") {
          chat.saveFolder ??= await saveFolder(chat.sessionId).then((folder) => typeof folder === "string" && folder.startsWith("/") ? folder : undefined, () => undefined);
        }
        const notes = { ...(fitted.length ? { drag_paths_fitted: fitted } : {}), ...(name === "computer_open" && chat.saveFolder ? { save_folder: chat.saveFolder } : {}) };
        return Object.keys(notes).length ? { ...delivered, content: [...delivered.content, { type: "text", text: JSON.stringify(notes) }] } : delivered;
      } catch (error) {
        return failure("computer_error", `${error instanceof Error ? error.message : String(error)} Do not replay this call; inspect the computer controls before continuing.`);
      } finally { limit?.dispose(); }
    },
    /**
     * The chat's turn ended: release its native session; retain enabled access and human handoffs.
     * @param {ChatInput} input
     */
    async endTurn({ sessionId } = {}) {
      if (typeof sessionId !== "string" || !sessionId) return true;
      // The next turn's first step is not timed against this turn's last.
      const ended = grants.get(sessionId);
      if (ended) ended.lastStepAt = undefined;
      const own = ended ? mine(ended) : [];
      if (own.length) return (await Promise.all(own.map((current) => release(current, true)))).every(Boolean);
      await rearm(sessionId);
      return true;
    },
    /**
     * Whether this chat's computer use saved exactly this file on this computer.
     * @param {{ sessionId?: string, path?: string }} input
     */
    savedFile({ sessionId, path } = {}) {
      return typeof sessionId === "string" && typeof path === "string" && savedFiles.get(sessionId)?.has(path) === true;
    },
    /**
     * The chat whose output folder a session saves in: itself, or for a subagent the chat
     * that started it.
     * @param {ChatInput} input
     */
    chatOf({ sessionId } = {}) {
      return typeof sessionId !== "string" ? "" : parallelAgents ? roots.get(sessionId) ?? sessionId : sessionId;
    },
    /** @param {ChatInput} input */
    async revoke({ sessionId } = {}) {
      for (const grant of grants.values()) if (!sessionId || grant.sessionId === sessionId || chatKey(grant) === sessionId) disable(grant);
      const stopping = [...leases.values()].filter((current) => !sessionId || current.grant.sessionId === sessionId || chatKey(current.grant) === sessionId);
      return (await Promise.all(stopping.map(cleanup))).every(Boolean);
    },
    async reset(shutdown = false) {
      resetting++;
      if (shutdown) { closed = true; clearInterval(remoteFeatureTimer); }
      for (const script of scripts) script.abort(new Error("Computer use is stopping."));
      for (const pending of scriptRequests.values()) pending.settle("aborted");
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
