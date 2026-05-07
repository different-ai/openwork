/**
 * In-process browser MCP servers.
 *
 * Two servers:
 *   1. "openwork-browser" — controls the embedded WebContentsView using
 *      native Electron webContents APIs (no Puppeteer, no app-level CDP).
 *   2. "chrome" — connects to the user's external Chrome via Puppeteer/CDP.
 *
 * Both are exposed as HTTP MCP endpoints that OpenCode connects to as
 * remote MCP servers.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// ── Native built-in browser server ────────────────────────────────────
import { createNativeBuiltinServer } from "./browser-native-tools.mjs";

// ── Chrome DevTools MCP internals (for EXTERNAL Chrome only) ──────────
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
 * Used ONLY for the external Chrome server.
 */
function createExternalChromeServer({ getBrowser }) {
  const server = new McpServer(
    { name: "chrome", version: "0.1.0" },
    { capabilities: { logging: {} } },
  );

  server.server.setRequestHandler(SetLevelRequestSchema, () => ({}));

  const mutex = new Mutex();
  let context = null;
  let lastBrowser = null;

  async function getContext() {
    const browser = await getBrowser();
    if (!browser?.connected) {
      throw new Error("Browser not connected for chrome");
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

  for (const tool of chromeDevtoolsTools) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema,
      async (params) => {
        const guard = await mutex.acquire();
        try {
          const ctx = await getContext();
          const response = new McpResponse();
          const TOOL_TIMEOUT = 30_000;
          await withTimeout(
            tool.handler({ params }, response, ctx),
            TOOL_TIMEOUT,
            `chrome/${tool.name}`,
          );
          const { content } = await response.handle(tool.name, ctx);
          return { content };
        } catch (err) {
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
 * @param {object}   opts
 * @param {Function} opts.getWebContents    — () => WebContents | null (built-in browser view)
 * @param {Function} opts.onBuiltinToolCall — called before each built-in browser tool (opens panel)
 * @param {Function} opts.onHideBrowser     — called to close the browser panel
 * @returns {{ builtinPort: number, externalPort: number, stop: () => Promise<void> }}
 */
export async function startBrowserMcpServers({ getWebContents, onBuiltinToolCall, onHideBrowser }) {
  let externalBrowser = null;

  // ── Built-in browser: native Electron APIs ────────────────────────
  let builtinSnapshotReset = null;
  function createBuiltinFactory() {
    const srv = createNativeBuiltinServer({
      getWebContents,
      onToolCall: onBuiltinToolCall,
      onHideBrowser,
    });
    builtinSnapshotReset = srv._snapshotReset;
    return srv;
  }

  // ── External Chrome: Puppeteer + CDP (unchanged) ──────────────────

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
    const server = createExternalChromeServer({
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
    _snapshotReset: () => builtinSnapshotReset?.(),
    async stop() {
      await Promise.all([builtin.close(), external.close()]);
      try { externalBrowser?.disconnect(); } catch {}
    },
  };
}
