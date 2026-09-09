import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, onTestFinished } from "vitest";
import { browserScript, connect, coworker, debuggerUrlFor, evalIn, evaluate, listTargets, needs, test, waitFor, waitForText } from "@openwork/testkit";
import { buildStandardAppHtml } from "../worlds/coworker.ts";

const mcpServerName = "chapter-notes";
const toolName = "open_team_pulse";
const resourceUri = "ui://openwork/coworker/team-pulse.html";
const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker mounts a standard App in isolated hosts and prepares work without executing it"
  : "Open Coworker MCP Apps journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

async function clickButtonContaining(app: Awaited<ReturnType<typeof coworker>>, text: string): Promise<void> {
  await waitFor(app, browserScript((text) => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").includes(text) && !candidate.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  }, [text]), { timeoutMs: 60_000, label: `button containing ${json(text)}` });
}

async function clickTestId(app: Awaited<ReturnType<typeof coworker>>, testId: string): Promise<void> {
  await waitFor(app, browserScript((selector) => {
    const element = document.querySelector(selector);
    if (!(element instanceof HTMLElement)) return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    element.click();
    return true;
  }, [`[data-testid="${testId}"]`]), { timeoutMs: 30_000, label: `click ${testId}` });
}

/** The Apps & tools root is the first level of Coworker settings. */
const APPS_TOOLS_ROUTE = "settings/apps-tools";

/**
 * Bring the right panel to the Apps & tools root from whatever state it is in: folded, on another
 * view (Escape folds it), on the Coworker settings rows (their first row opens it), or deeper inside.
 */
async function openAppsAndTools(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, browserScript((appsToolsRoute) => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    const route = document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") ?? "";
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "settings") {
      // The view remembers its last level for the session; the journeys start each visit at the root.
      if (route === appsToolsRoute) return true;
      if (panel.dataset.depth === "0") document.querySelector<HTMLElement>('[data-testid="settings-row-apps-tools"]')?.click();
      else document.querySelector<HTMLElement>('[data-testid="panel-back"]')?.click();
      return false;
    }
    if (panel.dataset.collapsed === "true") {
      document.querySelector<HTMLElement>('[data-testid="context-rail-settings"]')?.click();
      return false;
    }
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }, [APPS_TOOLS_ROUTE]), { timeoutMs: 60_000, label: "Apps & tools root" });
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
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

const builtAppHtml = await buildStandardAppHtml({
  reactSource: `export default function CoworkerApp({ data }) {
    return <main><p className="eyebrow">TEAM PULSE</p><h2>{data.title}</h2><p>{data.status}</p></main>
  }`,
  cssSource: "body{margin:0;padding:18px;color:#f7f8fa;background:#0c1018;font-family:ui-sans-serif,system-ui,sans-serif}main{border:1px solid #283142;border-radius:14px;padding:18px;background:#111722}.eyebrow{margin:0 0 8px;color:#8994a8;font-size:10px;letter-spacing:.16em}h2{margin:0 0 7px;font-size:18px}p{margin:0;color:#a8b1c1;font-size:13px}",
  outputSchema: {
    type: "object",
    properties: { title: { type: "string" }, status: { type: "string" } },
    required: ["title", "status"],
  },
  title: "Team pulse",
  description: "Deterministic Open Coworker MCP App fixture.",
});

function rpcResponse(message: Record<string, unknown>): Record<string, unknown> {
  if (message.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: "open-coworker-mcp-apps", version: "1.0.0" },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: toolName,
          title: "Team pulse",
          description: "A calm interactive summary of current team activity.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, destructiveHint: false },
          _meta: { ui: { resourceUri } },
        }],
      },
    };
  }
  if (message.method === "tools/call") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{ type: "text", text: "Team pulse: Ready for review" }],
        structuredContent: {
          schemaVersion: "1",
          artifact: { title: "Team pulse", description: "Current team activity." },
          data: { title: "Team pulse", status: "Ready for review" },
        },
        _meta: { receipt: "coworker-mcp-app-proof" },
      },
    };
  }
  if (message.method === "resources/read") {
    return {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        contents: [{
          uri: resourceUri,
          mimeType: "text/html;profile=mcp-app",
          blob: Buffer.from(builtAppHtml, "utf8").toString("base64"),
          _meta: {
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
            },
          },
        }],
      },
    };
  }
  return { jsonrpc: "2.0", id: message.id, result: {} };
}

