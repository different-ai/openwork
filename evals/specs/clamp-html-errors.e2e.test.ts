import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, onTestFinished } from "vitest";
import { clickButton, control, createAndSelectWorkspace, evalIn, waitFor } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const providerId = "clamp-html-errors-mock";
const modelId = "clamp-html-errors-model";
const mcpToolName = "explode_html";
const closingReply = "The session recovered after the failed upstream call.";
const htmlSummary = "Upstream returned an HTML error page (502 Bad Gateway)";
const htmlError = `<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1>${"Z".repeat(1_024 * 1_024)}</body></html>`;
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "large HTML tool errors are summarized once without breaking the session"
  : "large HTML tool errors skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function rpcResponse(message: Record<string, unknown>): Record<string, unknown> {
  const method = typeof message.method === "string" ? message.method : "";
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "html-error-mcp", version: "1.0.0" },
      },
    };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: mcpToolName,
          title: "HTML upstream failure",
          description: "Returns a deterministic upstream HTML error page.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      },
    };
  }
  if (method === "tools/call") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32_000, message: htmlError },
    };
  }
  return { jsonrpc: "2.0", id: message.id, result: {} };
}

function rpcDelayMs(message: Record<string, unknown>): number {
  // Let the tool execution span a few seconds like a real upstream call, so
  // its error part lands while the renderer's event stream is connected
  // instead of inside the post-reload gap.
  return message.method === "tools/call" ? 4_000 : 0;
}

function providerToolName(payload: Record<string, unknown>): string | null {
  const tools = payload.tools;
  if (!Array.isArray(tools)) return null;
  for (const tool of tools) {
    const fn = recordValue(tool, "function");
    const name = recordValue(fn, "name");
    if (typeof name === "string" && name.endsWith(mcpToolName)) return name;
  }
  return null;
}

function hasToolResult(payload: Record<string, unknown>): boolean {
  const messages = payload.messages;
  return Array.isArray(messages)
    && messages.some((message) => recordValue(message, "role") === "tool");
}

