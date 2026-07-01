import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureScreenshot, evaluate } from "./cdp.mjs";

const DEFAULT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EvalError extends Error {}

function pngDimensions(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a" || buffer.length < 24) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function slug(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "frame";
}

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
    this.evidenceFrames = [];
    this.logs = [];
    this.screenshotIndex = 0;
    this.currentStepName = null;
    this.currentStepEvidence = [];
    this.lastScreenshotHash = null;
  }

  beginStep(name) {
    this.currentStepName = name;
    this.currentStepEvidence = [];
  }

  endStep() {
    const evidence = this.currentStepEvidence;
    this.currentStepName = null;
    this.currentStepEvidence = [];
    return evidence;
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

  recordEvidence(entry) {
    const next = {
      step: this.currentStepName,
      at: new Date().toISOString(),
      ...entry,
    };
    this.currentStepEvidence.push(next);
    return next;
  }

  async expectText(text, options = {}) {
    await this.waitForText(text, options);
    return this.recordEvidence({ type: "assertion", status: "passed", assertion: `Visible text includes ${JSON.stringify(text)}` });
  }

  async expectNoText(text) {
    const present = await this.hasText(text);
    if (present) {
      this.recordEvidence({ type: "assertion", status: "failed", assertion: `Visible text does not include ${JSON.stringify(text)}` });
      throw new EvalError(`Unexpected visible text: ${text}`);
    }
    return this.recordEvidence({ type: "assertion", status: "passed", assertion: `Visible text does not include ${JSON.stringify(text)}` });
  }

  async expectHashIncludes(fragment) {
    const hash = await this.eval("window.location.hash");
    const passed = typeof hash === "string" && hash.includes(fragment);
    this.recordEvidence({
      type: "assertion",
      status: passed ? "passed" : "failed",
      assertion: `URL hash includes ${JSON.stringify(fragment)}`,
      actual: hash,
    });
    if (!passed) throw new EvalError(`Expected URL hash to include ${fragment}, got ${hash}`);
  }

  async prove(name, options) {
    const claim = options?.claim ?? name;
    this.recordEvidence({ type: "claim", status: "running", name, claim });
    if (typeof options?.action === "function") await options.action();
    if (typeof options?.assert === "function") await options.assert();
    if (options?.screenshot) {
      const screenshot = typeof options.screenshot === "string"
        ? { name: options.screenshot }
        : options.screenshot;
      await this.screenshot(screenshot.name ?? slug(name), { claim, ...screenshot });
    }
    this.recordEvidence({ type: "claim", status: "passed", name, claim });
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
   * Force light mode for screenshot readability, reloading only if the app
   * isn't already light. fraimz frame proofs are reviewed as images (in
   * fraimz.html and exported to docs/PRs); the OS-following "system" default
   * renders dark-on-dark text illegible whenever the host machine is in dark
   * mode. Light mode is the readable baseline for evidence, so the runner
   * applies it automatically unless a flow opts out via `preserveTheme: true`
   * (for a flow that is itself testing theme/dark-mode behavior).
   */
  async ensureLightMode() {
    await this.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 30_000,
      label: "control API before theme check",
    });
    const currentTheme = await this.eval("document.documentElement.dataset.theme").catch(() => null);
    if (currentTheme === "light") {
      return;
    }
    await this.eval(`(() => {
      localStorage.setItem('openwork.react.settings.theme-mode', 'light');
      return true;
    })()`);
    await this.eval("location.reload()");
    await this.waitFor("Boolean(window.__openworkControl)", {
      timeoutMs: 30_000,
      label: "control API after forcing light mode",
    });
    await this.waitFor("document.documentElement.dataset.theme === 'light'", {
      timeoutMs: 10_000,
      label: "light theme applied",
    });
    this.log(`Forced light mode for screenshot readability (was: ${currentTheme ?? "unknown"}).`);
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

  async screenshot(name, options = {}) {
    this.screenshotIndex += 1;
    const fileName = `${this.flowId}-${String(this.screenshotIndex).padStart(2, "0")}-${slug(name)}.png`;
    const buffer = await captureScreenshot(this.client);
    await writeFile(join(this.outDir, fileName), buffer);
    this.screenshots.push(fileName);
    const bodyText = await this.eval("document.body.innerText").catch(() => "");
    const url = await this.eval("location.href").catch(() => "");
    const hash = createHash("sha256").update(buffer).digest("hex");
    const dimensions = pngDimensions(buffer);
    const validations = [
      { label: "PNG exists and is non-empty", passed: buffer.length > 0, detail: `${buffer.length} bytes` },
      { label: "PNG dimensions are sane", passed: Boolean(dimensions?.width && dimensions?.height), detail: dimensions ? `${dimensions.width}x${dimensions.height}` : "unknown" },
      { label: "Frame is not a duplicate of the previous capture", passed: this.lastScreenshotHash !== hash, detail: hash.slice(0, 12) },
    ];
    for (const text of options.requireText ?? []) {
      validations.push({ label: `Required visible text: ${text}`, passed: typeof bodyText === "string" && bodyText.includes(text) });
    }
    for (const text of options.rejectText ?? []) {
      validations.push({ label: `Rejected visible text: ${text}`, passed: !(typeof bodyText === "string" && bodyText.includes(text)) });
    }
    if (options.hashIncludes) {
      validations.push({ label: `URL hash includes ${options.hashIncludes}`, passed: typeof url === "string" && url.includes(options.hashIncludes), detail: url });
    }
    const passed = validations.every((item) => item.passed);
    this.lastScreenshotHash = hash;
    const frame = {
      type: "frame",
      status: passed ? "passed" : "failed",
      file: fileName,
      name,
      claim: options.claim ?? null,
      url,
      validations,
    };
    this.evidenceFrames.push(frame);
    this.recordEvidence(frame);
    this.log(`Screenshot: ${fileName}`);
    if (!passed && options.allowInvalid !== true) {
      const failed = validations.filter((item) => !item.passed).map((item) => item.label).join(", ");
      throw new EvalError(`Screenshot evidence failed validation: ${failed}`);
    }
    return fileName;
  }
}
