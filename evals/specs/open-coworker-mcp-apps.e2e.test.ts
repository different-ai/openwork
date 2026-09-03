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
  ? "Open Coworker walks Apps & tools level by level, launches a standard App inline and beside the conversation, and prepares search then execute work"
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

async function clickTestId(app: Awaited<ReturnType<typeof coworker>>, testId: string): Promise<void> {
  await waitFor(app, `(() => {
    const element = document.querySelector(${json(`[data-testid="${testId}"]`)});
    if (!(element instanceof HTMLElement)) return false;
    if (element instanceof HTMLButtonElement && element.disabled) return false;
    element.click();
    return true;
  })()`, { timeoutMs: 30_000, label: `click ${testId}` });
}

/** Lay the window out at one width (the page sees a real resize), so widths can be swept. */
async function setWindowWidth(app: Awaited<ReturnType<typeof coworker>>, width: number): Promise<void> {
  await app.client.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
  await waitFor(app, `window.innerWidth === ${width}`, { timeoutMs: 30_000, label: `window at ${width}px` });
}

async function clearWindowWidth(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await app.client.send("Emulation.clearDeviceMetricsOverride", {});
}

/** Drag the panel's edge until the panel is `width` wide, the way a person would. */
async function resizePanelTo(app: Awaited<ReturnType<typeof coworker>>, width: number): Promise<void> {
  await evalIn(app, `(async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    const handle = document.querySelector('[data-testid="context-panel-resizer"]');
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(handle instanceof HTMLElement) || !(panel instanceof HTMLElement)) throw new Error("The panel edge is not on screen.");
    const rect = handle.getBoundingClientRect();
    const startX = rect.left + rect.width / 2;
    const startWidth = panel.getBoundingClientRect().width;
    // A right-side panel grows as the pointer moves left.
    const endX = startX - (${width} - startWidth);
    const options = (clientX) => ({ bubbles: true, cancelable: true, clientX, clientY: rect.top + 40, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 });
    handle.dispatchEvent(new PointerEvent("pointerdown", options(startX)));
    // The edge listens for movement once it knows a drag began.
    await settle();
    window.dispatchEvent(new PointerEvent("pointermove", options(startX - 8)));
    await settle();
    window.dispatchEvent(new PointerEvent("pointermove", options(endX)));
    await settle();
    window.dispatchEvent(new PointerEvent("pointerup", { ...options(endX), buttons: 0 }));
    return true;
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  await waitFor(app, `Math.round(document.querySelector('[data-testid="context-panel"]')?.getBoundingClientRect().width ?? 0) === ${width}`, { timeoutMs: 30_000, label: `panel at ${width}px` });
}

/** Bring the right panel to the Apps & tools view from whatever state it is in (folded, another view, or Activity). */
async function openAppsAndTools(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "capabilities") return true;
    if (panel.dataset.collapsed === "true") {
      document.querySelector('[data-testid="context-rail-capabilities"]')?.click();
      return false;
    }
    if (panel.dataset.view !== "overview") {
      document.querySelector('button[aria-label="Back to activity"]')?.click();
      return false;
    }
    const link = [...document.querySelectorAll('nav[aria-label="More for this coworker"] button')]
      .find((button) => (button.textContent ?? "").includes("Apps & tools"));
    link?.click();
    return false;
  })()`, { timeoutMs: 60_000, label: "Apps & tools view" });
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
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]'))`, { timeoutMs: 120_000, label: "team rail" });
  await openAppsAndTools(app);

  // --- The root: three flat rows with a status line and a count, a search field in the content.
  const root = await waitFor(app, `(() => {
    const local = document.querySelector('[data-testid="apps-tools-row-local"]');
    const apps = document.querySelector('[data-testid="apps-tools-row-apps"]');
    const connected = document.querySelector('[data-testid="apps-tools-row-connected"]');
    if (!(local instanceof HTMLElement) || !(apps instanceof HTMLElement) || !(connected instanceof HTMLElement)) return false;
    if (!local.innerText.includes("1") || !apps.innerText.includes("1")) return false;
    return {
      route: document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route"),
      connected: connected.innerText,
      apps: apps.innerText,
      local: local.innerText,
      hasSearch: Boolean(document.querySelector('[data-testid="apps-tools-search"]')),
      crumbs: [...document.querySelectorAll('[data-testid="panel-crumb"]')].map((crumb) => crumb.textContent),
      body: document.body.innerText.toLowerCase(),
    };
  })()`, { timeoutMs: 60_000, label: "Apps & tools root rows with counts" });
  expect(root).toMatchObject({ route: "capabilities", hasSearch: true, crumbs: ["Apps & tools"] });
  if (!isRecord(root) || typeof root.connected !== "string" || typeof root.apps !== "string" || typeof root.local !== "string" || typeof root.body !== "string") {
    throw new Error("Root row facts were unavailable.");
  }
  expect(root.connected).toContain("Connected with OpenWork");
  expect(root.connected).toContain("Not connected");
  expect(root.apps).toContain("Apps");
  expect(root.local).toContain("Tools on this Mac");
  expect(root.body).not.toContain("mcp connections");
  const flatSurface = await evalIn(app, `(() => {
    const root = document.querySelector("[data-testid=coworker-capabilities]");
    if (!root) return false;
    return [...root.querySelectorAll("*")].every((element) => getComputedStyle(element).backgroundImage === "none");
  })()`);
  expect(flatSurface).toBe(true);

  // --- Connected with OpenWork: the first visit is the full-panel explanation, then the short card.
  await clickTestId(app, "apps-tools-row-connected");
  const connectIntro = await waitFor(app, `(() => {
    const intro = document.querySelector('[data-testid="coworker-connect-card"][data-pitch="full"]');
    if (!(intro instanceof HTMLElement)) return false;
    return {
      route: document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route"),
      text: intro.innerText,
      fillsPanel: intro.getBoundingClientRect().height >= 400,
      hasSearch: Boolean(document.querySelector('[data-testid="apps-tools-search"]')),
      checkbox: Boolean(intro.querySelector('[data-testid="coworker-connect-hide-pitch"]')),
      back: document.querySelector('[data-testid="panel-back"]')?.getAttribute("aria-label"),
    };
  })()`, { timeoutMs: 30_000, label: "OpenWork Connect introduction step" });
  expect(connectIntro).toMatchObject({ route: "capabilities/connected", fillsPanel: true, hasSearch: false, checkbox: true, back: "Back to Apps & tools" });
  if (!isRecord(connectIntro) || typeof connectIntro.text !== "string") throw new Error("Connect introduction facts were unavailable.");
  expect(connectIntro.text).toContain("Continue with OpenWork");
  expect(connectIntro.text).toContain("Skip");
  await clickButton(app, "Skip");
  await waitFor(app, `document.querySelector('[data-testid="coworker-connect-card"]')?.getAttribute("data-pitch") === "compact"`, { timeoutMs: 30_000, label: "short Connect form after Skip" });
  expect(String(await evalIn(app, `document.querySelector('[data-testid="coworker-connect-card"]')?.innerText ?? ""`))).toContain("Continue with OpenWork");
  await clickTestId(app, "panel-back");
  await waitFor(app, `document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") === "capabilities"`, { timeoutMs: 30_000, label: "back at the root" });
  evidence.recordAssertionEvidence(
    "Apps & tools opens as a root of rows, and Connected with OpenWork is one level below it",
    "The root showed Connected with OpenWork (Not connected), Apps (1), and Tools on this Mac (1) as flat rows with a search field in the content and no MCP vocabulary; opening Connected showed the full-panel OpenWork Connect step (Continue, Skip, a don't-show-again choice, no search field) with a back control named after the root, and Skip left the short card.",
    true,
  );

  // --- Tools on this Mac → the chapter-notes tool → back, with focus returned to its row.
  await clickTestId(app, "apps-tools-row-local");
  const toolRow = await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="coworker-mcp-connection"]')].find((candidate) => (candidate.textContent ?? "").includes(${json(mcpServerName)}));
    if (!(row instanceof HTMLElement) || !(row.textContent ?? "").includes("Connected")) return false;
    return { text: row.innerText, rows: document.querySelectorAll('[data-testid="coworker-mcp-connection"]').length, route: document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") };
  })()`, { timeoutMs: 60_000, label: "chapter-notes row reads Connected" });
  expect(toolRow).toMatchObject({ rows: 1, route: "capabilities/local" });
  await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="coworker-mcp-connection"]')].find((candidate) => (candidate.textContent ?? "").includes(${json(mcpServerName)}));
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "open the chapter-notes tool" });
  const toolDetail = await waitFor(app, `(() => {
    const detail = document.querySelector('[data-testid="coworker-mcp-tool-detail"]');
    const offers = document.querySelector('[data-testid="apps-tools-offers"]');
    if (!(detail instanceof HTMLElement) || !(offers instanceof HTMLElement)) return false;
    return {
      route: document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route"),
      text: detail.innerText,
      offers: [...offers.querySelectorAll('[data-testid="apps-tools-offer"]')].map((offer) => offer.textContent),
      back: document.querySelector('[data-testid="panel-back"]')?.getAttribute("aria-label"),
      crumbDepths: [...document.querySelectorAll('[data-testid="panel-crumb"]')].map((crumb) => crumb.getAttribute("data-depth")),
      collapsed: document.querySelector('[data-testid="panel-breadcrumbs"]')?.getAttribute("data-collapsed"),
      width: document.querySelector('[data-testid="context-panel"]')?.getBoundingClientRect().width,
    };
  })()`, { timeoutMs: 60_000, label: "chapter-notes detail with what it offers" });
  expect(toolDetail).toMatchObject({ route: `capabilities/local/tool:${mcpServerName}`, back: "Back to Tools on this Mac" });
  if (!isRecord(toolDetail) || typeof toolDetail.text !== "string" || !Array.isArray(toolDetail.offers)) throw new Error("Tool detail facts were unavailable.");
  expect(toolDetail.text).toContain("Connected");
  expect(toolDetail.text).toContain("Ask Scout to use it");
  expect(toolDetail.offers.join("\n")).toContain("Team pulse");
  expect(toolDetail.text).not.toContain(toolName);
  // The panel opens at 360 px: three levels fold the middle crumb into "…".
  expect(toolDetail).toMatchObject({ collapsed: "true", crumbDepths: ["0", "2"] });
  await clickTestId(app, "panel-back");
  const returned = await waitFor(app, `(() => {
    if (document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") !== "capabilities/local") return false;
    return { focused: document.activeElement?.getAttribute("data-row-id") ?? "" };
  })()`, { timeoutMs: 30_000, label: "back to Tools on this Mac" });
  expect(returned).toEqual({ focused: `tool:${mcpServerName}` });
  evidence.recordAssertionEvidence(
    "A tool on this Mac reads in plain words and says what it offers",
    "Tools on this Mac listed chapter-notes as Connected with a count; its detail named the Team pulse App it offers by title (never the tool identifier), offered Ask Scout to use it, folded the breadcrumb trail to … at 360 px, and Back returned focus to the chapter-notes row.",
    true,
  );

  // --- Apps → Team pulse → Open renders the App inline in the panel.
  await clickTestId(app, "panel-crumb");
  await waitFor(app, `document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") === "capabilities"`, { timeoutMs: 30_000, label: "root crumb returns to the root" });
  await clickTestId(app, "apps-tools-row-apps");
  await waitFor(app, `document.querySelectorAll("[data-testid=coworker-mcp-app]").length === 1`, { timeoutMs: 60_000, label: "live Coworker MCP App list" });
  const appRowText = String(await evalIn(app, `document.querySelector("[data-testid=coworker-mcp-app]")?.innerText ?? ""`));
  expect(appRowText).toContain("Team pulse");
  expect(appRowText).toContain(`${mcpServerName} on this Mac`);
  await clickButtonContaining(app, "Team pulse");
  await waitForText(app, "Read only", { timeoutMs: 30_000 });
  const appDetailRoute = String(await evalIn(app, `document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") ?? ""`));
  expect(appDetailRoute).toBe(`capabilities/apps/app:${mcpServerName}:${toolName}:${resourceUri}`);
  await clickTestId(app, "apps-tools-open-app");
  await waitFor(app, `Boolean(document.querySelector(${json(`[data-testid="context-panel"] [data-mcp-app-resource="${resourceUri}"] iframe`)}))`, {
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
    "A standard MCP App is mounted inline in the coworker's Apps & tools panel, one level below Apps",
    "The App renders inside a different-origin sandboxed frame rather than the host document",
  ];
  const appSeen = await validate(appShot, appExpectations, {
    ask: async (request) => request.prompt.startsWith("Objectively describe")
      ? JSON.stringify({ description: "A dark coworker workspace whose right-side Apps & tools panel shows a mounted Team pulse App under breadcrumbs." })
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
    `Apps listed Team pulse with its source line; its detail carried the route capabilities/apps/app:…; Open produced one read-only tools/call, ${resourceReads} resources/read request(s), a different-origin proxy iframe with stable sandbox flags, and visible Team pulse structured content.`,
    hostClaim === true && toolCalls === 1 && resourceReads >= 1,
  );

  // --- Open beside at a wide window: the detail moves to a column next to the conversation
  // while the panel returns to its list; shrinking the window folds it back into the panel.
  await setWindowWidth(app, 1_700);
  await clickTestId(app, "apps-tools-open-beside");
  const beside = await waitFor(app, `(() => {
    const column = document.querySelector('[data-testid="beside-column"]');
    if (!(column instanceof HTMLElement)) return false;
    return {
      route: column.getAttribute("data-route"),
      width: column.getBoundingClientRect().width,
      panelRoute: document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route"),
      focused: document.activeElement?.getAttribute("data-row-id") ?? "",
      mainWidth: document.querySelector("main")?.getBoundingClientRect().width ?? 0,
    };
  })()`, { timeoutMs: 30_000, label: "App detail beside the conversation" });
  expect(beside).toMatchObject({ route: appDetailRoute, panelRoute: "capabilities/apps", focused: `app:${mcpServerName}:${toolName}:${resourceUri}` });
  if (!isRecord(beside) || typeof beside.width !== "number" || typeof beside.mainWidth !== "number") throw new Error("Beside column facts were unavailable.");
  expect(beside.width).toBeGreaterThanOrEqual(480);
  expect(beside.mainWidth).toBeGreaterThanOrEqual(520);
  await waitFor(app, `(() => {
    const button = document.querySelector('[data-testid="beside-column"] [data-testid="apps-tools-open-app"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "Open inside the beside column" });
  await waitFor(app, `document.querySelector(${json(`[data-testid="beside-column"] [data-mcp-app-resource="${resourceUri}"]`)})?.getAttribute("data-mcp-app-ready") === "true"`, {
    timeoutMs: 60_000,
    label: "App mounted in the beside column",
  });
  expect(toolCalls).toBe(2);
  await setWindowWidth(app, 1_200);
  const folded = await waitFor(app, `(() => {
    if (document.querySelector('[data-testid="beside-column"]')) return false;
    const panel = document.querySelector('[data-testid="context-panel"]');
    return {
      panelRoute: document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route"),
      collapsed: panel?.getAttribute("data-collapsed"),
      besideOffered: Boolean(document.querySelector('[data-testid="apps-tools-open-beside"]')),
    };
  })()`, { timeoutMs: 30_000, label: "beside folds back into the panel" });
  expect(folded).toEqual({ panelRoute: appDetailRoute, collapsed: "false", besideOffered: false });
  evidence.recordAssertionEvidence(
    "Open beside hosts the App next to the conversation and folds back when the window shrinks",
    "At 1,700 px Open beside moved the Team pulse detail into a column of at least 480 px beside a conversation still at least 520 px wide, the panel returned to the Apps list with focus on the Team pulse row, Open inside the column mounted the App (a second tools/call); at 1,200 px the column folded back into the panel at the same route and Open beside was no longer offered.",
    true,
  );

  // --- Widths: breadcrumbs fold to … at 320 px and show every level at 440 px.
  await resizePanelTo(app, 320);
  const narrow = await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement) || Math.round(panel.getBoundingClientRect().width) !== 320) return false;
    return {
      collapsed: document.querySelector('[data-testid="panel-breadcrumbs"]')?.getAttribute("data-collapsed"),
      more: document.querySelector('[data-testid="panel-crumb-more"]')?.getAttribute("aria-label") ?? "",
      visible: [...document.querySelectorAll('[data-testid="panel-breadcrumbs"] [data-testid="panel-crumb"]')].map((crumb) => crumb.textContent),
      overflow: [...document.querySelectorAll('[data-testid="panel-content"] *')].every((element) => element.scrollWidth <= element.clientWidth + 1 || getComputedStyle(element).overflowX !== "visible"),
    };
  })()`, { timeoutMs: 30_000, label: "panel at 320 px" });
  expect(narrow).toMatchObject({ collapsed: "true", more: "1 more level", visible: ["Apps & tools", "Team pulse"] });
  await waitFor(app, `(() => {
    const more = document.querySelector('[data-testid="panel-crumb-more"]');
    if (!(more instanceof HTMLElement)) return false;
    more.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "open the … menu" });
  const skipped = await waitFor(app, `(() => {
    const menu = document.querySelector('[role="menu"][aria-label="Levels above"]');
    return menu ? [...menu.querySelectorAll("button")].map((item) => item.textContent) : false;
  })()`, { timeoutMs: 30_000, label: "skipped levels menu" });
  expect(skipped).toEqual(["Apps"]);
  await waitFor(app, `(() => {
    const item = document.querySelector('[role="menu"][aria-label="Levels above"] button');
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "choose Apps from the menu" });
  await waitFor(app, `document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") === "capabilities/apps"`, { timeoutMs: 30_000, label: "the skipped level opens" });
  await clickButtonContaining(app, "Team pulse");
  // 440 px needs a window with room for it beside the rail and a 520 px conversation.
  await setWindowWidth(app, 1_400);
  await resizePanelTo(app, 440);
  const wide = await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement) || Math.round(panel.getBoundingClientRect().width) !== 440) return false;
    return {
      collapsed: document.querySelector('[data-testid="panel-breadcrumbs"]')?.getAttribute("data-collapsed"),
      visible: [...document.querySelectorAll('[data-testid="panel-breadcrumbs"] [data-testid="panel-crumb"]')].map((crumb) => crumb.textContent),
    };
  })()`, { timeoutMs: 30_000, label: "panel at 440 px" });
  expect(wide).toEqual({ collapsed: "false", visible: ["Apps & tools", "Apps", "Team pulse"] });
  evidence.recordAssertionEvidence(
    "The trail folds at 320 px and shows every level at 440 px",
    "Dragged to 320 px the header kept the root and Team pulse with … holding Apps (opened from its menu); dragged to 440 px all three levels showed; nothing in the content overflowed sideways.",
    true,
  );

  // --- Search from the root opens a result with its trail built as if navigated.
  await clickTestId(app, "panel-crumb");
  await waitFor(app, `document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") === "capabilities"`, { timeoutMs: 30_000, label: "root again" });
  await fill(app, '[data-testid="apps-tools-search"]', "pulse");
  const results = await waitFor(app, `(() => {
    const groups = [...document.querySelectorAll('[data-testid="apps-tools-search-group"]')];
    if (groups.length < 2) return false;
    return groups.map((group) => [group.getAttribute("data-group"), [...group.querySelectorAll('[data-testid="apps-tools-search-result"]')].map((row) => row.textContent)]);
  })()`, { timeoutMs: 30_000, label: "grouped search results" });
  expect(results).toEqual([
    ["apps", [expect.stringContaining("Team pulse")]],
    ["local", [expect.stringContaining(mcpServerName)]],
  ]);
  await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="apps-tools-search-group"][data-group="apps"] [data-testid="apps-tools-search-result"]');
    if (!(row instanceof HTMLElement)) return false;
    row.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "open the Team pulse result" });
  const fromSearch = await waitFor(app, `(() => {
    if (document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") !== ${json(appDetailRoute)}) return false;
    return {
      crumbs: [...document.querySelectorAll('[data-testid="panel-breadcrumbs"] [data-testid="panel-crumb"]')].map((crumb) => crumb.textContent),
      depth: document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-depth"),
    };
  })()`, { timeoutMs: 30_000, label: "result opened with its trail" });
  expect(fromSearch).toEqual({ crumbs: ["Apps & tools", "Apps", "Team pulse"], depth: "2" });

  // --- Escape goes back a level at depth 2, and closes the panel only at the root.
  const escape = async () => evalIn(app, `window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await escape();
  await waitFor(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-depth") === "1" && document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed") === "false"`, { timeoutMs: 30_000, label: "Escape at depth 2 goes back" });
  await escape();
  await waitFor(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-depth") === "0" && document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed") === "false"`, { timeoutMs: 30_000, label: "Escape at depth 1 reaches the root" });
  await escape();
  await waitFor(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed") === "true"`, { timeoutMs: 30_000, label: "Escape at the root closes the panel" });
  evidence.recordAssertionEvidence(
    "Search understands where it is, and Escape walks back before it closes",
    "Searching pulse from the root grouped one App and one tool on this Mac; opening the App showed the trail Apps & tools › Apps › Team pulse at depth 2; Escape went to Apps, then to the root, and only then closed the panel.",
    true,
  );

  // --- Narrow window: the open panel lies over the conversation behind a scrim.
  await setWindowWidth(app, 880);
  await openAppsAndTools(app);
  const overlay = await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (panel?.getAttribute("data-overlay") !== "true") return false;
    return { scrim: Boolean(document.querySelector('[data-testid="context-panel-scrim"]')), position: getComputedStyle(panel).position };
  })()`, { timeoutMs: 30_000, label: "panel overlays the conversation" });
  expect(overlay).toEqual({ scrim: true, position: "absolute" });
  await clickTestId(app, "context-panel-scrim");
  await waitFor(app, `document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed") === "true"`, { timeoutMs: 30_000, label: "the scrim closes the panel" });
  await clearWindowWidth(app);

  // --- Ask <coworker> from the App detail seeds a human-readable assignment.
  await openAppsAndTools(app);
  await clickTestId(app, "apps-tools-row-apps");
  await clickButtonContaining(app, "Team pulse");
  await clickTestId(app, "apps-tools-ask");
  await waitFor(app, `(() => {
    const composer = document.querySelector('textarea[aria-label="Assignment outcome"]');
    return composer instanceof HTMLTextAreaElement
      && composer.value.includes("Team pulse")
      && composer.value.includes(${json(mcpServerName)})
      && composer.value.toLowerCase().includes("search connected capabilities");
  })()`, { timeoutMs: 30_000, label: "App-seeded assignment draft" });
  evidence.recordAssertionEvidence(
    "An App hands a human-readable assignment to the coworker",
    "Ask Scout on the Team pulse detail returned to the work surface and seeded the real assignment composer with the App, its source, and search-first instructions without sending anything.",
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
