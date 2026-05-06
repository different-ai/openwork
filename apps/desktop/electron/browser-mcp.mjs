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
  return puppeteer.connect({
    browserURL,
    targetFilter: BUILTIN_TARGET_FILTER,
    defaultViewport: null,
  });
}

async function connectExternalBrowser(browserURL) {
  return puppeteer.connect({
    browserURL,
    targetFilter: EXTERNAL_TARGET_FILTER,
    defaultViewport: null,
  });
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

  // Skip performance / extension / emulation categories that don't make
  // sense for the built-in browser.  Keep the full set for external Chrome.
  const skipCategories = name === "openwork-browser"
    ? new Set(["extensions", "performance"])
    : new Set();

  for (const tool of chromeDevtoolsTools) {
    if (skipCategories.has(tool.annotations?.category)) continue;

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
          await tool.handler({ params }, response, ctx);
          const { content } = await response.handle(tool.name, ctx);
          return { content };
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
async function startMcpHttpServer(mcpServerFactory) {
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

  const port = await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      resolve(httpServer.address().port);
    });
  });

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

  const builtin = await startMcpHttpServer(createBuiltinFactory);
  const external = await startMcpHttpServer(createExternalFactory);

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
