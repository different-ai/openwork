/**
 * In-process browser MCP servers.
 *
 * Imports chrome-devtools-mcp tools and runs them inside the Electron main
 * process — no sidecar binary, no npx, no absolute paths.
 *
 * Two servers:
 *   1. "openwork-browser" — controls the embedded WebContentsView
 *   2. "chrome"           — connects to the user's external Chrome via CDP
 *
 * Both are exposed as HTTP MCP endpoints that OpenCode connects to as
 * remote MCP servers.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ── Chrome DevTools MCP internals (imported as library, NOT spawned) ──
// IMPORTANT: never import main.js — it runs parseArguments at module load.
import "chrome-devtools-mcp/build/src/polyfill.js";

import {
  McpServer,
  SetLevelRequestSchema,
  puppeteer,
} from "chrome-devtools-mcp/build/src/third_party/index.js";

import { tools as chromeDevtoolsTools } from "chrome-devtools-mcp/build/src/tools/tools.js";
import { McpContext } from "chrome-devtools-mcp/build/src/McpContext.js";
import { McpResponse } from "chrome-devtools-mcp/build/src/McpResponse.js";
import { Mutex } from "chrome-devtools-mcp/build/src/Mutex.js";

// MCP SDK HTTP transport — works with the same McpServer
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

// ── Helpers ────────────────────────────────────────────────────────────

function noop() {}

/** Wrap a promise with a timeout. Rejects with a descriptive error. */
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Target filter for the EXTERNAL Chrome server — accept all normal pages,
 * skip chrome:// and extension pages.
 */
const EXTERNAL_TARGET_FILTER = (target) => {
  const url = target.url();
  if (url === "chrome://newtab/") return true;
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return false;
  return true;
};

/**
 * Target filter for the BUILT-IN browser server — only accept pages that
 * are NOT the main OpenWork renderer.  The main renderer loads from
 * localhost (dev) or file:// (prod).  The WebContentsView loads real
 * websites (https://, http:// on non-localhost).
 */
const BUILTIN_TARGET_FILTER = (target) => {
  const url = target.url();
  // Skip the main OpenWork renderer
  if (url.startsWith("file://")) return false;
  if (url.startsWith("http://localhost")) return false;
  if (url.startsWith("http://127.0.0.1")) return false;
  if (url.startsWith("http://[::1]")) return false;
  // Skip chrome internals
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://")) return false;
  if (url.startsWith("devtools://")) return false;
  // Skip about:blank (initial empty state before WebContentsView loads)
  if (url === "about:blank") return false;
  // Accept everything else — these are real websites in the WebContentsView
  return true;
};

async function connectBuiltinBrowser(browserURL) {
  return withTimeout(
    puppeteer.connect({
      browserURL,
      targetFilter: BUILTIN_TARGET_FILTER,
      defaultViewport: null,
    }),
    10_000,
    "connectBuiltinBrowser",
  );
}

async function connectExternalBrowser(browserURL) {
  return withTimeout(
    puppeteer.connect({
      browserURL,
      targetFilter: EXTERNAL_TARGET_FILTER,
      defaultViewport: null,
    }),
    10_000,
    "connectExternalBrowser",
  );
}

/**
 * Create an MCP server backed by chrome-devtools-mcp tools.
 *
 * @param {object}   opts
 * @param {string}   opts.name       — server name (e.g. "openwork-browser")
 * @param {string}   opts.version    — server version
 * @param {Function} opts.getBrowser — async () => Puppeteer.Browser
 * @param {Function} [opts.onToolCall] — called before each tool (e.g. to show browser panel)
 * @returns {McpServer}
 */
