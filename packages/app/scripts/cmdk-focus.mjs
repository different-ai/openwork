import assert from "node:assert/strict";
import { once } from "node:events";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { findFreePort, parseArgs } from "./_util.mjs";

const args = parseArgs(process.argv.slice(2));
const url = args.get("url") ?? process.env.OPENWORK_UI_URL;

if (!url) {
  throw new Error("Provide --url or OPENWORK_UI_URL for the OpenWork session page.");
}

const chromePath = resolveChromePath();
const debugPort = await findFreePort();
const userDataDir = mkdtempSync(path.join(os.tmpdir(), "openwork-cmdk-focus-"));
const failureScreenshotPath = args.get("failure-shot") ?? "";

const chrome = spawn(
  chromePath,
  [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-extensions",
    "about:blank",
  ],
  {
    stdio: ["ignore", "ignore", "pipe"],
    env: process.env,
  },
);

let chromeStderr = "";
chrome.stderr.setEncoding("utf8");
chrome.stderr.on("data", (chunk) => {
  chromeStderr += chunk;
});

let client;
let currentStep = "boot";

try {
  currentStep = "connect";
  client = await connectToPage(debugPort);
  await client.send("Page.enable");
  await client.send("Runtime.enable");
  await client.send("Input.setIgnoreInputEvents", { ignore: false });

  currentStep = "navigate";
  await client.send("Page.navigate", { url });
  await waitFor(client, () =>
    evaluate(client, `Boolean(document.querySelector('[role="textbox"]'))`),
  );

  currentStep = "focus-composer";
  await evaluate(
    client,
    `(() => {
      const textbox = document.querySelector('[role="textbox"]');
      if (!(textbox instanceof HTMLElement)) return false;
      textbox.focus();
      return document.activeElement === textbox;
    })()`,
  );

  currentStep = "seed-draft";
  await client.send("Input.insertText", { text: "draft" });
  await waitFor(client, () =>
    evaluate(
      client,
      `document.querySelector('[role="textbox"]')?.textContent === "draft"`,
    ),
  );

  currentStep = "open-quick-actions";
  await openQuickActions(client);

  currentStep = "filter-thinking";
  await evaluate(
    client,
    `(() => {
      const input = document.querySelector('input[aria-label="Quick actions"]');
      if (!(input instanceof HTMLInputElement)) return false;
      input.focus();
      input.value = "thinking";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`,
  );
  await waitFor(client, () =>
    evaluate(
      client,
      `Array.from(document.querySelectorAll("button")).some((node) => {
        const text = (node.textContent ?? "").trim().replace(/\\s+/g, " ");
        return text.includes("Change thinking");
      })`,
    ),
  );

  currentStep = "choose-thinking";
  await clickElement(
    client,
    buttonByTextExpression(`text.includes("Change thinking")`),
  );

  currentStep = "wait-thinking-mode";
  await waitFor(client, () =>
    evaluate(
      client,
      `Boolean(document.querySelector('input[aria-label="Change thinking"]'))`,
    ),
  );

  currentStep = "choose-low";
  await clickElement(
    client,
    buttonByTextExpression(`text.startsWith("Low")`),
  );

  currentStep = "wait-palette-close";
  await waitFor(client, () =>
    evaluate(
      client,
      `document.querySelector('input[aria-label="Change thinking"]') == null &&
       document.querySelector('input[aria-label="Quick actions"]') == null`,
    ),
  );

  currentStep = "assert-focus";
  await waitFor(client, () =>
    evaluate(
      client,
      `(() => {
        const textbox = document.querySelector('[role="textbox"]');
        return document.activeElement === textbox;
      })()`,
    ),
  );

  currentStep = "append-text";
  await client.send("Input.insertText", { text: " follow-up" });

  currentStep = "assert-text";
  await waitFor(client, () =>
    evaluate(
      client,
      `document.querySelector('[role="textbox"]')?.textContent === "draft follow-up"`,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        step: currentStep,
        url,
        textboxText: await evaluate(
          client,
          `document.querySelector('[role="textbox"]')?.textContent ?? ""`,
        ),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (client && failureScreenshotPath) {
    try {
      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
      });
      writeFileSync(failureScreenshotPath, Buffer.from(screenshot.data, "base64"));
    } catch {
      // Ignore screenshot capture failures; the original test failure is more important.
    }
  }

  console.error(
    JSON.stringify(
      {
        ok: false,
        step: currentStep,
        url,
        error: error instanceof Error ? error.message : String(error),
        chromeStderr,
        failureScreenshotPath: failureScreenshotPath || null,
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  client?.close();
  await closeChrome(chrome);
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // Chrome can keep ephemeral files around briefly; ignore cleanup errors in the test harness.
  }
}

function resolveChromePath() {
  const candidates = [
    process.env.OPENWORK_CHROME_BIN,
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    "Could not find Chrome. Set OPENWORK_CHROME_BIN or CHROME_BIN to a Chrome-compatible executable.",
  );
}

async function connectToPage(debugPort) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < 15000) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const pages = await response.json();
      const page = pages.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) {
        return await createCdpClient(page.webSocketDebuggerUrl);
      }
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }

  const message =
    lastError instanceof Error ? lastError.message : "timed out waiting for Chrome debugger";
  throw new Error(`Failed to connect to Chrome debugger: ${message}`);
}

