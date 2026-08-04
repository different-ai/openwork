import { describeAppState, dumpScreenState, evaluateOnSurface, isInteractive, probeAppState } from "@openwork/cdp";
import type { AppStateProbe, EvaluateOptions, Surface } from "@openwork/cdp";

export interface SessionToolCall {
  capability: string;
  connectionId: string | null;
  at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DOM_PROBE_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 250;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function jsValue(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Cannot interpolate an undefined JavaScript value.");
  return json.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export async function evalIn(app: Surface, expression: string, opts: EvaluateOptions = {}): Promise<unknown> {
  // Target healing lives in @openwork/cdp; behaviours just evaluate.
  return evaluateOnSurface(app, expression, {
    ...opts,
    timeoutMs: opts.timeoutMs ?? DEFAULT_DOM_PROBE_TIMEOUT_MS,
  });
}

async function timeoutError(app: Surface, message: string): Promise<Error> {
  return new Error(`${message} On screen: ${await dumpScreenState(app)}.`);
}

/**
 * Read something from the page, tolerating a renderer that is briefly blocked.
 * The app blocks its JS thread while a workspace runtime boots, so a single
 * evaluation can be caught mid-block; retrying short calls is reliable where one
 * long call is not. Only for IDEMPOTENT reads — never for clicks.
 */
async function resilientRead(
  app: Surface,
  expression: string,
  { timeoutMs = 60_000, perAttemptMs = DEFAULT_DOM_PROBE_TIMEOUT_MS, label = expression }: { timeoutMs?: number; perAttemptMs?: number; label?: string } = {},
): Promise<unknown> {
  // A cold profile can block its JS thread for minutes while the workspace
  // runtime boots, so retry to a deadline rather than a fixed attempt count.
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      return await evalIn(app, expression, {
        timeoutMs: Math.min(perAttemptMs, Math.max(0, deadline - Date.now())),
      });
    } catch (error) {
      lastError = error;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }
  throw await timeoutError(
    app,
    `Could not read ${label} within ${timeoutMs}ms (${attempts} attempts)${lastError ? `: ${messageText(lastError)}` : ""}.`,
  );
}

export async function waitFor(
  app: Surface,
  expression: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS, label = expression, awaitPromise = false }: { timeoutMs?: number; label?: string; awaitPromise?: boolean } = {},
): Promise<unknown> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  // Each probe gets a SHORT timeout on purpose: a renderer that is briefly busy
  // should have the call abandoned and retried on the next tick. Giving a probe
  // the whole budget turns one stuck evaluation into the entire wait.
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await evalIn(app, expression, {
        timeoutMs: Math.min(DEFAULT_DOM_PROBE_TIMEOUT_MS, Math.max(0, timeoutMs - (Date.now() - startedAt))),
        awaitPromise,
      });
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, timeoutMs - (Date.now() - startedAt))));
  }
  throw await timeoutError(
    app,
    `Timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last error: ${messageText(lastError)})` : ""}.`,
  );
}

export async function waitForText(app: Surface, text: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await waitFor(app, `document.body.innerText.includes(${jsValue(text)})`, {
    timeoutMs: opts.timeoutMs,
    label: `visible text ${jsValue(text)}`,
  });
}

export async function readSessionToolCalls(
  app: Surface,
  opts?: { sessionId?: string; timeoutMs?: number },
): Promise<SessionToolCall[]> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let sessionId = opts?.sessionId ?? "";
  let openedSessionId = "";

  while (Date.now() < deadline) {
    if (!sessionId) {
      const sessions = await control(app, "session.list_sessions", undefined, { timeoutMs: remainingReadMs(deadline) }).catch(() => null);
      sessionId = mostRecentSessionId(sessions);
    }

    if (Date.now() >= deadline) break;
    if (sessionId && openedSessionId !== sessionId) {
      const opened = await control(app, "session.open", { sessionId }, { timeoutMs: remainingReadMs(deadline) })
        .then(() => true)
        .catch(() => false);
      if (opened) openedSessionId = sessionId;
    }

    if (openedSessionId && Date.now() < deadline) {
      const transcript = await control(app, "session.read_transcript", { count: 30 }, { timeoutMs: remainingReadMs(deadline) }).catch(() => null);
      if (isRecord(transcript) && transcript.sessionId === openedSessionId) {
        const calls = parseSessionToolCalls(transcript);
        if (calls.length > 0) return calls;
      }
    }

    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }

  return [];
}

function remainingReadMs(deadline: number): number {
  return Math.max(1, Math.min(10_000, deadline - Date.now()));
}

function mostRecentSessionId(value: unknown): string {
  if (!Array.isArray(value)) return "";
  for (const session of value) {
    if (!isRecord(session) || typeof session.sessionId !== "string") continue;
    const sessionId = session.sessionId.trim();
    if (sessionId) return sessionId;
  }
  return "";
}

function timelineAt(value: Record<string, unknown>): string {
  for (const key of ["at", "timestamp", "createdAt"]) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function connectionIdFromCapability(capability: string): string | null {
  const parts = capability.split(":");
  if (parts.length !== 3 || (parts[0] !== "mcp" && parts[0] !== "native") || !parts[1] || !parts[2]) return null;
  return parts[1];
}

/** Parse the payload returned by the app's `session.read_transcript` control action. */
export function parseSessionToolCalls(value: unknown): SessionToolCall[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) return [];
  const calls: SessionToolCall[] = [];
  for (const message of value.messages) {
    if (!isRecord(message) || typeof message.text !== "string") continue;
    const matches = message.text.matchAll(/(?:^|\n)\[tool:([^\]\r\n]+)\]/g);
    for (const match of matches) {
      const capability = match[1];
      if (!capability) continue;
      calls.push({ capability, connectionId: connectionIdFromCapability(capability), at: timelineAt(message) });
    }
  }
  return calls;
}

export async function hasText(app: Surface, text: string): Promise<boolean> {
  return Boolean(await resilientRead(app, `document.body.innerText.includes(${jsValue(text)})`, { label: `text ${jsValue(text)}` }));
}

export async function visibleText(app: Surface): Promise<string> {
  const text = await resilientRead(app, "document.body.innerText", { label: "visible text" });
  if (typeof text !== "string") throw new Error("CDP did not return document.body.innerText as a string.");
  return text;
}

export async function clickText(
  app: Surface,
  text: string,
  { selector = "button, [role=button], a", timeoutMs = DEFAULT_TIMEOUT_MS }: { selector?: string; timeoutMs?: number } = {},
): Promise<unknown> {
  return waitFor(app, `(() => {
    const candidates = document.querySelectorAll(${jsValue(selector)});
    for (const element of candidates) {
      const label = (element.textContent ?? '').trim();
      if (label.includes(${jsValue(text)})) {
        element.scrollIntoView({ block: 'center' });
        element.click();
        return label;
      }
    }
    return null;
  })()`, { timeoutMs, label: `clickable element with text ${jsValue(text)}` });
}

export async function clickButton(app: Surface, label: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  await waitFor(app, `Boolean([...document.querySelectorAll('button')]
    .find((element) => (element.textContent ?? '').trim() === ${jsValue(label)} && !element.disabled))`, {
    timeoutMs,
    label: `enabled button: ${label}`,
  });
  const clicked = await evalIn(app, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => (element.textContent ?? '').trim() === ${jsValue(label)} && !element.disabled);
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`);
  if (clicked !== true) throw new Error(`Could not click ${label}.`);
}

