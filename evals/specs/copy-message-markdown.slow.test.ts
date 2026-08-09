import { createServer } from "node:http";
import { expect, onTestFinished } from "vitest";
import { clickButton, control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/fraimz";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const providerId = "copy-message-markdown-mock";
const modelId = "copy-message-markdown-model";
const selectedText = "selected rich phrase";
const markdownReply = `# Clipboard proof

Rendered **${selectedText}** with \`inline code\`.

- first item
- second item`;
const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "assistant messages copy rendered selections and exact raw Markdown"
  : "copy message Markdown skipped — needs: set OPENWORK_EVAL_APP_SPECS=1";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rightClick(app: Surface, selector: string): Promise<void> {
  const rawPoint = await evalIn(app, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!(target instanceof HTMLElement)) return "";
    target.scrollIntoView({ block: "center" });
    const rect = target.getBoundingClientRect();
    return JSON.stringify({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  })()`);
  if (typeof rawPoint !== "string") throw new Error(`Right-click target did not return coordinates: ${String(rawPoint)}`);
  const point: unknown = JSON.parse(rawPoint);
  if (!isRecord(point) || typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error(`Right-click target did not return valid coordinates: ${rawPoint}`);
  }
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await app.client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "right", clickCount: 1 });
  await app.client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "right", clickCount: 1 });
}

async function waitForClipboard(app: Surface, expected: string): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await evalIn(app, "navigator.clipboard.readText()", { awaitPromise: true });
    last = typeof value === "string" ? value : String(value);
    if (last === expected) return;
    await sleep(100);
  }
  throw new Error(`Clipboard did not equal ${JSON.stringify(expected)}; last value was ${JSON.stringify(last)}`);
}

test.skipIf(!appSpecsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }

    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      request.resume();
      request.on("end", () => {
        const chunks = [
          { id: "chatcmpl-copy-markdown", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-copy-markdown", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: markdownReply }, finish_reason: null }] },
          { id: "chatcmpl-copy-markdown", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.end("data: [DONE]\n\n");
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  });
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  await using app = await desktop({
    name: "copy-message-markdown",
    mode: process.env.OPENWORK_EVAL_CDP_URL?.trim() ? "attach" : "spawn",
  });
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-copy-message-markdown-${Date.now()}`,
  });
  const configured = await evalIn(app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 500);
      return "ok";
    };
    const workspaceId = ${JSON.stringify(workspace.workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({
        opencode: {
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Copy message Markdown mock",
              options: { baseURL: ${JSON.stringify(baseUrl)}, apiKey: "sk-copy-message-markdown" },
              models: { [${JSON.stringify(modelId)}]: { name: "Copy message Markdown model" } },
            },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok") return reloaded;
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: ${JSON.stringify(providerId)}, modelID: ${JSON.stringify(modelId)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${providerId}/${modelId}`)});
    localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(configured).toBe("ok");
  if (process.env.OPENWORK_EVAL_CDP_URL?.trim()) {
    await evalIn(app, "location.reload(); true");
    await waitFor(app, "Boolean(window.__openworkControl)", {
      timeoutMs: 30_000,
      label: "attached app reloaded with mock provider preferences",
    });
  }

  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "new task action enabled",
  });
  await control(app, "session.create_task");
  await waitFor(app, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`, {
    timeoutMs: 30_000,
    label: "composer editor ready",
  });
  const prompt = "Show the deterministic Markdown reply.";
  const focused = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  })()`);
  expect(focused).toBe(true);
  await app.client.send("Input.insertText", { text: prompt });
  await waitFor(app, `document.querySelector('[contenteditable="true"][data-lexical-editor="true"]')?.innerText === ${JSON.stringify(prompt)}`, {
    timeoutMs: 10_000,
    label: "prompt entered in composer",
  });
  await clickButton(app, "Run task", { timeoutMs: 30_000 });

  await waitFor(app, `(() => {
    const message = document.querySelector('[data-message-role="assistant"]');
    return message?.querySelector("h1")?.textContent === "Clipboard proof"
      && message.querySelector("strong")?.textContent === ${JSON.stringify(selectedText)}
      && message.querySelector("code")?.textContent === "inline code"
      && message.querySelectorAll("li").length === 2;
  })()`, { timeoutMs: 120_000, label: "rich assistant Markdown rendered" });
  evidence.fact(
    "The assistant Markdown renders as rich text while remaining selectable",
    "Observed an h1, strong text, inline code, and two list items in the assistant message.",
    true,
  );

  const opened = await evalIn(app, `(() => {
    const message = document.querySelector('[data-message-role="assistant"]');
    const strong = message?.querySelector("strong");
    if (!message || !strong) return false;
    const range = document.createRange();
    range.selectNodeContents(strong);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return selection?.toString() === ${JSON.stringify(selectedText)};
  })()`);
  expect(opened).toBe(true);
  await rightClick(app, '[data-message-role="assistant"] strong');
  await waitFor(app, `(() => {
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim());
    return labels.includes("Copy") && labels.includes("Copy as Markdown")
      && window.getSelection()?.toString() === ${JSON.stringify(selectedText)};
  })()`, { timeoutMs: 10_000, label: "assistant context menu actions and preserved selection" });

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "A rich Markdown assistant reply is visible with a context menu containing Copy and Copy as Markdown",
      "The reply visibly includes a heading, bold text, inline code, and a list",
      "No error dialog or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  const copiedSelection = await evalIn(app, `(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent?.trim() === "Copy");
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(copiedSelection).toBe(true);
  await waitForClipboard(app, selectedText);
  evidence.fact(
    "Copy writes the active rendered-text selection",
    `Clipboard exactly matched ${JSON.stringify(selectedText)} rather than the whole raw message.`,
    true,
  );

  await waitFor(app, `!document.querySelector('[role="menuitem"]')`, {
    timeoutMs: 10_000,
    label: "context menu closed after Copy",
  });
  await rightClick(app, '[data-message-role="assistant"] strong');
  await waitFor(app, `[...document.querySelectorAll('[role="menuitem"]')]
    .some((entry) => entry.textContent?.trim() === "Copy as Markdown")`, {
    timeoutMs: 10_000,
    label: "Copy as Markdown action reopened",
  });
  const copiedMarkdown = await evalIn(app, `(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((entry) => entry.textContent?.trim() === "Copy as Markdown");
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`);
  expect(copiedMarkdown).toBe(true);
  await waitForClipboard(app, markdownReply);
  evidence.fact(
    "Copy as Markdown writes the exact raw assistant source",
    `Clipboard exactly preserved heading, bold, inline-code, and list syntax: ${JSON.stringify(markdownReply)}`,
    true,
  );
});