async function createCdpClient(wsUrl) {
  const socket = new WebSocket(wsUrl);
  await onceOpen(socket);

  let nextId = 0;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id) return;
    const resolver = pending.get(message.id);
    if (!resolver) return;
    pending.delete(message.id);
    if (message.error) {
      resolver.reject(new Error(message.error.message));
      return;
    }
    resolver.resolve(message.result ?? {});
  });

  socket.addEventListener("close", () => {
    for (const resolver of pending.values()) {
      resolver.reject(new Error("Chrome debugger socket closed"));
    }
    pending.clear();
  });

  return {
    async send(method, params = {}) {
      const id = ++nextId;
      const promise = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      socket.send(JSON.stringify({ id, method, params }));
      return await promise;
    },
    close() {
      socket.close();
    },
  };
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text ?? "Failed to evaluate expression");
  }

  return result.result?.value;
}

async function waitFor(client, predicate, { timeoutMs = 15000, pollMs = 100 } = {}) {
  const matched = await waitForBoolean(client, predicate, { timeoutMs, pollMs });
  if (matched) {
    return;
  }
  throw new Error("Timed out waiting for browser condition");
}

async function waitForBoolean(client, predicate, { timeoutMs = 15000, pollMs = 100 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) {
      return true;
    }
    await delay(pollMs);
  }
  return false;
}

function buttonByTextExpression(matchExpression) {
  return `(() => Array.from(document.querySelectorAll("button")).find((node) => {
    const text = (node.textContent ?? "").trim().replace(/\\s+/g, " ");
    return ${matchExpression};
  }) ?? null)()`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };

    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (event) => {
      cleanup();
      reject(event.error ?? new Error("Failed to open Chrome debugger socket"));
    };

    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("error", onError, { once: true });
  });
}

async function closeChrome(chromeProcess) {
  if (chromeProcess.exitCode != null || chromeProcess.signalCode != null) {
    return;
  }

  chromeProcess.kill("SIGTERM");
  const exited = await Promise.race([
    once(chromeProcess, "exit").then(() => true),
    delay(2000).then(() => false),
  ]);

  if (exited) {
    return;
  }

  chromeProcess.kill("SIGKILL");
  await Promise.race([
    once(chromeProcess, "exit").then(() => true),
    delay(1000).then(() => false),
  ]);
}

async function openQuickActions(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    nativeVirtualKeyCode: 40,
    modifiers: 4,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "k",
    code: "KeyK",
    windowsVirtualKeyCode: 75,
    nativeVirtualKeyCode: 40,
    modifiers: 4,
  });

  const openedWithShortcut = await waitForBoolean(client, () =>
    evaluate(
      client,
      `Boolean(document.querySelector('input[aria-label="Quick actions"]'))`,
    ),
    { timeoutMs: 1500 },
  );

  if (openedWithShortcut) {
    return;
  }

  await clickElement(
    client,
    `document.querySelector('button[aria-label="Quick actions"]')`,
  );

  await waitFor(client, () =>
    evaluate(
      client,
      `Boolean(document.querySelector('input[aria-label="Quick actions"]'))`,
    ),
  );
}

async function clickElement(client, targetExpression) {
  const point = await evaluate(
    client,
    `(() => {
      const target = ${targetExpression};
      if (!(target instanceof Element)) return null;
      const rect = target.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
    })()`,
  );

  assert.ok(point, "expected clickable target");

  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "left",
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}
