import { journeys } from "../runner/journeys/index.mjs";
import { denWebUrl } from "../runner/journeys/den.mjs";
import { defineScenario } from "../runner/scenario.mjs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "mcp-connect-reliability";
const REQUIRED_DEN_ENV = ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"];
const USABLE_ECHO_TEXT = "ui connected usable proof";
const RELOAD_ECHO_TEXT = "reload mcp reliability proof";
const RECONNECT_ECHO_TEXT = "reconnect mcp reliability proof";
const DIRECT_ECHO_TEXT = "direct mcp reliability proof";
const AGENT_ECHO_TEXT = "agent mcp reliability proof";
const MCP_CONNECTIONS_SCREEN_READY = "document.body.innerText.includes('Connectors') || document.body.innerText.includes('Add MCP') || document.body.innerText.includes('MCP Connections') || document.body.innerText.includes('Add a custom MCP server')";

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error(`Missing approved voice-over script for ${FLOW_ID}.`);

const { den, mcp } = journeys;

function safeJson(value) {
  try {
    return JSON.stringify(value).slice(0, 1_200);
  } catch {
    return String(value).slice(0, 1_200);
  }
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${safeJson(actual)}`}`);
}

function cleanStamp(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "run";
}

function uniqueOrgName(ctx) {
  const stamp = ctx.env.OPENWORK_EVAL_RUNSTAMP?.trim() || new Date().toISOString();
  return `MCP Reliability ${cleanStamp(stamp)}`;
}

function connectionPrefix(ctx) {
  const stamp = ctx.env.OPENWORK_EVAL_RUNSTAMP?.trim() || "run";
  return `reliability-mcp-${cleanStamp(stamp)}`;
}

function stateString(ctx, key) {
  const value = ctx.state[key];
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`Scenario state ${key} was not set.`);
}

function mockBase(ctx) {
  const fixtureUrl = typeof ctx.state.mockMcpUrl === "string" ? ctx.state.mockMcpUrl : "";
  return (fixtureUrl || ctx.env.MOCK_OAUTH_MCP_URL?.trim() || ctx.env.OPENWORK_EVAL_MOCK_URL?.trim() || "http://127.0.0.1:3978").replace(/\/+$/, "");
}

function reconnectMcpUrl(ctx) {
  const stamp = cleanStamp(ctx.env.OPENWORK_EVAL_RUNSTAMP?.trim() || new Date().toISOString());
  return `${mockBase(ctx)}/mcp?reconnect=${encodeURIComponent(stamp)}`;
}

async function stopMockFixture(ctx) {
  const fixture = ctx.state.mockMcpFixture;
  if (!fixture || typeof fixture !== "object" || typeof fixture.stop !== "function") return;
  await fixture.stop();
  delete ctx.state.mockMcpFixture;
}