function createBrowserMcpServer({ name, version, getBrowser, onToolCall }) {
  const server = new McpServer(
    { name, version },
    { capabilities: { logging: {} } },
  );

  server.server.setRequestHandler(SetLevelRequestSchema, () => ({}));

  const mutex = new Mutex();
  let context = null;
  let lastBrowser = null;

  async function getContext() {
    const browser = await getBrowser();
    if (!browser?.connected) {
      throw new Error(`Browser not connected for ${name}`);
    }
    if (browser !== lastBrowser) {
      lastBrowser = browser;
      context = await McpContext.from(browser, noop, {
        experimentalDevToolsDebugging: false,
        experimentalIncludeAllPages: false,
        performanceCrux: false,
      });
    }
    return context;
  }

  /** Force a full Puppeteer reconnect + fresh McpContext on next getContext(). */
  function invalidateContext() {
    try { lastBrowser?.disconnect(); } catch { /* already gone */ }
    lastBrowser = null;
    context = null;
  }

  // Skip performance / extension / emulation categories that don't make
  // sense for the built-in browser.  Keep the full set for external Chrome.
  const skipCategories = name === "openwork-browser"
    ? new Set(["extensions", "performance"])
    : new Set();

  for (const tool of chromeDevtoolsTools) {
    if (skipCategories.has(tool.annotations?.category)) continue;

    // The upstream navigate_page tool wraps page.goto() in an additional
    // waitForNavigation/stable-DOM sequence. Electron WebContentsView targets
    // can complete the navigation while that extra wait never resolves, which
    // makes built-in browser navigation hang. Use a simpler built-in-specific
    // handler that waits for DOMContentLoaded and returns promptly.
    if (name === "openwork-browser" && tool.name === "navigate_page") {
      server.tool(
        tool.name,
        tool.description,
        tool.schema,
        async (params) => {
          const guard = await mutex.acquire();
          try {
            await onToolCall?.(tool.name, params);
            const ctx = await getContext();
            const page = ctx.getSelectedPage();
            const timeout = Number.isFinite(params?.timeout) && params.timeout > 0
              ? params.timeout
              : 30_000;
            // Use default Puppeteer waitUntil (load event).
            const options = { timeout };
            const type = params?.type ?? "url";

            if (type === "url") {
              const url = String(params?.url ?? "").trim();
              if (!url) throw new Error("navigate_page requires a url for type=url");
              // Use Puppeteer page.goto() with waitUntil:domcontentloaded
              // wrapped in a hard timeout.  Electron's loadURL sometimes
              // fails in the WebContentsView sandboxed partition while
              // Puppeteer's CDP-based navigation succeeds.
              await withTimeout(page.goto(url, options), timeout + 1_000, "openwork-browser/navigate_page");
            } else if (type === "back") {
              await withTimeout(page.goBack(options), timeout + 1_000, "openwork-browser/navigate_page(back)");
            } else if (type === "forward") {
              await withTimeout(page.goForward(options), timeout + 1_000, "openwork-browser/navigate_page(forward)");
            } else if (type === "reload") {
              await withTimeout(page.reload({ ...options, ignoreCache: params?.ignoreCache }), timeout + 1_000, "openwork-browser/navigate_page(reload)");
            } else {
              throw new Error(`Unsupported navigation type: ${type}`);
            }

            const targetUrl = type === "url" ? String(params?.url ?? "").trim() : page.url();
            return { content: [{ type: "text", text: `Navigated to ${targetUrl || page.url()}` }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text", text: `Error: ${msg}` }] };
          } finally {
            guard.dispose();
          }
        },
      );
      continue;
    }

    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (params) => {
        const guard = await mutex.acquire();
        try {
          // onToolCall may be async (e.g. ensuring the WebContentsView is loaded)
          await onToolCall?.(tool.name, params);
          const ctx = await getContext();
          const response = new McpResponse();
          // Wrap the tool handler with a hard timeout to prevent indefinite
          // hangs. navigate_page in particular can hang inside Puppeteer's
          // waitForNavigation when the Electron WebContentsView doesn't fire
          // the expected CDP events.
          const TOOL_TIMEOUT = 30_000;
          await withTimeout(
            tool.handler({ params }, response, ctx),
            TOOL_TIMEOUT,
            `${name}/${tool.name}`,
          );
          const { content } = await response.handle(tool.name, ctx);
          return { content };
        } catch (err) {
          // Return the error as tool output instead of crashing the
          // session — the agent can retry or fall back.
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: "text", text: `Error: ${msg}` }] };
        } finally {
          guard.dispose();
        }
      },
    );
  }

  return server;
}

// ── HTTP wrappers ──────────────────────────────────────────────────────

/**
 * Start an MCP-over-HTTP server on a random localhost port.
 *
 * Uses one StreamableHTTPServerTransport per session.  Each new session
 * (no mcp-session-id header) gets its own transport + server instance
 * created by the factory.
 *
 * Returns { port, close }.
 */
