import http from "node:http";
import {
  denApiFetch,
  denWebUrl,
  openAdminConnections,
  openYourConnections,
  signInApi,
  signInViaBrowser,
} from "./lib/den-web.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "mcp-tool-calling-surfaces";
const CONNECTION_PREFIX = "Route Verification MCP — manual calling proof";
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  adminToken: "",
  connectionId: "",
  connectionName: "",
  observedCalls: [],
  observedMethods: [],
  server: null,
};

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual: actual === undefined ? undefined : JSON.stringify(actual).slice(0, 1_200),
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${JSON.stringify(actual).slice(0, 600)}`}`);
}

function json(response, status, body) {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function toolResult(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "route-verification-proof", version: "1.0.0" },
    };
  }
  if (message.method === "tools/list") {
    return {
      tools: [{
        name: "verify_connection_route",
        title: "Verify connection route",
        description: "Returns which Den connection screen invoked this safe test tool.",
        inputSchema: {
          type: "object",
          properties: {
            surface: {
              type: "string",
              enum: ["Connectors", "Your Connections"],
              description: "The Den screen running this proof.",
            },
          },
          required: ["surface"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: {
            surface: { type: "string" },
            verified: { type: "boolean" },
          },
          required: ["surface", "verified"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }],
    };
  }
  if (message.method === "tools/call") {
    const surface = message.params?.arguments?.surface;
    return {
      content: [{ type: "text", text: `Verified manual tool call from ${surface}.` }],
      structuredContent: { surface, verified: true },
    };
  }
  return {};
}

async function startMcpServer() {
  if (state.server) return;
  state.server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (url.pathname !== "/mcp" || request.method !== "POST") {
        json(response, 404, { error: "not_found" });
        return;
      }

      const body = await readJson(request);
      const messages = Array.isArray(body) ? body : [body];
      const replies = [];
      for (const message of messages) {
        if (message && typeof message === "object" && typeof message.method === "string") {
          state.observedMethods.push(message.method);
          if (message.method === "tools/call") {
            state.observedCalls.push({
              name: message.params?.name,
              arguments: message.params?.arguments,
            });
          }
        }
        if (message && typeof message === "object" && message.id !== undefined) {
          replies.push({ jsonrpc: "2.0", id: message.id, result: toolResult(message) });
        }
      }

      if (replies.length === 0) {
        response.writeHead(202, { "access-control-allow-origin": "*" });
        response.end();
        return;
      }
      json(response, 200, Array.isArray(body) ? replies : replies[0]);
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise((resolve, reject) => {
    state.server.once("error", reject);
    state.server.listen(0, "127.0.0.1", resolve);
  });
  state.server.unref();
}

function mcpUrl() {
  const address = state.server?.address();
  if (!address || typeof address === "string") throw new Error("MCP proof server has no TCP address.");
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function prepareSharedConnection(ctx) {
  await startMcpServer();
  state.adminToken = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
  witness(ctx, Boolean(state.adminToken), `The demo owner can sign in as ${ADMIN_EMAIL}.`);

  const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
    headers: { authorization: `Bearer ${state.adminToken}` },
  });
  witness(ctx, existing.response.ok, "The admin can read the manageable MCP connections.", { status: existing.response.status });
  for (const connection of existing.body.connections ?? []) {
    if (!connection.name.startsWith(CONNECTION_PREFIX)) continue;
    await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${state.adminToken}` },
    });
  }

  state.connectionName = `${CONNECTION_PREFIX} ${Date.now()}`;
  const created = await denApiFetch("/v1/mcp-connections", {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminToken}` },
    body: JSON.stringify({
      name: state.connectionName,
      url: mcpUrl(),
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true, memberIds: [], teamIds: [] },
    }),
  });
  witness(
    ctx,
    created.response.ok && typeof created.body?.id === "string" && created.body?.connected === true,
    "Den validates, connects, and shares the protocol-compatible MCP with the organization.",
    {
      access: created.body?.access,
      connected: created.body?.connected,
      id: created.body?.id,
      status: created.response.status,
    },
  );
  state.connectionId = created.body.id;
  state.observedCalls.length = 0;
  state.observedMethods.length = 0;

  const usable = await denApiFetch("/v1/mcp-connections?scope=usable", {
    headers: { authorization: `Bearer ${state.adminToken}` },
  });
  const visibleToCaller = (usable.body.connections ?? []).some((connection) => connection.id === state.connectionId);
  witness(ctx, usable.response.ok && visibleToCaller, "The org-wide connection is available under the rollout and use-grant policy.", {
    status: usable.response.status,
    visibleToCaller,
  });
}