export async function waitForButtonGone(app: Surface, label: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await waitFor(app, `!Boolean([...document.querySelectorAll('button')]
    .find((element) => (element.textContent ?? '').trim() === ${jsValue(label)}))`, {
    timeoutMs: opts.timeoutMs ?? 60_000,
    label: `button removed: ${label}`,
  });
}

export async function fill(app: Surface, selector: string, value: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await waitFor(app, `Boolean(document.querySelector(${jsValue(selector)}))`, {
    timeoutMs: opts.timeoutMs,
    label: `input ${selector}`,
  });
  await evalIn(app, `(() => {
    const input = document.querySelector(${jsValue(selector)});
    const setter = Object.getOwnPropertyDescriptor(
      input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, ${jsValue(value)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
}

export async function go(app: Surface, hashPath: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  const hash = hashPath.startsWith("#") ? hashPath : `#${hashPath}`;
  // Setting the hash is idempotent, so retry through renderer freeze bursts
  // rather than letting one blocked evaluate fail a whole spec. Contention (two
  // desktops on one host) makes those bursts routine, and a bare 20s evaluate
  // here was the single most common way a long journey died near its end.
  const timeoutMs = opts.timeoutMs ?? 60_000;
  await waitFor(app, `(() => { window.location.hash = ${jsValue(hash)}; return true; })()`, {
    timeoutMs,
    label: `navigate to ${hash}`,
  });
}

export async function waitForConnectionCard(app: Surface, name: string, workspaceId: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // Short per-probe timeout, failure tolerated: two desktops in one sandbox
    // make the renderer freeze in bursts, and a bare 20s evaluate turns one
    // freeze into a failed spec.
    const found = await evalIn(app, `([...document.querySelectorAll('button')]
      .some((button) => (button.textContent ?? '').includes(${JSON.stringify(name)})))`, { timeoutMs: 8_000 })
      .catch(() => false);
    if (found === true) return;
    // The app opens a freshly created session on its own, which navigates away
    // from settings mid-poll. Steer back, the way a person would click back.
    // The app CANONICALISES this route: /settings/extensions/connections
    // becomes /extensions/connections. Checking for the pre-rewrite form made
    // the steer-back below fire every iteration, so navigation fought the
    // rewrite and the surface never settled — which looked like a blank page.
    const onExtensions = await evalIn(app, `window.location.hash.includes("/extensions")`, { timeoutMs: 8_000 }).catch(() => false);
    if (onExtensions !== true) {
      await go(app, `/workspace/${workspaceId}/settings/extensions/connections`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      continue;
    }
    await evalIn(app, "window.__openworkControl.execute('extensions.refresh-marketplace', null)", { awaitPromise: true, timeoutMs: 15_000 })
      .catch(() => undefined);
    await evalIn(app, `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((element) => (element.textContent ?? '').trim() === 'Refresh' && !element.disabled);
      button?.click();
      return Boolean(button);
    })()`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  // Say what WAS on screen: "card missing" alone cannot distinguish an
  // unmounted surface from a connection den never offered this member.
  const seen = await evalIn(app, `({
    hash: window.location.hash,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 40),
    text: (document.body.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 600),
  })`).catch(() => null);
  throw new Error(`The connection card ${name} never appeared. On screen: ${JSON.stringify(seen)}`);
}

/**
 * Wait for text to be REALLY on screen, then bring it into view.
 *
 * waitForText proves the DOM contains it; a frame proves pixels. The detail
 * panel paints slightly after its text lands, so screenshotting on the DOM
 * signal alone captures a blank panel intermittently.
 */
export async function revealText(app: Surface, text: string, timeoutMs = 45_000): Promise<void> {
  await waitFor(app, `(() => {
    // innerText, not textContent: innerText is render-aware, so CSS
    // text-transform (a badge styled uppercase) matches what waitForText saw
    // and what a person reads. Comparing raw textContent can never agree.
    const wanted = ${JSON.stringify(text)}.toLowerCase();
    const nodes = [...document.querySelectorAll("button, h1, h2, h3, p, span, div")];
    const node = nodes.reverse().find((element) => ((element.innerText ?? element.textContent ?? "")).toLowerCase().includes(wanted));
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    node.scrollIntoView({ block: "center" });
    return true;
  })()`, { timeoutMs, label: `visible text ${JSON.stringify(text)}` });
  // One paint after scrolling, so the frame is not captured mid-scroll.
  await new Promise((resolve) => setTimeout(resolve, 750));
}

/**
 * The connections surface, settled — polling before it mounts finds nothing.
 *
 * Navigates in a steer-back loop, not once: the app opens a freshly created
 * session on its own, and that navigation can land AFTER our go(), parking
 * the app on /session while a single 60s wait times out. Same race and same
 * cure as waitForConnectionCard.
 */
export async function openConnectionsSurface(app: Surface, workspaceId: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const settled = await evalIn(
      app,
      `window.location.hash.includes("/extensions") && document.body.innerText.includes("Extensions")`,
      { timeoutMs: 8_000 },
    ).catch(() => false);
    if (settled === true) return;
    await go(app, `/workspace/${workspaceId}/settings/extensions/connections`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  // Say what WAS on screen: a bare timeout cannot distinguish a route that
  // never rewrote from a shell the app steered somewhere else entirely.
  const seen = await evalIn(app, `({
    hash: window.location.hash,
    title: document.title,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent ?? '').replace(/\\s+/g, ' ').trim()).filter(Boolean).slice(0, 30),
    text: (document.body.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 500),
  })`, { timeoutMs: 10_000 }).catch(() => null);
  throw new Error(`The extensions connections surface never settled. On screen: ${JSON.stringify(seen)}`);
}

export async function currentHash(app: Surface): Promise<string> {
  const hash = await resilientRead(app, "window.location.hash", { label: "location hash" });
  if (typeof hash !== "string") throw new Error("CDP did not return window.location.hash as a string.");
  return hash;
}

export async function enabledButtons(app: Surface): Promise<string[]> {
  const labels = await resilientRead(app, `[...document.querySelectorAll('button')]
    .filter((element) => !element.disabled)
    .map((element) => (element.textContent ?? '').trim())
    .filter(Boolean)`, { label: "enabled buttons" });
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string")) {
    throw new Error("CDP did not return enabled button labels as strings.");
  }
  return labels;
}

/** Invoke a registered `window.__openworkControl` action, the product's own automation seam. */
export async function control(
  app: Surface,
  action: string,
  args?: unknown,
  opts: EvaluateOptions = {},
): Promise<unknown> {
  const result = await evalIn(
    app,
    `window.__openworkControl.execute(${JSON.stringify(action)}, ${JSON.stringify(args ?? null)})`,
    { ...opts, awaitPromise: true },
  );
  if (!isRecord(result) || result.ok !== true) {
    throw new Error(`Desktop control action ${action} failed: ${isRecord(result) ? String(result.error ?? "unknown") : "unknown"}`);
  }
  return result.result;
}

/**
 * Wait until the app is interactive again — the same predicate the lifecycle
 * layer applies when handing out a desktop handle. Use it after any action that
 * navigates or creates a workspace/session, so assertions and frames never race
 * the app's loading placeholders.
 */
export async function waitUntilInteractive(
  app: Surface,
  { timeoutMs = 60_000 }: { timeoutMs?: number } = {},
): Promise<AppStateProbe> {
  const deadline = Date.now() + timeoutMs;
  let last: AppStateProbe = { controlReady: false, transitional: null, surface: null, workspaceId: null, route: "", text: "" };
  while (Date.now() < deadline) {
    try {
      last = await probeAppState(app.client, {
        timeoutMs: Math.min(DEFAULT_DOM_PROBE_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
      });
      if (isInteractive(last)) return last;
    } catch {
      // A navigation can destroy the execution context mid-probe.
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throw await timeoutError(app, `App did not become interactive after ${timeoutMs}ms: ${describeAppState(last)}`);
}

/** Wait until the page's visible text stops changing — the app is done working. */
export async function waitUntilTextStable(
  app: Surface,
  { quietMs = 6_000, timeoutMs = 60_000 }: { quietMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let previous = "";
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const currentValue = await evalIn(app, "document.body.innerText", {
      timeoutMs: Math.min(DEFAULT_DOM_PROBE_TIMEOUT_MS, Math.max(0, deadline - Date.now())),
    }).catch(() => previous);
    const current = typeof currentValue === "string" ? currentValue : previous;
    if (current !== previous) {
      previous = current;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return current;
    }
    await sleep(Math.min(1_000, Math.max(0, deadline - Date.now())));
  }
  throw await timeoutError(app, `Visible text did not stabilize after ${timeoutMs}ms. Last text: ${JSON.stringify(previous.slice(0, 500))}.`);
}
