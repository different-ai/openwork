import { describeAppState, evaluate, isInteractive, probeAppState } from "@openwork/cdp";
import type { AppStateProbe, EvaluateOptions, Surface } from "@openwork/cdp";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const DEFAULT_TIMEOUT_MS = 20_000;
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
  return evaluate(app.client, expression, opts);
}

export async function waitFor(
  app: Surface,
  expression: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS, label = expression }: { timeoutMs?: number; label?: string } = {},
): Promise<unknown> {
  const startedAt = Date.now();
  let lastError: unknown = null;
  // A busy renderer can take longer than the CDP client's default per-call
  // timeout to answer; the wait's own deadline bounds the loop, so let each
  // evaluation use the remaining budget instead of dying on the default.
  const evalTimeoutMs = Math.min(Math.max(timeoutMs, 20_000), 120_000);
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await evalIn(app, expression, { timeoutMs: evalTimeoutMs });
      if (value) return value;
      lastError = null;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastError ? ` (last error: ${messageText(lastError)})` : ""}.`);
}

export async function waitForText(app: Surface, text: string, opts: { timeoutMs?: number } = {}): Promise<void> {
  await waitFor(app, `document.body.innerText.includes(${jsValue(text)})`, {
    timeoutMs: opts.timeoutMs,
    label: `visible text ${jsValue(text)}`,
  });
}

export async function hasText(app: Surface, text: string, opts: EvaluateOptions = {}): Promise<boolean> {
  return Boolean(await evalIn(app, `document.body.innerText.includes(${jsValue(text)})`, opts));
}

export async function visibleText(app: Surface, opts: EvaluateOptions = {}): Promise<string> {
  const text = await evalIn(app, "document.body.innerText", opts);
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
    timeoutMs: opts.timeoutMs ?? 90_000,
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

export async function go(app: Surface, hashPath: string): Promise<void> {
  const hash = hashPath.startsWith("#") ? hashPath : `#${hashPath}`;
  await evalIn(app, `(() => { window.location.hash = ${jsValue(hash)}; return true; })()`);
}

export async function currentHash(app: Surface): Promise<string> {
  const hash = await evalIn(app, "window.location.hash");
  if (typeof hash !== "string") throw new Error("CDP did not return window.location.hash as a string.");
  return hash;
}

export async function enabledButtons(app: Surface): Promise<string[]> {
  const labels = await evalIn(app, `[...document.querySelectorAll('button')]
    .filter((element) => !element.disabled)
    .map((element) => (element.textContent ?? '').trim())
    .filter(Boolean)`);
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
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
): Promise<AppStateProbe> {
  const deadline = Date.now() + timeoutMs;
  let last: AppStateProbe = { controlReady: false, transitional: null, surface: null, workspaceId: null, route: "", text: "" };
  while (Date.now() < deadline) {
    try {
      last = await probeAppState(app.client, { timeoutMs: Math.min(timeoutMs, 120_000) });
      if (isInteractive(last)) return last;
    } catch {
      // A navigation can destroy the execution context mid-probe.
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`App did not become interactive after ${timeoutMs}ms: ${describeAppState(last)}`);
}