async function openConnectors(ctx) {
  const currentUrl = await ctx.eval("window.location.href");
  if (!currentUrl.includes(new URL(denWebUrl()).host)) {
    await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
  }
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "Den web loaded" });
  await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
  await openAdminConnections(ctx);
  await ctx.waitFor(
    `Boolean(document.querySelector('[data-testid="mcp-connection-row-${state.connectionId}"]'))`,
    { timeoutMs: 30_000, label: "shared MCP connection row" },
  );
}

async function openManagedToolRunner(ctx) {
  const menuOpened = await ctx.eval(`(() => {
    const button = document.querySelector('[data-testid="mcp-connection-more-${state.connectionId}"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  ctx.assert(menuOpened, "Could not open the managed connection actions menu.");
  await ctx.waitFor(
    `Boolean(
      document.querySelector('[data-testid="toggle-managed-mcp-tool-runner-${state.connectionId}"]')
      && document.querySelector('[data-testid="toggle-managed-mcp-tool-catalog-${state.connectionId}"]')
    )`,
    { timeoutMs: 10_000, label: "managed tool actions" },
  );

  const catalogOpened = await ctx.eval(`(() => {
    const directRunner = document.querySelector('[data-testid="toggle-managed-mcp-tool-runner-${state.connectionId}"]');
    const button = document.querySelector('[data-testid="toggle-managed-mcp-tool-catalog-${state.connectionId}"]');
    if (!(directRunner instanceof HTMLButtonElement) || directRunner.disabled) return false;
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  ctx.assert(catalogOpened, "The managed connection's tool catalog was unavailable.");
  await ctx.waitFor(
    `Boolean(
      document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]')
      && document.querySelector('[data-testid="run-from-managed-mcp-tool-catalog-${state.connectionId}"]')
    )`,
    { timeoutMs: 30_000, label: "Run a tool action inside the managed tool catalog" },
  );

  const runnerOpened = await ctx.eval(`(() => {
    const button = document.querySelector('[data-testid="run-from-managed-mcp-tool-catalog-${state.connectionId}"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  ctx.assert(runnerOpened, "The tool catalog's Run a tool action was unavailable.");
  await waitForRunner(ctx);
}

async function openPersonalToolRunner(ctx) {
  const runnerOpened = await ctx.eval(`(() => {
    const button = document.querySelector('[data-testid="toggle-mcp-tool-runner-${state.connectionId}"]');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  ctx.assert(runnerOpened, "The Your Connections tool runner action was unavailable.");
  await waitForRunner(ctx);
}

async function waitForRunner(ctx) {
  await ctx.waitFor(`(() => {
    const runner = document.querySelector('[data-testid="mcp-tool-runner-${state.connectionId}"]');
    return (runner?.textContent ?? '').includes('Run a tool manually')
      && (runner?.textContent ?? '').includes('verify_connection_route');
  })()`, { timeoutMs: 30_000, label: "manual MCP tool runner" });
}

async function runToolFromSurface(ctx, surface) {
  const runnerSelector = `[data-testid="mcp-tool-runner-${state.connectionId}"]`;
  await ctx.fill(
    `${runnerSelector} textarea`,
    JSON.stringify({ surface }, null, 2),
  );
  const clicked = await ctx.eval(`(() => {
    const runner = document.querySelector(${JSON.stringify(runnerSelector)});
    const button = [...(runner?.querySelectorAll('button') ?? [])]
      .find((entry) => (entry.textContent ?? '').trim() === 'Run tool');
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  ctx.assert(clicked, `Could not run the verification tool from ${surface}.`);

  const resultText = `Verified manual tool call from ${surface}.`;
  await ctx.waitFor(`(() => {
    const runner = document.querySelector(${JSON.stringify(runnerSelector)});
    const text = runner?.textContent ?? '';
    return text.includes('Tool completed') && text.includes(${JSON.stringify(resultText)});
  })()`, { timeoutMs: 30_000, label: `${surface} tool result` });
}

function callsForSurface(surface) {
  return state.observedCalls.filter((call) => (
    call.name === "verify_connection_route"
    && call.arguments?.surface === surface
  ));
}

export default {
  id: FLOW_ID,
  title: "Admins can call the same Den-managed MCP tool from Connectors and Your Connections",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Prepare a connected MCP shared with the organization",
      run: async (ctx) => {
        if (ctx.client?.send) {
          await ctx.client.send("Emulation.setDeviceMetricsOverride", {
            width: 1440,
            height: 1050,
            deviceScaleFactor: 1,
            mobile: false,
          });
        }
        await prepareSharedConnection(ctx);
        await openConnectors(ctx);
      },
    },
    {
      name: "Run the shared tool from Connectors",
      run: async (ctx) => {
        await ctx.prove("An admin can call an org-wide connected MCP from Connectors", {
          voiceover: vo[0],
          action: async () => {
            await openManagedToolRunner(ctx);
            await runToolFromSurface(ctx, "Connectors");
            await ctx.eval(`(() => {
              const runner = document.querySelector('[data-testid="mcp-tool-runner-${state.connectionId}"]');
              runner?.scrollIntoView({ block: 'center' });
              return Boolean(runner);
            })()`);
          },
          assert: async () => {
            const connectorCalls = callsForSurface("Connectors");
            witness(ctx, connectorCalls.length === 1, "The mock MCP received one real tools/call from Connectors.", {
              connectorCalls,
              observedMethods: state.observedMethods,
            });
            witness(ctx, state.observedCalls.length === 1, "No extra MCP tool call was made while testing the shared connection from Connectors.", state.observedCalls);
            await ctx.expectText("Tool completed");
            await ctx.expectText("Verified manual tool call from Connectors.");
          },
          screenshot: {
            name: "connectors-manual-tool-completed",
            claim: "The admin-only Connectors screen can execute a safe MCP tool that the caller is granted to use.",
            requireText: [
              "Run a tool manually",
              "verify_connection_route",
              "Provider marks this tool as read-only.",
              "Tool completed",
              "Verified manual tool call from Connectors.",
            ],
            rejectText: ["Tool call failed", "Could not run", "Something went wrong"],
            hashIncludes: "/dashboard/mcp-connections",
          },
        });
      },
    },
    {
      name: "Run the same shared connection from Your Connections",
      run: async (ctx) => {
        await ctx.prove("The same org-wide tool runs from Your Connections", {
          voiceover: vo[1],
          action: async () => {
            await openYourConnections(ctx);
            await ctx.waitFor(
              `Boolean(document.querySelector('[data-testid="toggle-mcp-tool-runner-${state.connectionId}"]'))`,
              { timeoutMs: 30_000, label: "shared connection in Your Connections" },
            );
            await openPersonalToolRunner(ctx);
            await runToolFromSurface(ctx, "Your Connections");
            await ctx.eval(`(() => {
              const runner = document.querySelector('[data-testid="mcp-tool-runner-${state.connectionId}"]');
              runner?.scrollIntoView({ block: 'center' });
              return Boolean(runner);
            })()`);
          },
          assert: async () => {
            const connectorCalls = callsForSurface("Connectors");
            const personalCalls = callsForSurface("Your Connections");
            witness(ctx, connectorCalls.length === 1, "The original Connectors tools/call remains accounted for.", connectorCalls);
            witness(ctx, personalCalls.length === 1, "The mock MCP received one real tools/call from Your Connections.", personalCalls);
            witness(ctx, state.observedCalls.length === 2, "Exactly two upstream tools/call requests were made across both screens.", state.observedCalls);
            await ctx.expectText("Tool completed");
            await ctx.expectText("Verified manual tool call from Your Connections.");
          },
          screenshot: {
            name: "your-connections-manual-tool-completed",
            claim: "After sharing, Your Connections invokes the same safe MCP tool and shows its deterministic result.",
            requireText: [
              "Your Connections",
              "Run a tool manually",
              "verify_connection_route",
              "Provider marks this tool as read-only.",
              "Tool completed",
              "Verified manual tool call from Your Connections.",
            ],
            rejectText: ["Tool call failed", "Could not run", "Something went wrong"],
            hashIncludes: "/dashboard/your-connections",
          },
        });
      },
    },
    {
      name: "Clean up the proof connection",
      run: async (ctx) => {
        if (state.connectionId) {
          const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${state.adminToken}` },
          });
          ctx.assert(removed.response.ok || removed.response.status === 404, `Cleanup failed: ${removed.response.status}`);
        }
        state.server?.close();
      },
    },
  ],
};
