import http from "node:http";
import { denApiFetch, denWebUrl, mcpAgentCall, mintMcpToken, openAdminConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "mcp-tool-catalog";
const CONNECTION_PREFIX = "Incident Response MCP — tool catalog proof";
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  adminToken: "",
  connectionId: "",
  connectionName: "",
  observedMethods: [],
  server: null,
};

async function waitForObserved(method, minimum, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (state.observedMethods.filter((entry) => entry === method).length >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${minimum} observed ${method} requests.`);
}

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

function mcpResult(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "incident-response-proof", version: "1.0.0" },
    };
  }
  if (message.method === "tools/list") {
    return {
      tools: [
        {
          name: "search_incidents",
          title: "Search incidents",
          description: "Search incidents by query and optional status.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Words to match in incident titles and summaries." },
              status: { type: "string", enum: ["open", "resolved"], description: "Limit results to one status." },
            },
            required: ["query"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { resultCount: { type: "number" } },
            required: ["resultCount"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: "create_postmortem",
          title: "Draft a postmortem",
          description: "Create a draft postmortem for a resolved incident.",
          inputSchema: {
            type: "object",
            properties: {
              incidentId: { type: "string" },
              owner: { type: "string" },
            },
            required: ["incidentId"],
            additionalProperties: false,
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
          },
        },
      ],
    };
  }
  if (message.method === "tools/call") {
    return { isError: true, content: [{ type: "text", text: "This proof must never execute a tool." }] };
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
        }
        if (message && typeof message === "object" && message.id !== undefined) {
          replies.push({ jsonrpc: "2.0", id: message.id, result: mcpResult(message) });
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

async function ensureConnection(ctx) {
  if (state.connectionId) return;
  await startMcpServer();
  state.adminToken = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
  witness(ctx, Boolean(state.adminToken), `The demo owner can sign in as ${ADMIN_EMAIL}.`);

  const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
    headers: { authorization: `Bearer ${state.adminToken}` },
  });
  witness(ctx, existing.response.ok, "The admin can read the manageable MCP connections.", { status: existing.response.status });
  for (const connection of existing.body.connections ?? []) {
    if (connection.name.startsWith(CONNECTION_PREFIX)) {
      await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${state.adminToken}` },
      });
    }
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
  witness(ctx, created.response.ok && typeof created.body?.id === "string" && created.body?.connected === true, "Den validates and connects the protocol-compatible MCP server.", {
    status: created.response.status,
    id: created.body?.id,
    connected: created.body?.connected,
  });
  state.connectionId = created.body.id;
  state.observedMethods.length = 0;
}

async function navigateToConnections(ctx) {
  const currentUrl = await ctx.eval("window.location.href");
  if (!currentUrl.includes(new URL(denWebUrl()).host)) {
    await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
  }
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "Den web loaded" });
  await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
  await openAdminConnections(ctx);
  await ctx.waitFor(`(() => {
    const leaf = [...document.querySelectorAll('p, span')]
      .find((entry) => (entry.textContent ?? '').trim() === ${JSON.stringify(state.connectionName)});
    if (!leaf) return false;
    leaf.scrollIntoView({ block: 'center' });
    return true;
  })()`, { timeoutMs: 30_000, label: "Incident Response MCP row" });
}

function connectionRowScript(action) {
  return `(() => {
    const leaf = [...document.querySelectorAll('p, span')]
      .find((entry) => (entry.textContent ?? '').trim() === ${JSON.stringify(state.connectionName)});
    let row = leaf;
    for (let depth = 0; depth < 8 && row; depth += 1) {
      const button = [...row.querySelectorAll('button')]
        .find((entry) => (entry.textContent ?? '').replace(/\\s+/g, ' ').trim() === 'View tools');
      if (button) {
        if (button.disabled) return false;
        row.scrollIntoView({ block: 'center' });
        ${action === "click" ? "button.click();" : ""}
        return true;
      }
      row = row.parentElement;
    }
    return false;
  })()`;
}