function streamChunk(delta: Record<string, unknown>, finishReason: string | null = null): Record<string, unknown> {
  return {
    id: "chatcmpl-clamp-html-errors",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sendStream(response: ServerResponse, chunks: Record<string, unknown>[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // Pace the stream like a real model. An instantly-finished turn can complete
  // before the renderer's engine event stream (re)connects, leaving the UI
  // permanently stale on this turn.
  let delay = 400;
  for (const chunk of chunks) {
    setTimeout(() => response.write(`data: ${JSON.stringify(chunk)}\n\n`), delay);
    delay += 400;
  }
  setTimeout(() => response.end("data: [DONE]\n\n"), delay);
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  let toolsListed = 0;
  let toolCalls = 0;
  let closingRounds = 0;
  const mock = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] });
        return;
      }
      if (url.pathname === "/mcp") {
        if (request.method === "GET") {
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const raw = await readBody(request);
        const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const replies: Record<string, unknown>[] = [];
        let delayMs = 0;
        for (const candidate of messages) {
          if (!isRecord(candidate)) continue;
          if (candidate.method === "tools/list") toolsListed += 1;
          if (candidate.method === "tools/call") toolCalls += 1;
          delayMs = Math.max(delayMs, rpcDelayMs(candidate));
          if (candidate.id !== undefined) replies.push(rpcResponse(candidate));
        }
        if (replies.length === 0) {
          response.writeHead(202, { "access-control-allow-origin": "*" });
          response.end();
          return;
        }
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
        return;
      }
      if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        const raw = await readBody(request);
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) throw new Error("Mock provider received a non-object request.");
        // The engine's session-title agent hits the same provider; keep it away
        // from the tool-call script so counters stay deterministic. Utility
        // requests carry no tools array; real agent turns always do.
        const requestTools = parsed.tools;
        if (!Array.isArray(requestTools) || requestTools.length === 0) {
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({ content: "Session title" }),
            streamChunk({}, "stop"),
          ]);
          return;
        }
        if (hasToolResult(parsed)) {
          closingRounds += 1;
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({ content: closingReply }),
            streamChunk({}, "stop"),
          ]);
          return;
        }
        const toolName = providerToolName(parsed);
        if (!toolName) {
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({ content: "The deterministic MCP error tool was unavailable." }),
            streamChunk({}, "stop"),
          ]);
          return;
        }
        sendStream(response, [
          streamChunk({ role: "assistant" }),
          streamChunk({
            tool_calls: [{
              index: 0,
              id: "call_html_error",
              type: "function",
              function: { name: toolName, arguments: "{}" },
            }],
          }),
          streamChunk({}, "tool_calls"),
        ]);
        return;
      }
      sendJson(response, 404, { error: { message: "not found" } });
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await withTimeout(new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", resolve);
  }), 10_000, "HTML error mock to listen");
  onTestFinished(async () => {
    await withTimeout(
      new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve())),
      10_000,
      "HTML error mock to close",
    );
  });
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("HTML error mock did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  await using app = await desktop({
    name: "clamp-html-errors",
    mode: process.env.OPENWORK_EVAL_CDP_URL?.trim() ? "attach" : "spawn",
    // Provider keys in the runner env (e.g. via infisical) would make the
    // engine register real providers and out-default the deterministic mock.
    env: {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      OPENWORK_API_KEY: "",
      OPENWORK_INFERENCE_BASE_URL: "",
    },
  });
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-clamp-html-errors-${Date.now()}`,
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
              name: "Clamp HTML errors mock",
              options: { baseURL: ${JSON.stringify(`${baseUrl}/v1`)}, apiKey: "sk-clamp-html-errors" },
              models: {
                [${JSON.stringify(modelId)}]: { name: "Clamp HTML errors model", tool_call: true },
              },
            },
          },
          mcp: {
            "html-error": { type: "remote", url: ${JSON.stringify(`${baseUrl}/mcp`)}, enabled: true, oauth: false },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    // A slow dispose reports 504 opencode_reload_timeout while the reload
    // keeps going; readiness is owned by the polling below.
    if (reloaded !== "ok" && !reloaded.includes("opencode_reload_timeout")) return reloaded;
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
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(configured).toBe("ok");
  await expect.poll(() => toolsListed, { timeout: 30_000, interval: 100 }).toBeGreaterThan(0);

  // Preferences hydrate at boot, so reload unconditionally: without this the
  // engine's built-in free model stays the default and out-competes the mock.
  await evalIn(app, "location.reload(); true");
  await waitFor(app, "Boolean(window.__openworkControl)", {
    timeoutMs: 30_000,
    label: "app reloaded with the HTML error mock preferences",
  });
  // The engine restarts after /engine/reload; sending into that window races
  // the swap and strands the run behind an "OpenCode unavailable" banner.
  const engineReady = await evalIn(app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const deadline = Date.now() + 60_000;
    let last = "";
    while (Date.now() < deadline) {
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspace.workspaceId)}) + "/opencode/session", {
          headers: { Authorization: "Bearer " + token },
        });
        if (response.ok) return "ready";
        last = "HTTP " + response.status;
      } catch (error) {
        last = String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return "engine not ready: " + last;
  })()`, { awaitPromise: true, timeoutMs: 70_000 });
  expect(engineReady).toBe("ready");
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "new task action enabled",
  });
  await control(app, "session.create_task");
  await waitFor(app, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`, {
    timeoutMs: 30_000,
    label: "composer editor ready",
  });
  const prompt = "Call the HTML upstream failure tool once, then explain that the session recovered.";
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
    label: "task entered in composer",
  });
  // A click can land while the composer is still wiring up; retry until the
  // send actually navigates into a session.
  let sent = false;
  for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
    await clickButton(app, "Run task", { timeoutMs: 30_000 });
    try {
      await waitFor(app, `window.location.hash.includes("/session/ses_")`, {
        timeoutMs: 10_000,
        label: "task session created",
      });
      sent = true;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }

  await waitFor(app, `(() => {
    const transcript = [...document.querySelectorAll('[data-message-role]')]
      .map((message) => message.textContent ?? "").join(" | ");
    return transcript.includes(${JSON.stringify(closingReply)});
  })()`, { timeoutMs: 120_000, label: "closing assistant reply" });
  await waitFor(app, `(() => {
    const failure = [...document.querySelectorAll('[data-capability-call]')]
      .find((row) => (row.textContent ?? "").includes("failed"));
    return Boolean(failure);
  })()`, { timeoutMs: 60_000, label: "failed tool row rendered" });
  expect(toolCalls).toBe(1);
  expect(closingRounds).toBe(1);

  const expandedFailure = await evalIn(app, `(() => {
    const row = [...document.querySelectorAll('[data-capability-call]')]
      .find((candidate) => (candidate.textContent ?? "").includes("failed"));
    const trigger = row ? [...row.querySelectorAll("button")]
      .find((button) => (button.getAttribute("aria-label") ?? "").includes("Show what to do next")) : null;
    if (!(trigger instanceof HTMLElement)) return false;
    trigger.click();
    return true;
  })()`);
  expect(expandedFailure).toBe(true);
  await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-capability-call]')]
      .find((candidate) => (candidate.textContent ?? "").includes("failed"));
    return (row?.innerText ?? "").includes(${JSON.stringify(htmlSummary)});
  })()`, { timeoutMs: 10_000, label: "human HTML error summary visible" });

  const transcriptClaim = await evalIn(app, `(() => {
    const rows = [...document.querySelectorAll('[data-capability-call]')];
    const failureVisible = rows.some((row) => (row.innerText ?? "").includes("failed"));
    const transcript = [...document.querySelectorAll('[data-message-role]')]
      .map((message) => message.innerText ?? "").join(" | ");
    const lower = transcript.toLowerCase();
    return failureVisible && transcript.includes(${JSON.stringify(htmlSummary)})
      && !lower.includes("<!doctype") && !lower.includes("<html");
  })()`);
  expect(transcriptClaim).toBe(true);
  evidence.recordAssertionEvidence(
    "The failed tool row shows a human HTML-error summary instead of raw markup",
    "The rendered transcript contained the 502 HTML-page summary and contained neither <!DOCTYPE nor <html.",
    transcriptClaim === true,
  );

  const expandedTechnicalDetails = await evalIn(app, `(() => {
    const row = [...document.querySelectorAll('[data-capability-call]')]
      .find((candidate) => (candidate.textContent ?? "").includes("failed"));
    const toggle = row ? [...row.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim().startsWith("Technical details")) : null;
    if (!(toggle instanceof HTMLElement)) return false;
    toggle.click();
    return true;
  })()`);
  expect(expandedTechnicalDetails).toBe(true);
  await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-capability-call]')]
      .find((candidate) => (candidate.textContent ?? "").includes("failed"));
    return [...(row?.querySelectorAll("pre") ?? [])]
      .some((preview) => (preview.textContent ?? "").includes("[Error text truncated; original size:"));
  })()`, { timeoutMs: 10_000, label: "bounded technical error preview visible" });

  const detailsClaim = await evalIn(app, `(() => {
    const row = [...document.querySelectorAll('[data-capability-call]')]
      .find((candidate) => (candidate.textContent ?? "").includes("failed"));
    const preview = [...(row?.querySelectorAll("pre") ?? [])]
      .map((node) => node.textContent ?? "")
      .find((text) => text.includes("[Error text truncated; original size:")) ?? "";
    return preview.length > 0 && preview.length < 6000
      && /\\[Error text truncated; original size: [\\d,]+ characters\\]/.test(preview)
      && !preview.toLowerCase().includes("<!doctype")
      && !preview.toLowerCase().includes("<html")
      && !preview.includes("Z".repeat(1024));
  })()`);
  expect(detailsClaim).toBe(true);
  evidence.recordAssertionEvidence(
    "Expanded technical details keep the error preview bounded and name the hidden original size",
    "The error preview was under 6,000 characters, included the original-size truncation marker, and omitted raw HTML and the megabyte filler.",
    detailsClaim === true,
  );

  const usableClaim = await evalIn(app, `(() => {
    const transcript = [...document.querySelectorAll('[data-message-role]')]
      .map((message) => message.innerText ?? "").join(" | ");
    const page = document.body.innerText.toLowerCase();
    return transcript.includes(${JSON.stringify(closingReply)})
      && !page.includes("tool step unavailable")
      && !page.includes("failed to render");
  })()`);
  expect(usableClaim).toBe(true);
  evidence.recordAssertionEvidence(
    "The session remains usable after the oversized tool failure",
    "The second-round closing assistant reply rendered and no tool error-boundary fallback or failed-to-render message appeared.",
    usableClaim === true,
  );

  // Streaming rerenders can re-collapse the row after the DOM assertions, so
  // put the expanded failure state back on screen before the visual take.
  const reExpanded = await evalIn(app, `(() => {
    const row = [...document.querySelectorAll('[data-capability-call]')]
      .find((candidate) => (candidate.textContent ?? "").includes("failed"));
    if (!(row instanceof HTMLElement)) return "missing row";
    const failureToggle = [...row.querySelectorAll("button")]
      .find((button) => (button.getAttribute("aria-label") ?? "").includes("failure details")
        || (button.getAttribute("aria-label") ?? "").includes("Show what to do next"));
    if (failureToggle instanceof HTMLElement && failureToggle.getAttribute("aria-expanded") !== "true") failureToggle.click();
    return "ok";
  })()`);
  expect(reExpanded).toBe("ok");
  await evalIn(app, `(() => {
    const row = [...document.querySelectorAll('[data-capability-call]')]
      .find((candidate) => (candidate.textContent ?? "").includes("failed"));
    const details = row ? [...row.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim().startsWith("Technical details")) : null;
    if (details instanceof HTMLElement && details.getAttribute("aria-expanded") !== "true") details.click();
    row?.scrollIntoView({ block: "center" });
    return true;
  })()`);
  await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-capability-call]')]
      .find((candidate) => (candidate.textContent ?? "").includes("failed"));
    return [...(row?.querySelectorAll("pre") ?? [])]
      .some((preview) => (preview.textContent ?? "").includes("[Error text truncated; original size:"));
  })()`, { timeoutMs: 10_000, label: "expanded failure state back on screen for the visual take" });
  await evalIn(app, `(() => {
    const row = [...document.querySelectorAll('[data-capability-call]')]
      .find((candidate) => (candidate.textContent ?? "").includes("failed"));
    const marker = [...(row?.querySelectorAll("pre") ?? [])]
      .find((preview) => (preview.textContent ?? "").includes("[Error text truncated; original size:"));
    marker?.scrollIntoView({ block: "center" });
    return true;
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const shot = await screenshot(app);
  const seen = await validate(shot, [
    "A failed tool-call row is expanded with a human-readable 502 HTML error-page summary",
    "Technical details are expanded and show a truncation marker rather than a full raw HTML page",
    `The assistant closing message says: ${closingReply}`,
    "No crash, failed-to-render fallback, or wall of raw HTML markup is visible",
  ]);
  expect(seen.ok, seen.why).toBe(true);
});
