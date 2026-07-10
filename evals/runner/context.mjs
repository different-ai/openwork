import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { captureScreenshot, connect, debuggerUrlFor, evaluate, listTargets, pickAppTarget } from "./cdp.mjs";
import { captureDaytonaComputerUseScreenshot } from "./daytona-computer-use.mjs";

const execFileAsync = promisify(execFile);

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
  constructor({ client, outDir, flowId, env, cdpBaseUrl }) {
    this.client = client;
    this.outDir = outDir;
    this.flowId = flowId;
    this.env = env;
    this.cdpBaseUrl = cdpBaseUrl ?? null;
    this.screenshots = [];
    this.evidenceFrames = [];
    this.logs = [];
    this.screenshotIndex = 0;
    this.currentStepName = null;
    this.currentStepEvidence = [];
    this.lastScreenshotHash = null;
    this.tabStack = [];
  }

  /**
   * Waits for a new browser tab/page target to appear (e.g. an OAuth
   * `window.open` popup) and switches ctx.eval/screenshot/etc to it. Push
   * the previous target with switchBack() once done with the new tab.
   * Requires cdpBaseUrl (set automatically by the runner); not available
   * against a raw client-only context.
   */
  async switchToNewTab({ match, timeoutMs = DEFAULT_TIMEOUT_MS, label } = {}) {
    if (!this.cdpBaseUrl) {
      throw new EvalError("switchToNewTab requires cdpBaseUrl on the context.");
    }
    const before = await listTargets(this.cdpBaseUrl);
    const beforeIds = new Set(before.map((entry) => entry.id));
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const targets = await listTargets(this.cdpBaseUrl);
      const candidate = targets.find(
        (entry) => entry.type === "page" && entry.webSocketDebuggerUrl && !beforeIds.has(entry.id) && (!match || match(entry)),
      );
      if (candidate) {
        const newClient = await connect(debuggerUrlFor(this.cdpBaseUrl, candidate));
        this.tabStack.push(this.client);
        this.client = newClient;
        this.log(`Switched to new tab: ${candidate.title || candidate.url}`);
        return candidate;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new EvalError(`Timed out after ${timeoutMs}ms waiting for a new tab${label ? ` (${label})` : ""}.`);
  }

  /** Returns focus to whichever tab was active before the last switchToNewTab(). */
  async switchBack() {
    const previous = this.tabStack.pop();
    if (previous) {
      try {
        this.client?.close();
      } catch {
        // The popup may already have closed itself after OAuth completion.
      }
      this.client = previous;
      if (this.cdpBaseUrl && previous.targetId) {
        const baseUrl = this.cdpBaseUrl.replace(/\/$/, "");
        await fetch(`${baseUrl}/json/activate/${encodeURIComponent(previous.targetId)}`).catch(() => undefined);
      }
      await previous.send("Page.bringToFront").catch(() => undefined);
    }
  }

  async reconnect({ timeoutMs = 90_000 } = {}) {
    if (!this.cdpBaseUrl) {
      throw new EvalError("reconnect requires cdpBaseUrl on the context.");
    }
    try {
      this.client?.close();
    } catch {
      // The app may already be gone during relaunch.
    }
    for (const tabClient of this.tabStack) {
      try {
        tabClient.close();
      } catch {
        // Ignore stale tab clients.
      }
    }
    this.tabStack = [];

    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeoutMs) {
      try {
        const target = await pickAppTarget(this.cdpBaseUrl);
        const nextClient = await connect(debuggerUrlFor(this.cdpBaseUrl, target));
        await nextClient.send("Page.enable").catch(() => undefined);
        this.client = nextClient;
        this.log(`Reconnected to app target: ${target.title || target.url}`);
        return target;
      } catch (error) {
        lastError = error;
        await sleep(POLL_INTERVAL_MS);
      }
    }
    throw new EvalError(
      `Timed out after ${timeoutMs}ms reconnecting to Electron CDP` +
        (lastError ? ` (last error: ${lastError.message})` : ""),
    );
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
    const voiceover = typeof options?.voiceover === "string" ? options.voiceover.trim() : "";
    this.recordEvidence({ type: "claim", status: "running", name, claim, voiceover });
    if (typeof options?.action === "function") await options.action();
    if (typeof options?.assert === "function") await options.assert();
    if (options?.screenshot) {
      const screenshot = typeof options.screenshot === "string"
        ? { name: options.screenshot }
        : options.screenshot;
      await this.screenshot(screenshot.name ?? slug(name), { claim, voiceover, ...screenshot });
    }
    // When a screenshot frame carries the narration, leave it off the completed
    // claim so fraimz.html narrates each frame exactly once (app-less proves
    // narrate via the claim instead).
    this.recordEvidence({ type: "claim", status: "passed", name, claim, voiceover: options?.screenshot ? "" : voiceover });
  }

  /** Record a terminal/API output as reviewable evidence (rendered as a code block). */
  output(name, text) {
    return this.recordEvidence({ type: "output", name, text: String(text) });
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
   * Dispatch a real browser click via CDP input events. Use this when a flow
   * needs transient user activation (clipboard, popup, etc.).
   */
  async trustedClick(selector, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const point = await this.waitFor(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      if (el instanceof HTMLButtonElement && el.disabled) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return null;
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        label: (el.textContent ?? "").trim(),
      };
    })()`, { timeoutMs, label: `trusted clickable element ${selector}` });

    await this.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await this.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await this.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    this.log(`Trusted clicked ${selector}${point.label ? `: ${point.label}` : ""}`);
    return point.label;
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

  /**
   * Connect to a specific CDP page target (by id or URL substring), verifying
   * the connection is actually responsive with a real Page.captureScreenshot
   * call before returning it — a fresh connection's first call can
   * intermittently time out through the Daytona proxy even though the target
   * is healthy. Retries with a brand-new connection up to 3x. Returns the
   * client plus the screenshot buffer captured during the responsiveness
   * check (reuse it instead of shooting twice).
   */
  async _connectVerifiedTarget(targetId, targetUrlIncludes) {
    if (!this.cdpBaseUrl) {
      throw new EvalError("Targeting a specific CDP target requires cdpBaseUrl on the context.");
    }
    const attempts = 3;
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const targets = await listTargets(this.cdpBaseUrl);
        const target = targets.find((entry) => (
          entry.type === "page" &&
          entry.webSocketDebuggerUrl &&
          (!targetId || entry.id === targetId) &&
          (!targetUrlIncludes || String(entry.url ?? "").includes(targetUrlIncludes))
        ));
        if (!target) {
          throw new EvalError(`No CDP target found matching ${JSON.stringify({ targetId, targetUrlIncludes })}.`);
        }
        const client = await connect(debuggerUrlFor(this.cdpBaseUrl, target));
        await client.send("Page.enable").catch(() => undefined);
        const buffer = await captureScreenshot(client);
        return { client, buffer };
      } catch (error) {
        lastError = error;
        this.log(`CDP target connection attempt ${attempt + 1}/${attempts} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw lastError;
  }

  /**
   * Real OS-level screen grab (X11, via ffmpeg x11grab) inside a Daytona
   * sandbox. Needed for content that CDP's Page.captureScreenshot cannot see
   * at all — an Electron BrowserView/WebContentsView embedded in another
   * window (e.g. the built-in browser panel) is a separate compositor
   * surface, invisible to both its own target's AND the parent window's
   * Page.captureScreenshot. The sandbox's shell script does a true screen
   * capture, so it sees everything actually composited on screen.
   *
   * The daytona CLI joins argv after `--` into one remote shell string, so
   * nested quoting never survives — ship the whole capture+encode pipeline
   * as base64 piped into bash (same trick used for other daytona exec calls
   * in the flows).
   */
  async _captureSandboxScreenshot(sandbox) {
    const remotePath = `/tmp/eval-screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
    const script = `bash .devcontainer/capture-daytona-screenshot.sh --output ${remotePath} >/tmp/eval-screenshot-capture.log 2>&1 && base64 ${remotePath}`;
    const encoded = Buffer.from(script, "utf8").toString("base64");
    const { stdout } = await execFileAsync("daytona", ["exec", sandbox, "--", "echo", encoded, "|", "base64", "-d", "|", "bash"], {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const base64Png = stdout.trim();
    if (!base64Png) {
      throw new EvalError("Sandbox screenshot capture returned no data.");
    }
    return Buffer.from(base64Png, "base64");
  }

  async _captureComputerUseScreenshot(sandbox) {
    const buffer = await captureDaytonaComputerUseScreenshot(sandbox);
    if (buffer.length === 0) {
      throw new EvalError("Daytona Computer Use screenshot capture returned no data.");
    }
    return buffer;
  }

  async screenshot(name, options = {}) {
    this.screenshotIndex += 1;
    const fileName = `${this.flowId}-${String(this.screenshotIndex).padStart(2, "0")}-${slug(name)}.png`;
    const sandbox = options.sandboxCapture === "computer-use"
      ? (this.env.OPENWORK_EVAL_DAYTONA_SANDBOX_ID || this.env.OPENWORK_EVAL_DAYTONA_SANDBOX)?.trim()
      : options.sandboxCapture
        ? this.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim()
        : null;
    const targetSelector = !sandbox && (options.targetId || options.targetUrlIncludes);
    const textTargetSelector = options.textTargetId || options.textTargetUrlIncludes;
    let screenshotClient = this.client;
    let closeClients = [];
    let preCapturedBuffer = null;
    if (sandbox) {
      preCapturedBuffer = options.sandboxCapture === "computer-use"
        ? await this._captureComputerUseScreenshot(sandbox)
        : await this._captureSandboxScreenshot(sandbox);
    } else if (targetSelector) {
      // Some CDP page targets (e.g. an embedded browser-panel WebContentsView
      // rather than a top-level BrowserWindow page) do not reliably answer
      // Page.captureScreenshot at all — no amount of retrying fixes that.
      // Callers who know their target renders visually within the PRIMARY
      // window (e.g. a split-pane browser panel) should omit targetId/
      // targetUrlIncludes for the capture and use textTargetId/
      // textTargetUrlIncludes instead to validate text against the embedded
      // view's own DOM.
      const { client, buffer } = await this._connectVerifiedTarget(options.targetId, options.targetUrlIncludes);
      screenshotClient = client;
      preCapturedBuffer = buffer;
      closeClients.push(client);
    }
    // Text/URL validation can target a DIFFERENT CDP target than the one
    // that took the screenshot — needed when the visible pixels come from a
    // parent window (primary target) but the relevant DOM text lives in an
    // embedded, separately-targeted view (e.g. the built-in browser panel).
    let textClient = screenshotClient;
    if (textTargetSelector) {
      const { client } = await this._connectVerifiedTarget(options.textTargetId, options.textTargetUrlIncludes);
      textClient = client;
      closeClients.push(client);
    }
    try {
      const buffer = preCapturedBuffer ?? await captureScreenshot(screenshotClient);
      await writeFile(join(this.outDir, fileName), buffer);
      this.screenshots.push(fileName);
      const bodyText = await evaluate(textClient, "document.body.innerText").catch(() => "");
      const url = await evaluate(textClient, "location.href").catch(() => "");
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
        voiceover: typeof options.voiceover === "string" && options.voiceover.trim() ? options.voiceover.trim() : null,
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
    } finally {
      for (const client of closeClients) {
        try {
          client.close();
        } catch {
          // Ignore target cleanup errors.
        }
      }
    }
  }
}
