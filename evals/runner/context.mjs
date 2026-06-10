import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureScreenshot, evaluate } from "./cdp.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EvalError extends Error {}

/**
 * Per-flow execution context handed to every step's `run(ctx)`.
 *
 * Helpers favor poll-until-condition over fixed sleeps so flows stay fast on
 * fast machines and resilient on slow sandboxes.
 */
export class EvalContext {
  constructor({ client, outDir, flowId, env }) {
    this.client = client;
    this.outDir = outDir;
    this.flowId = flowId;
    this.env = env;
    this.screenshots = [];
    this.logs = [];
    this.screenshotIndex = 0;
  }

  log(message) {
    this.logs.push(`[${new Date().toISOString()}] ${message}`);
  }

  async eval(expression, options = {}) {
    return evaluate(this.client, expression, options);
  }

  assert(condition, message) {
    if (!condition) throw new EvalError(message);
  }

  /**
   * Poll a JS expression until it returns truthy. Returns the final value.
   */
  async waitFor(expression, { timeoutMs = DEFAULT_TIMEOUT_MS, label } = {}) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const value = await this.eval(expression);
        if (value) return value;
        lastError = null;
      } catch (error) {
        lastError = error;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    const what = label ?? expression;
    throw new EvalError(
      `Timed out after ${timeoutMs}ms waiting for: ${what}` +
        (lastError ? ` (last error: ${lastError.message})` : ""),
    );
  }

  /**
   * Poll until the page's visible text contains `text`.
   */
  async waitForText(text, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    await this.waitFor(
      `document.body.innerText.includes(${JSON.stringify(text)})`,
      { timeoutMs, label: `visible text ${JSON.stringify(text)}` },
    );
  }

  async hasText(text) {
    return Boolean(
      await this.eval(`document.body.innerText.includes(${JSON.stringify(text)})`),
    );
  }

  /**
   * Click the first element matching `selector` whose trimmed text contains
   * `text`. Polls until the element exists and is clicked.
   */
  async clickText(text, { selector = "button, [role=button], a", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const expression = `(() => {
      const candidates = document.querySelectorAll(${JSON.stringify(selector)});
      for (const el of candidates) {
        const label = (el.textContent ?? "").trim();
        if (label.includes(${JSON.stringify(text)})) {
          el.scrollIntoView({ block: "center" });
          el.click();
          return label;
        }
      }
      return null;
    })()`;
    const clicked = await this.waitFor(expression, {
      timeoutMs,
      label: `clickable element with text ${JSON.stringify(text)}`,
    });
    this.log(`Clicked: ${clicked}`);
    return clicked;
  }

  /**
   * Fill a controlled React input via the native value setter + input event.
   */
  async fill(selector, value, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    await this.waitFor(`Boolean(document.querySelector(${JSON.stringify(selector)}))`, {
      timeoutMs,
      label: `input ${selector}`,
    });
    await this.eval(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype,
        "value",
      ).set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    this.log(`Filled ${selector}`);
  }

  /**
   * Navigate the app via hash routing (the convention used by all evals).
   */
  async navigateHash(path) {
    const hash = path.startsWith("#") ? path : `#${path}`;
    await this.eval(`(() => { window.location.hash = ${JSON.stringify(hash)}; return true; })()`);
    this.log(`Navigated to ${hash}`);
  }

  /**
   * Execute a registered window.__openworkControl action.
   */
  async control(actionId, args) {
    const result = await this.eval(
      `window.__openworkControl.execute(${JSON.stringify(actionId)}, ${JSON.stringify(args ?? null)})`,
      { awaitPromise: true },
    );
    if (!result?.ok) {
      throw new EvalError(`Control action ${actionId} failed: ${result?.error ?? "unknown"}`);
    }
    return result.result;
  }

  async screenshot(name) {
    this.screenshotIndex += 1;
    const fileName = `${this.flowId}-${String(this.screenshotIndex).padStart(2, "0")}-${name}.png`;
    const buffer = await captureScreenshot(this.client);
    await writeFile(join(this.outDir, fileName), buffer);
    this.screenshots.push(fileName);
    this.log(`Screenshot: ${fileName}`);
    return fileName;
  }
}