async function navigateDen(ctx, path) {
  const url = new URL(path, `${denWebUrl(ctx)}/`).toString();
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(url)}; return true; })()`);
  await ctx.waitFor(`window.location.pathname === ${JSON.stringify(new URL(url).pathname)}`, {
    timeoutMs: 60_000,
    label: `route ${path}`,
  });
  await ctx.waitFor("document.readyState === 'complete' || document.body.innerText.length > 0", {
    timeoutMs: 60_000,
    label: `load ${path}`,
  });
}

function toolName(tool) {
  return typeof tool?.name === "string" ? tool.name : "";
}

function selectMockEchoMatch(ctx, matches) {
  const connectionId = stateString(ctx, "connectionId");
  const connectionName = stateString(ctx, "connectionName");
  return matches.find((match) => match.name === `mcp:${connectionId}:mock_echo`)
    ?? matches.find((match) => match.name.includes(connectionId) && match.name.endsWith("mock_echo"))
    ?? matches.find((match) => match.summary.includes(connectionName) && match.name.endsWith("mock_echo"))
    ?? matches.find((match) => match.name.endsWith("mock_echo"));
}

async function showMcpConnections(ctx, surface) {
  await ctx.on(surface, async () => {
    if (await ctx.eval("window.location.pathname.includes('/dashboard/mcp-connections')")) {
      await navigateDen(ctx, "/dashboard");
    }
    await navigateDen(ctx, "/dashboard/mcp-connections");
    await ctx.waitFor(MCP_CONNECTIONS_SCREEN_READY, {
      timeoutMs: 60_000,
      label: "MCP Connections screen",
    });
  });
}

async function scrollConnectionIntoView(ctx, connectionName) {
  await ctx.eval(`(() => {
    const connectionName = ${JSON.stringify(connectionName)};
    const target = [...document.querySelectorAll('main *')]
      .find((element) => {
        const text = (element.textContent ?? '').trim();
        return text.includes(connectionName) && text.length < connectionName.length + 360;
      });
    target?.scrollIntoView({ block: 'center', inline: 'nearest' });
    return Boolean(target);
  })()`);
  await ctx.waitFor(`(() => {
    const connectionName = ${JSON.stringify(connectionName)};
    const target = [...document.querySelectorAll('main *')]
      .find((element) => {
        const text = (element.textContent ?? '').trim();
        return text.includes(connectionName) && text.length < connectionName.length + 360;
      });
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= window.innerHeight;
  })()`, { timeoutMs: 10_000, label: `visible row for ${connectionName}` });
}

async function connectionRowText(ctx, connectionName) {
  const result = await ctx.eval(`(() => {
    const normalize = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const connectionName = ${JSON.stringify(connectionName)};
    const target = [...document.querySelectorAll('[data-testid^="mcp-connection-row-"]')]
      .find((element) => normalize(element.textContent).includes(connectionName));
    return normalize(target?.textContent ?? '');
  })()`);
  return typeof result === "string" ? result : "";
}

async function expectLiveToolFailure(ctx, expectedText) {
  try {
    await mcp.runConnectionTool(ctx, {
      actor: ctx.actors.alex,
      organizationId: stateString(ctx, "orgId"),
      connectionId: stateString(ctx, "connectionId"),
      toolName: "mock_echo",
      arguments: { text: expectedText },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.output("disconnected-live-mcp-result", message);
    return message;
  }
  throw new Error("MCP tool call unexpectedly succeeded after disconnect.");
}

export default defineScenario({
  id: FLOW_ID,
  title: "Cloud MCP reliability: connected no-auth server works through direct and agent paths",
  kind: "user-facing",
  requiresApp: false,
  stage: { den: { orgMode: "multi_org" } },
  actors: {
    alex: "owner",
  },
  requiredEnv: REQUIRED_DEN_ENV,
  steps: [
    {
      name: "Alex creates an isolated MCP workspace",
      run: async (ctx) => {
        const alexWeb = await ctx.surfaces.chrome("mcp-admin-web", { startUrl: denWebUrl(ctx), headless: true });
        await ctx.on(alexWeb, async () => {
          await ctx.prove("Alex creates and opens a fresh Den workspace for MCP reliability", {
            voiceover: vo[0],
            action: async () => {
              const created = await den.createOrg(ctx, { surface: alexWeb, actor: ctx.actors.alex, name: uniqueOrgName(ctx) });
              witness(ctx, Boolean(created.orgId), "Created organization has an id", created);
              ctx.state.orgId = created.orgId;
              ctx.state.orgName = created.name;
              await showMcpConnections(ctx, alexWeb);
            },
            assert: async () => {
              await ctx.expectText("Add MCP", { timeoutMs: 60_000 });
              witness(ctx, stateString(ctx, "orgName").startsWith("MCP Reliability"), "The run uses an isolated MCP reliability org", stateString(ctx, "orgName"));
            },
            screenshot: { name: "mcp-admin-connections", requireText: ["Add MCP"], rejectText: ["Something went wrong"] },
          });
        });
      },
    },
    {
      name: "Alex publishes the mock MCP connection",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("mcp-admin-web");
        await ctx.on(alexWeb, async () => {
          await ctx.prove("A no-auth mock MCP server is saved org-wide and shown as Connected", {
            voiceover: vo[1],
            action: async () => {
              const fixture = await mcp.startMockMcpServer(ctx);
              ctx.state.mockMcpFixture = fixture;
              ctx.state.mockMcpUrl = fixture.url;
              const health = await fetch(`${mockBase(ctx)}/health`).catch(() => null);
              witness(ctx, Boolean(health?.ok), `Mock MCP server is reachable at ${mockBase(ctx)}`);
              const prefix = connectionPrefix(ctx);
              await mcp.deleteConnectionsByPrefix(ctx, { actor: ctx.actors.alex, organizationId: stateString(ctx, "orgId"), prefix });
              const connectionName = `${prefix}-echo`;
              const created = await mcp.createNoAuthConnection(ctx, {
                actor: ctx.actors.alex,
                organizationId: stateString(ctx, "orgId"),
                name: connectionName,
                url: `${mockBase(ctx)}/mcp`,
                access: { orgWide: true },
              });
              ctx.state.connectionId = created.id;
              ctx.state.connectionName = created.name;
              const connected = await mcp.waitForConnectionConnected(ctx, {
                actor: ctx.actors.alex,
                organizationId: stateString(ctx, "orgId"),
                connectionId: created.id,
              });
              witness(ctx, connected.connected && connected.connectedForMe, "The no-auth MCP connection is connected for the admin", connected);
              await showMcpConnections(ctx, alexWeb);
            },
            assert: async () => {
              const connectionName = stateString(ctx, "connectionName");
              await ctx.expectText(connectionName, { timeoutMs: 60_000 });
              await ctx.expectText("Connected", { timeoutMs: 60_000 });
              await scrollConnectionIntoView(ctx, connectionName);
              if (ctx.env.OPENWORK_EVAL_MCP_RELIABILITY_STOP_AFTER_CONNECT?.trim()) {
                await stopMockFixture(ctx);
              }
              const result = await mcp.expectUsableConnection(ctx, {
                actor: ctx.actors.alex,
                organizationId: stateString(ctx, "orgId"),
                connectionId: stateString(ctx, "connectionId"),
                connectionName: stateString(ctx, "connectionName"),
                uiConnected: true,
                expectedText: USABLE_ECHO_TEXT,
              });
              ctx.output("ui-live-mcp-result", mcp.mcpTextContent(result));
            },
            screenshot: { name: "mcp-connected", requireText: ["Connected"], rejectText: ["Something went wrong", "Connection failed"] },
          });
        });
      },
    },
    {
      name: "Connected MCP survives a Den Web reload",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("mcp-admin-web");
        await ctx.on(alexWeb, async () => {
          await ctx.prove("After a browser reload, Den Web still shows the connection and the live tool remains usable", {
            voiceover: vo[2],
            action: async () => {
              await ctx.eval("location.reload(); true");
              await ctx.waitFor("document.readyState === 'complete' || document.body.innerText.length > 0", {
                timeoutMs: 60_000,
                label: "MCP Connections reload",
              });
              await showMcpConnections(ctx, alexWeb);
              await scrollConnectionIntoView(ctx, stateString(ctx, "connectionName"));
            },
            assert: async () => {
              await ctx.expectText(stateString(ctx, "connectionName"), { timeoutMs: 60_000 });
              await ctx.expectText("Connected", { timeoutMs: 60_000 });
              const result = await mcp.expectUsableConnection(ctx, {
                actor: ctx.actors.alex,
                organizationId: stateString(ctx, "orgId"),
                connectionId: stateString(ctx, "connectionId"),
                connectionName: stateString(ctx, "connectionName"),
                uiConnected: true,
                expectedText: RELOAD_ECHO_TEXT,
              });
              ctx.output("reload-live-mcp-result", mcp.mcpTextContent(result));
            },
            screenshot: { name: "mcp-connected-after-reload", requireText: [stateString(ctx, "connectionName"), "Connected"], rejectText: ["Something went wrong", "Connection failed"] },
          });
        });
      },
    },
    {
      name: "Disconnect clears the usable MCP credential",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("mcp-admin-web");
        await ctx.on(alexWeb, async () => {
          await ctx.prove("Disconnecting keeps the row but makes the live tool call fail", {
            voiceover: vo[3],
            action: async () => {
              await mcp.disconnectConnection(ctx, {
                actor: ctx.actors.alex,
                organizationId: stateString(ctx, "orgId"),
                connectionId: stateString(ctx, "connectionId"),
              });
              await showMcpConnections(ctx, alexWeb);
              await scrollConnectionIntoView(ctx, stateString(ctx, "connectionName"));
            },
            assert: async () => {
              await ctx.expectText("Not connected", { timeoutMs: 60_000 });
              const connections = await mcp.listManageableConnections(ctx, {
                actor: ctx.actors.alex,
                organizationId: stateString(ctx, "orgId"),
              });
              const connection = connections.find((entry) => entry.id === stateString(ctx, "connectionId"));
              witness(ctx, connection?.connected === false && connection.connectedForMe === false, "Disconnected MCP connection is no longer connected in the API", connection);
              const failure = await expectLiveToolFailure(ctx, "disconnected mcp reliability proof");
              witness(ctx, failure.includes("connection_not_ready") || failure.includes("Connect this MCP") || failure.includes("409"), "Live MCP tool call fails after disconnect", failure);
            },
            screenshot: { name: "mcp-disconnected", requireText: [stateString(ctx, "connectionName"), "Not connected"], rejectText: ["Something went wrong", "Connection failed"] },
          });
        });
      },
    },
    {
      name: "Reconnect restores the live MCP tool",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("mcp-admin-web");
        await ctx.on(alexWeb, async () => {
          await ctx.prove("Revalidating the no-auth server reconnects the same row and restores live tool execution", {
            voiceover: vo[4],
            action: async () => {
              const reconnected = await mcp.reconnectNoAuthConnection(ctx, {
                actor: ctx.actors.alex,
                organizationId: stateString(ctx, "orgId"),
                connectionId: stateString(ctx, "connectionId"),
                url: reconnectMcpUrl(ctx),
              });
              witness(ctx, reconnected.connected && reconnected.connectedForMe, "No-auth MCP reconnect reports connected", reconnected);
              await showMcpConnections(ctx, alexWeb);
              await scrollConnectionIntoView(ctx, stateString(ctx, "connectionName"));
            },
            assert: async () => {
              await ctx.expectText("Connected", { timeoutMs: 60_000 });
              const result = await mcp.expectUsableConnection(ctx, {
                actor: ctx.actors.alex,
                organizationId: stateString(ctx, "orgId"),
                connectionId: stateString(ctx, "connectionId"),
                connectionName: stateString(ctx, "connectionName"),
                uiConnected: true,
                expectedText: RECONNECT_ECHO_TEXT,
              });
              ctx.output("reconnect-live-mcp-result", mcp.mcpTextContent(result));
            },
            screenshot: { name: "mcp-reconnected", requireText: [stateString(ctx, "connectionName"), "Connected"], rejectText: ["Not connected", "Something went wrong", "Connection failed"] },
          });
        });
      },
    },
    {
      name: "Never-connected OAuth MCP asks to connect, not reconnect",
      run: async (ctx) => {
        const alexWeb = ctx.surfaces.get("mcp-admin-web");
        await ctx.on(alexWeb, async () => {
          const neverName = `${connectionPrefix(ctx)}-never-connected`;
          await ctx.prove("A newly published OAuth MCP row shows a first-time Connect state without a false reconnect prompt", {
            voiceover: vo[5],
            action: async () => {
              const created = await mcp.createOAuthConnection(ctx, {
                actor: ctx.actors.alex,
                organizationId: stateString(ctx, "orgId"),
                name: neverName,
                url: `${mockBase(ctx)}/mcp`,
                access: { orgWide: true },
              });
              ctx.state.neverConnectionId = created.id;
              ctx.state.neverConnectionName = created.name;
              witness(ctx, created.connected === false && created.connectedForMe === false, "Never-connected OAuth MCP starts disconnected", created);
              await showMcpConnections(ctx, alexWeb);
              await scrollConnectionIntoView(ctx, stateString(ctx, "neverConnectionName"));
            },
            assert: async () => {
              const row = await connectionRowText(ctx, stateString(ctx, "neverConnectionName"));
              witness(ctx, row.includes("Not connected") && row.includes("Connect"), "Never-connected MCP row offers first-time Connect", row);
              witness(ctx, !row.includes("Reconnect") && !row.toLowerCase().includes("needs your sign-in"), "Never-connected MCP row does not show a false reconnect prompt", row);
            },
            screenshot: { name: "mcp-never-connected", requireText: [neverName, "Not connected", "Connect"], rejectText: ["Reconnect required", "needs your sign-in", "needs your sign in", "Connection failed"] },
          });
        });
      },
    },
    {
      name: "Direct MCP catalog and tool call work",
      run: async (ctx) => {
        await ctx.prove("The direct Den MCP connection endpoints list and execute mock_echo", {
          voiceover: vo[6],
          action: async () => {
            const tools = await mcp.listConnectionTools(ctx, {
              actor: ctx.actors.alex,
              organizationId: stateString(ctx, "orgId"),
              connectionId: stateString(ctx, "connectionId"),
            });
            const names = tools.map((tool) => toolName(tool)).filter(Boolean);
            witness(ctx, names.includes("mock_echo"), "The live MCP tool catalog includes mock_echo", names);
            const result = await mcp.runConnectionTool(ctx, {
              actor: ctx.actors.alex,
              organizationId: stateString(ctx, "orgId"),
              connectionId: stateString(ctx, "connectionId"),
              toolName: "mock_echo",
              arguments: { text: DIRECT_ECHO_TEXT },
            });
            const text = mcp.mcpTextContent(result);
            ctx.state.directEcho = text;
            ctx.output("direct-mcp-result", text);
          },
          assert: async () => {
            witness(ctx, stateString(ctx, "directEcho").includes(DIRECT_ECHO_TEXT), "Direct MCP tool execution echoes the proof text", stateString(ctx, "directEcho"));
          },
        });
      },
    },
    {
      name: "Agent search and execute use the same connection",
      run: async (ctx) => {
        await ctx.prove("search_capabilities and execute_capability find and run mock_echo", {
          voiceover: vo[7],
          action: async () => {
            const mcpToken = await mcp.mintMcpToken(ctx, {
              actor: ctx.actors.alex,
              organizationId: stateString(ctx, "orgId"),
              scopes: ["mcp:read", "mcp:write"],
            });
            const matches = await mcp.searchCapabilities(ctx, {
              actor: ctx.actors.alex,
              organizationId: stateString(ctx, "orgId"),
              mcpToken,
              query: "mock echo",
              limit: 10,
              type: "mcp",
            });
            const match = selectMockEchoMatch(ctx, matches);
            witness(ctx, Boolean(match?.name), "search_capabilities finds the mock_echo capability", matches.map((entry) => ({ name: entry.name, summary: entry.summary, schemaDigest: entry.schemaDigest })));
            ctx.state.matchName = match.name;
            const result = await mcp.executeCapability(ctx, {
              actor: ctx.actors.alex,
              organizationId: stateString(ctx, "orgId"),
              mcpToken,
              name: match.name,
              schemaDigest: match.schemaDigest,
              body: { text: AGENT_ECHO_TEXT },
            });
            const text = mcp.mcpTextContent(result);
            ctx.state.agentEcho = text;
            ctx.output("agent-mcp-result", text);
          },
          assert: async () => {
            witness(ctx, stateString(ctx, "agentEcho").includes(AGENT_ECHO_TEXT), "execute_capability echoes the proof text", stateString(ctx, "agentEcho"));
          },
        });
      },
    },
    {
      name: "Cleanup and desktop gate",
      run: async (ctx) => {
        await ctx.prove("Cleanup removes the MCP connection and the desktop cell is explicitly skipped", {
          voiceover: vo[8],
          action: async () => {
            await mcp.deleteConnectionsByPrefix(ctx, {
              actor: ctx.actors.alex,
              organizationId: stateString(ctx, "orgId"),
              prefix: connectionPrefix(ctx),
            });
            const desktopGate = ctx.env.OPENWORK_EVAL_DESKTOP_SURFACE?.trim() ? "requested" : "not requested";
            ctx.skip(`Electron desktop surface ${desktopGate}; ${FLOW_ID} is intentionally web-only.`);
            ctx.output("desktop-surface-gate", `OPENWORK_EVAL_DESKTOP_SURFACE=${ctx.env.OPENWORK_EVAL_DESKTOP_SURFACE ?? ""}`);
            await stopMockFixture(ctx);
          },
          assert: async () => {
            const connections = await mcp.listManageableConnections(ctx, {
              actor: ctx.actors.alex,
              organizationId: stateString(ctx, "orgId"),
            });
            witness(ctx, !connections.some((connection) => connection.id === stateString(ctx, "connectionId")), "Temporary MCP connection is removed during cleanup", connections.map((connection) => ({ id: connection.id, name: connection.name })));
          },
        });
      },
    },
  ],
});