export default {
  id: FLOW_ID,
  title: "Admins can inspect a connected MCP's live tools, inputs, and schemas without executing anything",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "The existing connection row gains a safe discovery action",
      run: async (ctx) => {
        await ctx.prove("A connected MCP exposes View tools in the existing Connections workflow", {
          voiceover: vo[0],
          action: async () => {
            if (ctx.client?.send) {
              await ctx.client.send("Emulation.setDeviceMetricsOverride", {
                width: 1440,
                height: 1000,
                deviceScaleFactor: 1,
                mobile: false,
              });
            }
            await ensureConnection(ctx);
            await navigateToConnections(ctx);
            const openedMenu = await ctx.eval(`(() => {
              const button = document.querySelector('[data-testid="mcp-connection-more-${state.connectionId}"]');
              button?.click();
              return Boolean(button);
            })()`);
            witness(ctx, openedMenu, "Alex opens the connection actions menu.", { openedMenu });
            await ctx.waitFor(`(() => {
              const menu = document.querySelector('[aria-label="Actions for ${state.connectionName}"]');
              return (menu?.textContent ?? '').includes('View tools');
            })()`, { timeoutMs: 10_000, label: "View tools menu action" });
          },
          assert: async () => {
            const hasAction = await ctx.eval(connectionRowScript("find"));
            witness(ctx, hasAction, "The connected Incident Response MCP has a View tools action.", { hasAction });
            witness(ctx, !state.observedMethods.includes("tools/list"), "Merely viewing the connection does not read or execute its tool catalog.", state.observedMethods);
            witness(ctx, !state.observedMethods.includes("tools/call"), "No MCP tool has been executed.", state.observedMethods);
          },
          screenshot: {
            name: "connected-mcp-view-tools",
            requireText: ["Connections", "Incident Response MCP", "View tools", "Connected"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/dashboard/mcp-connections",
          },
        });
      },
    },
    {
      name: "Live tool names and descriptions appear without execution",
      run: async (ctx) => {
        await ctx.prove("The dashboard reads live tools/list data and states that inspection does not run a tool", {
          voiceover: vo[1],
          action: async () => {
            const clicked = await ctx.eval(connectionRowScript("click"));
            witness(ctx, clicked, "Alex can open the MCP's tool catalog from its row.", { clicked });
            await ctx.waitFor(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              return (catalog?.textContent ?? '').includes('search_incidents')
                && (catalog?.textContent ?? '').includes('create_postmortem');
            })()`, { timeoutMs: 30_000, label: "live MCP tool catalog" });
            const initialListCount = state.observedMethods.filter((method) => method === "tools/list").length;
            const refreshed = await ctx.eval(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              const button = [...(catalog?.querySelectorAll('button') ?? [])]
                .find((entry) => (entry.textContent ?? '').trim() === 'Refresh');
              button?.click();
              return Boolean(button);
            })()`);
            witness(ctx, refreshed, "Alex can explicitly refresh the live catalog.", { refreshed });
            await waitForObserved("tools/list", initialListCount + 1);
            const searched = await ctx.eval(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              const input = catalog?.querySelector('input[aria-label="Search MCP tools"]');
              if (!input) return false;
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              setter?.call(input, 'postmortem');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            })()`);
            witness(ctx, searched, "Alex can search a large MCP catalog by tool name or description.", { searched });
            await ctx.waitFor(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              const text = catalog?.textContent ?? '';
              return text.includes('1 of 2 tools') && text.includes('create_postmortem') && !text.includes('search_incidents');
            })()`, { timeoutMs: 10_000, label: "filtered MCP tool catalog" });
            const cleared = await ctx.eval(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              const input = catalog?.querySelector('input[aria-label="Search MCP tools"]');
              if (!input) return false;
              const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
              setter?.call(input, '');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              return true;
            })()`);
            witness(ctx, cleared, "Alex can clear the catalog search.", { cleared });
            await ctx.waitFor(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              return (catalog?.textContent ?? '').includes('2 tools exposed');
            })()`, { timeoutMs: 10_000, label: "complete MCP tool catalog" });
            await ctx.eval(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              catalog?.scrollIntoView({ block: 'center' });
              return Boolean(catalog);
            })()`);
          },
          assert: async () => {
            await ctx.expectText("Tools available to your agents");
            await ctx.expectText("Inspecting this list does not run a tool.");
            await ctx.expectText("Provider annotations are hints, not guarantees.");
            await ctx.expectText("2 tools exposed");
            await ctx.expectText("Search incidents by query and optional status.");
            const listCount = state.observedMethods.filter((method) => method === "tools/list").length;
            witness(ctx, listCount >= 2, "Opening and refreshing the catalog use tools/list.", { listCount, methods: state.observedMethods });
            witness(ctx, !state.observedMethods.includes("tools/call"), "Opening and refreshing the catalog never send tools/call.", state.observedMethods);
          },
          screenshot: {
            name: "live-mcp-tool-catalog",
            requireText: [
              "Tools available to your agents",
              "Inspecting this list does not run a tool.",
              "Provider annotations are hints, not guarantees.",
              "2 tools exposed",
              "search_incidents",
              "create_postmortem",
              "2 inputs",
            ],
            rejectText: ["Could not read this MCP's tools"],
            hashIncludes: "/dashboard/mcp-connections",
          },
        });
      },
    },
    {
      name: "Inputs and the complete provider schema are understandable",
      run: async (ctx) => {
        await ctx.prove("A tool expands into required inputs, basic types, and its full provider schema", {
          voiceover: vo[2],
          action: async () => {
            const expanded = await ctx.eval(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              const tool = [...(catalog?.querySelectorAll('details') ?? [])]
                .find((entry) => (entry.querySelector(':scope > summary')?.textContent ?? '').includes('search_incidents'));
              if (!tool) return false;
              tool.open = true;
              const schema = [...tool.querySelectorAll('details')]
                .find((entry) => (entry.querySelector(':scope > summary')?.textContent ?? '').includes('View input schema'));
              if (schema) schema.open = true;
              tool.scrollIntoView({ block: 'center' });
              return Boolean(schema);
            })()`);
            witness(ctx, expanded, "Alex can expand the tool and its complete input schema.", { expanded });
            await ctx.waitFor("document.body.innerText.includes('query: string · required') && document.body.innerText.includes('status: string')", {
              timeoutMs: 10_000,
              label: "typed required and optional inputs",
            });
          },
          assert: async () => {
            await ctx.expectText("query: string · required");
            await ctx.expectText("status: string");
            await ctx.expectText("Read-only hint");
            await ctx.expectText("View output schema");
            await ctx.expectText("additionalProperties");
            witness(ctx, !state.observedMethods.includes("tools/call"), "Inspecting descriptions, inputs, and JSON Schema still never executes a tool.", state.observedMethods);
          },
          screenshot: {
            name: "mcp-tool-input-schema",
            requireText: ["search_incidents", "Read-only hint", "query: string · required", "status: string", "View input schema", "View output schema", "additionalProperties"],
            rejectText: ["This proof must never execute a tool"],
            hashIncludes: "/dashboard/mcp-connections",
          },
        });

      },
    },
    {
      name: "An admin disables one tool without disconnecting the MCP",
      run: async (ctx) => {
        await ctx.prove("The edit dialog lets an organization admin disable one tool while leaving the rest available", {
          voiceover: vo[3],
          action: async () => {
            const openedMenu = await ctx.eval(`(() => {
              const button = document.querySelector('[data-testid="mcp-connection-more-${state.connectionId}"]');
              button?.click();
              return Boolean(button);
            })()`);
            witness(ctx, openedMenu, "Alex opens the connection actions menu.", { openedMenu });
            await ctx.waitFor(`Boolean(document.querySelector('[data-testid="edit-mcp-connection-${state.connectionId}"]'))`, { timeoutMs: 10_000, label: "Edit MCP action" });
            const opened = await ctx.eval(`(() => {
              const button = document.querySelector('[data-testid="edit-mcp-connection-${state.connectionId}"]');
              button?.click();
              return Boolean(button);
            })()`);
            witness(ctx, opened, "Alex opens the existing MCP connection for editing.", { opened });
            await ctx.waitFor("Boolean(document.querySelector('[data-testid=\"edit-mcp-connection-dialog\"]'))", { timeoutMs: 10_000, label: "MCP edit dialog" });
            await ctx.waitFor(`(() => {
              const policy = document.querySelector('[data-testid="edit-mcp-tool-policy"]');
              return (policy?.textContent ?? '').includes('search_incidents')
                && (policy?.textContent ?? '').includes('create_postmortem');
            })()`, { timeoutMs: 30_000, label: "editable MCP tool policy" });
            const toggled = await ctx.eval(`(() => {
              const policy = document.querySelector('[data-testid="edit-mcp-tool-policy"]');
              const button = [...(policy?.querySelectorAll('button') ?? [])]
                .find((entry) => (entry.textContent ?? '').includes('create_postmortem'));
              button?.click();
              button?.scrollIntoView({ block: 'center' });
              return Boolean(button);
            })()`);
            witness(ctx, toggled, "Alex selects create_postmortem in the tool policy.", { toggled });
            await ctx.waitFor(`(() => {
              const policy = document.querySelector('[data-testid="edit-mcp-tool-policy"]');
              const button = [...(policy?.querySelectorAll('button') ?? [])]
                .find((entry) => (entry.textContent ?? '').includes('create_postmortem'));
              return button?.getAttribute('aria-pressed') === 'false';
            })()`, { timeoutMs: 10_000, label: "create_postmortem disabled" });
          },
          assert: async () => {
            const states = await ctx.eval(`(() => {
              const policy = document.querySelector('[data-testid="edit-mcp-tool-policy"]');
              return [...(policy?.querySelectorAll('button[aria-pressed]') ?? [])].map((button) => ({
                text: (button.textContent ?? '').replace(/\\s+/g, ' ').trim(),
                pressed: button.getAttribute('aria-pressed'),
              }));
            })()`);
            witness(ctx, states.some((entry) => entry.text.includes("create_postmortem") && entry.pressed === "false"), "create_postmortem is selected as disabled.", states);
            witness(ctx, states.some((entry) => entry.text.includes("search_incidents") && entry.pressed === "true"), "search_incidents remains enabled.", states);
            witness(ctx, !state.observedMethods.includes("tools/call"), "Changing tool policy still never executes a provider tool.", state.observedMethods);
          },
          screenshot: {
            name: "disable-one-mcp-tool",
            requireText: ["Edit MCP connection", "Available tools", "search_incidents", "create_postmortem", "Enabled", "Disabled", "Save changes"],
            rejectText: ["Could not test this MCP connection"],
            hashIncludes: "/dashboard/mcp-connections",
          },
        });
      },
    },
    {
      name: "The saved policy is visible and enforced for agents",
      run: async (ctx) => {
        await ctx.prove("Den persists the disabled tool, hides it from capability search, and rejects direct execution", {
          voiceover: vo[4],
          action: async () => {
            const saved = await ctx.eval(`(() => {
              const dialog = document.querySelector('[data-testid="edit-mcp-connection-dialog"]');
              const button = [...(dialog?.querySelectorAll('button') ?? [])]
                .find((entry) => (entry.textContent ?? '').trim() === 'Save changes');
              button?.click();
              return Boolean(button);
            })()`);
            witness(ctx, saved, "Alex saves the updated tool policy.", { saved });
            await ctx.waitFor("!document.querySelector('[data-testid=\"edit-mcp-connection-dialog\"]')", { timeoutMs: 30_000, label: "tool policy saved" });
            await ctx.waitFor(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              return (catalog?.textContent ?? '').includes('create_postmortem')
                && (catalog?.textContent ?? '').includes('Disabled');
            })()`, { timeoutMs: 30_000, label: "disabled tool badge in live catalog" });
            await ctx.eval(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog="${state.connectionId}"]');
              catalog?.scrollIntoView({ block: 'center' });
              return Boolean(catalog);
            })()`);
          },
          assert: async () => {
            const listed = await denApiFetch("/v1/mcp-connections?scope=manageable", {
              headers: { authorization: `Bearer ${state.adminToken}` },
            });
            const connection = (listed.body.connections ?? []).find((entry) => entry.id === state.connectionId);
            witness(ctx, connection?.disabledToolNames?.includes("create_postmortem"), "Den persisted create_postmortem in the organization deny-list.", connection?.disabledToolNames);

            const mcpToken = await mintMcpToken(state.adminToken, ctx);
            const search = await mcpAgentCall(mcpToken, "tools/call", {
              name: "search_capabilities",
              arguments: { query: "postmortem" },
            }, ctx);
            const searchText = String(search.content?.[0]?.text ?? "");
            witness(ctx, !searchText.includes(`mcp:${state.connectionId}:create_postmortem`), "Capability search no longer exposes the disabled tool.", searchText);

            const execution = await mcpAgentCall(mcpToken, "tools/call", {
              name: "execute_capability",
              arguments: { name: `mcp:${state.connectionId}:create_postmortem`, body: { incidentId: "INC-42" } },
            }, ctx);
            const executionText = String(execution.content?.[0]?.text ?? "");
            witness(ctx, execution.isError === true && executionText.includes("disabled"), "A forged direct execution is rejected by Den before tools/call reaches the provider.", execution);
            witness(ctx, !state.observedMethods.includes("tools/call"), "The disabled provider tool was never invoked.", state.observedMethods);
          },
          screenshot: {
            name: "disabled-mcp-tool-enforced",
            requireText: ["Tools available to your agents", "search_incidents", "create_postmortem", "Enabled", "Disabled"],
            rejectText: ["Could not read this MCP's tools", "This proof must never execute a tool"],
            hashIncludes: "/dashboard/mcp-connections",
          },
        });

        if (state.connectionId) {
          await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${state.adminToken}` },
          });
        }
        state.server?.close();
      },
    },
  ],
};
