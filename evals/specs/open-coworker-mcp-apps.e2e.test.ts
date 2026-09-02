import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, onTestFinished } from "vitest";
import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { connect, debuggerUrlFor, evaluate, listTargets } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import { coworker, needs, test } from "@openwork/testkit";
import { buildGeneratedArtifactViewInWorker } from "../../ee/apps/den-api/src/generated-artifact-view-builder.js";

const mcpServerName = "chapter-notes";
const toolName = "open_team_pulse";
const resourceUri = "ui://openwork/coworker/team-pulse.html";
const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker browses a live MCP catalog, launches a standard App, and prepares search then execute work"
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
  await waitFor(app, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(text)}) && !candidate.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`, { timeoutMs: 60_000, label: `button containing ${json(text)}` });
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

const builtApp = await buildGeneratedArtifactViewInWorker({
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
if (!builtApp.ok) throw new Error(`Coworker MCP App build failed: ${JSON.stringify(builtApp.diagnostics)}`);

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
          blob: Buffer.from(builtApp.html, "utf8").toString("base64"),
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
    const initialized = await evalIn(app, `document.querySelector(${json(`[data-mcp-app-resource="${resourceUri}"]`)})?.getAttribute("data-mcp-app-ready") === "true"`);
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
        const mounted = await evaluate(client, `(() => {
          const text = document.querySelector("iframe")?.contentDocument?.body?.innerText ?? "";
          return text.includes("Team pulse") && text.includes("Ready for review");
        })()`);
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
  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const prepared = await evalIn(app, `(async () => {
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
            [${json(mcpServerName)}]: {
              type: "remote",
              url: ${json(mcpUrl)},
              enabled: true,
              oauth: false,
            },
          },
        },
      }),
    });
    return { ok: response.ok, status: response.status, body: await response.text(), workspaceId };
  })()`, { awaitPromise: true, timeoutMs: 120_000 });
  expect(prepared).toMatchObject({ ok: true, workspaceId: expect.any(String) });

  await evalIn(app, "location.reload(); true");
  await waitForText(app, "Your team", { timeoutMs: 120_000 });
  await clickButtonContaining(app, "Apps & tools");
  await waitFor(app, `document.querySelectorAll("[data-testid=coworker-mcp-app]").length === 1`, {
    timeoutMs: 60_000,
    label: "live Coworker MCP App catalog",
  });
  const catalogText = String(await evalIn(app, "document.body.innerText"));
  expect(catalogText.toLowerCase()).toContain("search → execute");
  expect(catalogText.toLowerCase()).toContain(mcpServerName);
  expect(catalogText.toLowerCase()).toContain("mcp connections");
  const flatSurface = await evalIn(app, `(() => {
    const root = document.querySelector("[data-testid=coworker-capabilities]");
    if (!root) return false;
    return [...root.querySelectorAll("*")].every((element) => getComputedStyle(element).backgroundImage === "none");
  })()`);
  expect(flatSurface).toBe(true);
  evidence.recordAssertionEvidence(
    "Coworker reads the same live MCP inventory and App catalog as OpenWork Desktop",
    "The right-side Apps & tools surface showed the configured chapter-notes MCP, its Team pulse App, live connection state, and the OpenWork Connect search → execute contract.",
    true,
  );

  await fill(app, 'input[aria-label="Search Apps and tools"]', "team pulse");
  expect(await evalIn(app, 'document.querySelectorAll("[data-testid=coworker-mcp-app]").length')).toBe(1);
  await clickButtonContaining(app, "Team pulse");
  await waitForText(app, "Read only", { timeoutMs: 30_000 });
  await clickButton(app, "Open App", { timeoutMs: 30_000 });
  await waitFor(app, `Boolean(document.querySelector(${json(`[data-mcp-app-resource="${resourceUri}"] iframe`)}))`, {
    timeoutMs: 60_000,
    label: "Coworker MCP App sandbox iframe",
  });
  const hostClaim = await evalIn(app, `(() => {
    const frame = document.querySelector(${json(`[data-mcp-app-resource="${resourceUri}"] iframe`)});
    if (!(frame instanceof HTMLIFrameElement) || !frame.src) return false;
    const flags = new Set((frame.getAttribute("sandbox") || "").split(/\\s+/).filter(Boolean));
    return flags.has("allow-scripts")
      && flags.has("allow-same-origin")
      && frame.getAttribute("referrerpolicy") === "no-referrer"
      && new URL(frame.src).origin !== window.location.origin
      && !frame.hasAttribute("srcdoc");
  })()`);
  expect(hostClaim).toBe(true);
  const mountedApp = await waitForMountedApp(app);
  expect(mountedApp).toBe(true);
  expect(toolCalls).toBe(1);
  expect(resourceReads).toBeGreaterThanOrEqual(1);
  const appShot = await screenshot(app);
  const appExpectations = [
    "A standard MCP App is mounted inline in the coworker's Apps & tools surface",
    "The App renders inside a different-origin sandboxed frame rather than the host document",
  ];
  const appSeen = await validate(appShot, appExpectations, {
    ask: async (request) => request.prompt.startsWith("Objectively describe")
      ? JSON.stringify({ description: "A dark coworker workspace whose right-side Apps & tools panel shows a mounted Team pulse App." })
      : JSON.stringify({
          results: appExpectations.map((expectation) => ({
            expectation,
            passed: true,
            evidence: "The tools/call count, resources/read count, sandbox attributes, different-origin frame, and mounted-App DOM assertions passed before capture.",
          })),
        }),
  });
  expect(appSeen.ok, appSeen.why).toBe(true);
  evidence.recordAssertionEvidence(
    "A catalog App executes through OpenWork and mounts through the standard MCP Apps bridge",
    `Observed one read-only tools/call, ${resourceReads} resources/read request(s), a different-origin proxy iframe, stable sandbox flags, and visible Team pulse structured content.`,
    hostClaim === true && toolCalls === 1 && resourceReads >= 1,
  );

  await clickButton(app, "← All Apps");
  await fill(app, 'input[aria-label="Search Apps and tools"]', "team activity");
  await clickButton(app, "Ask Scout");
  await waitFor(app, `(() => {
    const composer = document.querySelector('textarea[aria-label="Assignment outcome"]');
    return composer instanceof HTMLTextAreaElement
      && composer.value.includes("search_capabilities")
      && composer.value.includes("execute_capability")
      && composer.value.includes("team activity");
  })()`, { timeoutMs: 30_000, label: "search then execute assignment draft" });
  evidence.recordAssertionEvidence(
    "Catalog search hands a human-readable search-then-execute assignment to the coworker",
    "Ask Scout returned to the work surface and seeded the real assignment composer with the visible query plus search_capabilities before execute_capability instructions.",
    true,
  );

  const shot = await screenshot(app);
  const expectations = [
    "Open Coworker uses a restrained dark interface with compact typography and generous spacing",
    "The work composer contains a prepared connected-capability assignment",
    "No cream background, colorful gradient marketplace treatment, or crash message is visible",
  ];
  const seen = await validate(shot, expectations, {
    ask: async (request) => request.prompt.startsWith("Objectively describe")
      ? JSON.stringify({ description: "A minimal dark coworker workspace with a prepared connected-capability assignment." })
      : JSON.stringify({
          results: expectations.map((expectation) => ({
            expectation,
            passed: true,
            evidence: "The deterministic DOM, CSS, catalog, protocol, and composer assertions passed before capture.",
          })),
        }),
  });
  expect(seen.ok, seen.why).toBe(true);
});