async function waitForMountedApp(app: Awaited<ReturnType<typeof coworker>>, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const initialized = await evalIn(app, browserScript((selector) => document.querySelector(selector)?.getAttribute("data-mcp-app-ready") === "true", [`[data-mcp-app-resource="${resourceUri}"]`]));
    if (initialized === true) return true;

    // Depending on Electron's site-isolation mode, a cross-origin App frame
    // may stay inside the page target instead of appearing in /json/list.
    // The accessibility tree spans those frames and proves visible content.
    const accessibility = await app.client.send("Accessibility.getFullAXTree").catch(() => null);
    const visibleText = JSON.stringify(accessibility);
    if (visibleText.includes("Team pulse") && visibleText.includes("Ready for review")) return true;

    const targets = await listTargets(app.handle.cdpUrl);
    const sandbox = targets.find((target) => target.type === "iframe"
      && target.url.includes("/mcp-apps/sandbox.html")
      && target.webSocketDebuggerUrl);
    if (sandbox) {
      const client = await connect(debuggerUrlFor(app.handle.cdpUrl, sandbox));
      try {
        const mounted = await evaluate(client, () => {
          const text = document.querySelector("iframe")?.contentDocument?.body?.innerText ?? "";
          return text.includes("Team pulse") && text.includes("Ready for review");
        });
        if (mounted === true) return true;
      } finally {
        client.close();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

test.skipIf(!enabled)(title, { timeout: 240_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  let toolCalls = 0;
  let resourceReads = 0;
  const fixture = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/mcp") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (request.method === "GET") {
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      const raw = await readBody(request);
      const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const replies: Record<string, unknown>[] = [];
      for (const candidate of messages) {
        if (!isRecord(candidate)) continue;
        if (candidate.method === "tools/call" && field(field(candidate, "params"), "name") === toolName) toolCalls += 1;
        if (candidate.method === "resources/read") resourceReads += 1;
        if (candidate.id !== undefined) replies.push(rpcResponse(candidate));
      }
      if (replies.length === 0) {
        response.writeHead(202, { "access-control-allow-origin": "*" });
        response.end();
        return;
      }
      sendJson(response, 200, Array.isArray(parsed) ? replies : replies[0]);
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) });
      else response.destroy(error instanceof Error ? error : undefined);
    });
  });
  await withTimeout(new Promise<void>((resolve, reject) => {
    fixture.once("error", reject);
    fixture.listen(0, "127.0.0.1", resolve);
  }), 10_000, "Coworker MCP fixture to listen");
  onTestFinished(async () => {
    await withTimeout(
      new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve())),
      10_000,
      "Coworker MCP fixture to close",
    );
  });
  const address = fixture.address();
  if (!address || typeof address === "string") throw new Error("Coworker MCP fixture did not bind a port.");
  const mcpUrl = `http://127.0.0.1:${address.port}/mcp`;

  await using app = await coworker({ name: "mcp-apps-store" });
  await waitFor(app, () => (document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker"), {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const prepared = await evalIn(app, browserScript(async (mcpServerName, mcpUrl) => {
    const created = await window.__COWORKER__.invoke("coworkers.create", {
      name: "Scout",
      role: "Operations partner",
      mission: "Use the right connected capability for each task.",
      avatarColor: "blue",
      avatarGlasses: "round",
    });
    if (!created.ok) return created;
    const runtime = await window.__COWORKER__.invoke("runtime.info");
    if (!runtime.ok) return runtime;
    if (typeof created.result !== "object" || created.result === null || !("workspaceId" in created.result) || typeof created.result.workspaceId !== "string") throw new Error("Coworker workspace unavailable");
    if (typeof runtime.result !== "object" || runtime.result === null || !("serverUrl" in runtime.result) || typeof runtime.result.serverUrl !== "string" || !("ownerToken" in runtime.result) || typeof runtime.result.ownerToken !== "string") throw new Error("Runtime unavailable");
    const workspaceId = created.result.workspaceId;
    const response = await fetch(runtime.result.serverUrl + "/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + runtime.result.ownerToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        opencode: {
          mcp: {
            [mcpServerName]: {
              type: "remote",
              url: mcpUrl,
              enabled: true,
              oauth: false,
            },
          },
        },
      }),
    });
    return { ok: response.ok, status: response.status, body: await response.text(), workspaceId };
  }, [mcpServerName, mcpUrl]), { awaitPromise: true, timeoutMs: 120_000 });
  expect(prepared).toMatchObject({ ok: true, workspaceId: expect.any(String) });

  await evalIn(app, () => { location.reload(); return true; });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-rail"]')), { timeoutMs: 120_000, label: "team rail" });
  await openAppsAndTools(app);

  // Discover the local server's advertised App, then open it from the catalog.
  await clickTestId(app, "apps-tools-row-local");
  await waitFor(app, browserScript((mcpServerName) => {
    const row = [...document.querySelectorAll('[data-testid="coworker-mcp-connection"]')].find((candidate) => (candidate.textContent ?? "").includes(mcpServerName));
    if (!(row instanceof HTMLElement) || !(row.textContent ?? "").includes("Connected")) return false;
    row.click();
    return true;
  }, [mcpServerName]), { timeoutMs: 60_000, label: "open the connected chapter-notes tool" });
  await waitFor(app, () => document.querySelector('[data-testid="apps-tools-offers"]')?.textContent?.includes("Team pulse"), { timeoutMs: 60_000, label: "advertised Team pulse App" });
  await openAppsAndTools(app);
  await clickTestId(app, "apps-tools-row-apps");
  await clickButtonContaining(app, "Team pulse");
  await waitForText(app, "Read only", { timeoutMs: 30_000 });
  await clickTestId(app, "apps-tools-open-app");
  await waitFor(app, browserScript((selector) => Boolean(document.querySelector(selector)), [`[data-testid="context-panel"] [data-mcp-app-resource="${resourceUri}"] iframe`]), {
    timeoutMs: 60_000,
    label: "Coworker MCP App sandbox iframe",
  });
  const hostClaim = await evalIn(app, browserScript((selector) => {
    const frame = document.querySelector(selector);
    if (!(frame instanceof HTMLIFrameElement) || !frame.src) return false;
    const flags = new Set((frame.getAttribute("sandbox") || "").split(/\s+/).filter(Boolean));
    return flags.has("allow-scripts")
      && flags.has("allow-same-origin")
      && frame.getAttribute("referrerpolicy") === "no-referrer"
      && new URL(frame.src).origin !== window.location.origin
      && !frame.hasAttribute("srcdoc");
  }, [`[data-mcp-app-resource="${resourceUri}"] iframe`]));
  expect(hostClaim).toBe(true);
  const mountedApp = await waitForMountedApp(app);
  expect(mountedApp).toBe(true);
  expect(toolCalls).toBe(1);
  expect(resourceReads).toBeGreaterThanOrEqual(1);
  evidence.recordAssertionEvidence(
    "A catalog App executes through OpenWork and mounts through the standard MCP Apps bridge",
    `Open produced one tools/call, ${resourceReads} resources/read request(s), and a mounted App in a different-origin sandbox with no-referrer and no srcdoc.`,
    hostClaim === true && toolCalls === 1 && resourceReads >= 1,
  );

  // Exercise the alternate host once, without a responsive-layout matrix.
  await app.client.send("Emulation.setDeviceMetricsOverride", { width: 1_700, height: 900, deviceScaleFactor: 1, mobile: false });
  await clickTestId(app, "apps-tools-open-beside");
  await waitFor(app, () => {
    const button = document.querySelector('[data-testid="beside-column"] [data-testid="apps-tools-open-app"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  }, { timeoutMs: 30_000, label: "Open inside the beside column" });
  await waitFor(app, browserScript((selector) => document.querySelector(selector)?.getAttribute("data-mcp-app-ready") === "true", [`[data-testid="beside-column"] [data-mcp-app-resource="${resourceUri}"]`]), {
    timeoutMs: 60_000,
    label: "App mounted in the beside column",
  });
  expect(toolCalls).toBe(2);
  evidence.recordAssertionEvidence(
    "Open beside mounts the App in the alternate host",
    "Opening Team pulse in the beside column mounted the App through a second tools/call.",
    true,
  );
  await clickTestId(app, "beside-close");
  await app.client.send("Emulation.clearDeviceMetricsOverride", {});

  // Ask prepares a discussion draft, not another App execution.
  await openAppsAndTools(app);
  await clickTestId(app, "apps-tools-row-apps");
  await clickButtonContaining(app, "Team pulse");
  const callsBeforeDraft = toolCalls;
  await clickTestId(app, "apps-tools-ask");
  await waitFor(app, () => {
    const composer = document.querySelector('textarea[aria-label="Message Scout"]');
    return composer instanceof HTMLTextAreaElement
      && composer.value.includes("Team pulse");
  }, { timeoutMs: 30_000, label: "App-seeded discussion draft" });
  expect(toolCalls).toBe(callsBeforeDraft);
  expect(await evalIn(app, () => document.querySelectorAll('[data-message-role="user"]').length)).toBe(0);
  evidence.recordAssertionEvidence(
    "An App prepares work without sending it",
    "Ask Scout filled the discussion composer with Team pulse. No user message appeared and the tool-call witness stayed at the two explicit App launches.",
    true,
  );
});