async function startMcpHttpServer(mcpServerFactory, preferredPort = 0) {
  const sessions = new Map();

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1`);

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const sessionId = req.headers["mcp-session-id"];

      if (req.method === "POST") {
        // Existing session
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId);
          await transport.handleRequest(req, res);
          return;
        }

        // New session — create a fresh transport + server
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport);
          },
        });
        const server = mcpServerFactory();
        await server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }

      if (req.method === "GET") {
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId).handleRequest(req, res);
          return;
        }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No session. Send a POST first." }));
        return;
      }

      if (req.method === "DELETE") {
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId);
          sessions.delete(sessionId);
          await transport.close();
        }
        res.writeHead(200);
        res.end();
        return;
      }

      res.writeHead(405);
      res.end("Method not allowed");
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
  });

  async function listen(portToTry) {
    return new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(portToTry, "127.0.0.1", () => {
        resolve(httpServer.address().port);
      });
    });
  }

  let port;
  try {
    port = await listen(preferredPort);
  } catch (error) {
    if (!preferredPort || error?.code !== "EADDRINUSE") throw error;
    port = await listen(0);
  }

  return {
    port,
    close: () => new Promise((resolve) => httpServer.close(resolve)),
  };
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Boot both MCP servers.
 *
 * @param {object} opts
 * @param {number} opts.electronCdpPort — Electron's remote debugging port (for built-in browser)
 * @param {Function} opts.onBuiltinToolCall — called before each built-in browser tool (opens panel)
 * @param {Function} opts.onHideBrowser — called to close the browser panel
 * @returns {{ builtinPort: number, externalPort: number | null, stop: () => Promise<void> }}
 */
export async function startBrowserMcpServers({ electronCdpPort, onBuiltinToolCall, onHideBrowser }) {
  let builtinBrowser = null;
  let externalBrowser = null;

  // Factory: each new MCP session gets a fresh server instance.
  function createBuiltinFactory() {
    const server = createBrowserMcpServer({
      name: "openwork-browser",
      version: "0.1.0",
      getBrowser: async () => {
        // Preserve the Puppeteer browser/context across sequential tool calls.
        // chrome-devtools-mcp stores the latest accessibility snapshot on the
        // McpContext; reconnecting for every tool loses that snapshot, making
        // follow-up fill/click calls fail with "No snapshot found".
        if (!builtinBrowser?.connected) {
          builtinBrowser = await connectBuiltinBrowser(`http://127.0.0.1:${electronCdpPort}`);
        }
        return builtinBrowser;
      },
      onToolCall: onBuiltinToolCall,
    });

    server.tool(
      "show_browser",
      "Open the built-in browser panel inside the OpenWork app. " +
      "Called automatically when any browser tool runs, but can also be " +
      "called explicitly to show the panel before interacting.",
      {},
      async () => {
        await onBuiltinToolCall?.("show_browser");
        return { content: [{ type: "text", text: "Browser panel opened." }] };
      },
    );

    server.tool(
      "hide_browser",
      "Close the built-in browser panel. Call when the browsing task is " +
      "finished and the user no longer needs to see the browser.",
      {},
      async () => {
        onHideBrowser?.();
        return { content: [{ type: "text", text: "Browser panel closed." }] };
      },
    );

    return server;
  }

  /**
   * Probe whether an external Chrome is reachable on any known CDP port.
   * Returns { connected, port } without storing state.
   */
  async function probeExternalChrome() {
    for (const port of [9222, 9229]) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return { connected: true, port };
      } catch { /* not available */ }
    }
    return { connected: false, port: null };
  }

  function createExternalFactory() {
    const server = createBrowserMcpServer({
      name: "chrome",
      version: "0.1.0",
      getBrowser: async () => {
        if (!externalBrowser?.connected) {
          for (const port of [9222, 9229]) {
            try {
              externalBrowser = await connectExternalBrowser(`http://127.0.0.1:${port}`);
              return externalBrowser;
            } catch { /* not available */ }
          }
          throw new Error(
            "Chrome is not reachable. " +
            "Enable remote debugging in your Chrome: go to chrome://inspect/#remote-debugging and turn it on. " +
            "No restart needed on Chrome 144+."
          );
        }
        return externalBrowser;
      },
    });

    // Diagnostic tool — lets the agent check Chrome availability before
    // attempting browsing, so it can guide the user instead of failing.
    server.tool(
      "chrome_status",
      "Check whether the user's real Chrome browser is reachable via remote " +
      "debugging. Call this BEFORE using any other chrome tool. If status is " +
      "unavailable, tell the user to enable remote debugging in Chrome: " +
      "chrome://inspect/#remote-debugging → enable → allow connections. " +
      "No Chrome restart is needed on Chrome 144+.",
      {},
      async () => {
        const probe = await probeExternalChrome();
        if (probe.connected) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                connected: true,
                port: probe.port,
                hint: "Chrome is reachable. You can now use chrome tools to control the user's browser.",
              }),
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              connected: false,
              port: null,
              hint: "Chrome is not reachable. Ask the user to enable remote debugging: " +
                "open chrome://inspect/#remote-debugging in Chrome, enable it, and allow " +
                "incoming connections. No restart needed on Chrome 144+. " +
                "Alternatively, offer to use the built-in openwork-browser instead.",
            }),
          }],
        };
      },
    );

    return server;
  }

  const builtin = await startMcpHttpServer(createBuiltinFactory, 64883);
  const external = await startMcpHttpServer(createExternalFactory, 64884);

  return {
    builtinPort: builtin.port,
    externalPort: external.port,
    async stop() {
      await Promise.all([builtin.close(), external.close()]);
      try { builtinBrowser?.disconnect(); } catch {}
      try { externalBrowser?.disconnect(); } catch {}
    },
  };
}
