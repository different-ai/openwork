/**
 * The full "search and execute as the main entry point" loop, proven
 * end-to-end through the real den-web "MCP Connections" screen — not a
 * script hitting den-api directly. A real admin action in a real browser:
 *
 *   1. Sign in to den-web (real email+password flow).
 *   2. Open Settings -> MCP Connections (a brand-new Den screen).
 *   3. Choose "MCP server", fill in a real MCP server URL, inspect its
 *      advertised setup, and submit.
 *   4. A real browser popup opens for OAuth; the target server (a
 *      self-controlled stand-in that speaks the full MCP OAuth protocol —
 *      RFC 9728 discovery, RFC 7591 dynamic client registration, PKCE)
 *      shows consent (or auto-approves) and redirects to Den's real callback,
 *      which performs a real, PKCE-verified token exchange.
 *   5. Back in the original tab, Den's own polling (no test-only code path)
 *      picks up the new "Connected" status by itself.
 *   6. Only then: confirm via Den's MCP surface that search_capabilities
 *      finds the connection's real tool and execute_capability really
 *      calls it — proving org admins configuring a connection in Den is
 *      genuinely enough for the harness (search_capabilities/
 *      execute_capability) to use it, with zero desktop-side setup.
 *
 * Unlike the Electron-based flows in this directory, this one drives a
 * plain den-web page (Next.js, real path routing, no window.__openworkControl),
 * so it skips ensureLightMode() (preserveTheme: true) and uses ctx.eval to
 * navigate instead of navigateHash.
 *
 * Prerequisites:
 * - den-api reachable at OPENWORK_EVAL_DEN_API_URL, signed in with
 *   OPENWORK_EVAL_DEMO_EMAIL / OPENWORK_EVAL_DEMO_PASSWORD (defaults to the
 *   seeded demo owner).
 * - den-web reachable at OPENWORK_EVAL_DEN_WEB_URL, pointed at that den-api.
 * - The mock OAuth+MCP server running and reachable at
 *   MOCK_OAUTH_MCP_URL (default http://127.0.0.1:3978) from wherever den-api
 *   runs — for a cloud/Daytona run this must be a URL den-api's own network
 *   can reach, not just the browser's.
 * - --cdp-url pointed at a real Chrome/Chromium instance with
 *   --disable-popup-blocking (the OAuth step opens a real new tab; Chrome's
 *   default popup blocker would otherwise silently drop it, same as it
 *   would for a real user without this flag — this is a test-runner
 *   accommodation, not a product behavior change).
 */

import { denApiFetch, denWebUrl, mcpAgentCall, mintMcpToken, openAdminConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";
import { listTargets } from "../runner/cdp.mjs";

const DEMO_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const DEMO_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const CONNECTION_NAME = `fraimz-mcp-${Date.now()}`;
const ECHO_TEXT = "search and execute in the cloud proof";
let mockRequestOffset = 0;
let mockAutoApprove = true;
let oauthPopupTargetId = null;

async function readMockRequests(ctx) {
  const response = await fetch(`${MOCK_SERVER_URL}/requests`);
  ctx.assert(response.ok, `Could not read mock OAuth+MCP requests: ${response.status}`);
  const payload = await response.json();
  ctx.assert(Array.isArray(payload.requests), "Mock OAuth+MCP request log was not an array.");
  return payload.requests;
}

async function currentRunMockRequests(ctx) {
  return (await readMockRequests(ctx)).slice(mockRequestOffset);
}

export default {
  id: "mcp-connections-cloud-oauth",
  title: "Admin adds an MCP connection in Den; search_capabilities/execute_capability use it for real",
  spec: "evals/cloud-mcp-agent-flows.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "den-web and the mock OAuth+MCP server are reachable",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        ctx.assert(Boolean(health?.ok), `Mock OAuth+MCP server not reachable at ${MOCK_SERVER_URL}.`);
        const mockHealth = await health.json();
        ctx.assert(typeof mockHealth.autoApprove === "boolean", "Mock OAuth+MCP health response omitted autoApprove mode.");
        mockAutoApprove = mockHealth.autoApprove;
        mockRequestOffset = (await readMockRequests(ctx)).length;
        const adminSession = await signInApi(DEMO_EMAIL, DEMO_PASSWORD);
        ctx.assert(Boolean(adminSession), `Den API sign-in failed for ${DEMO_EMAIL}.`);
        const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${adminSession}` },
        });
        ctx.assert(existing.response.ok, `Listing manageable connections failed: ${existing.response.status}`);
        for (const connection of existing.body.connections ?? []) {
          if (connection.name.startsWith("fraimz-mcp-")) {
            const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${adminSession}` },
            });
            ctx.assert(removed.response.ok, `Cleanup delete failed for leftover ${connection.id}.`);
          }
        }
        const webUrl = denWebUrl();
        await ctx.eval(`(() => { window.location.href = ${JSON.stringify(`${webUrl}/dashboard/mcp-connections`)}; return true; })()`);
        await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "den-web page loaded" });
      },
    },
    {
      name: "Sign in to den-web",
      run: async (ctx) => {
        // "Signed in" isn't enough — the browser may hold a NON-admin session
        // from another flow (e.g. mcp-connections-member-scoped signs in as a
        // member). This flow needs the admin's nav, so check for the
        // admin-gated MCP Connections link specifically.
        const signedInAsAdmin = (await ctx.hasText("Dashboard"))
          && (await ctx.eval("Boolean([...document.querySelectorAll('a')].find((a) => a.getAttribute('href')?.endsWith('/mcp-connections')))"));
        if (signedInAsAdmin) {
          ctx.log("Already signed in as an admin; reusing session.");
          return;
        }
        await signInViaBrowser(ctx, DEMO_EMAIL, DEMO_PASSWORD);
      },
    },
    {
      name: "Open Settings -> MCP Connections",
      run: async (ctx) => {
        await openAdminConnections(ctx);
        await ctx.prove("The Connections screen renders in Den", {
          assert: async () => {
            await ctx.expectText("Add a connection");
            await ctx.expectText("MCP server");
            await ctx.expectText("Connect one remote MCP server by URL.");
            await ctx.expectText("Plugin bundle");
          },
          screenshot: {
            name: "mcp-connections-screen",
            claim: "Den presents MCP server and plugin bundle entry points before opening the matching setup flow.",
            requireText: ["Add a connection", "MCP server", "Connect one remote MCP server by URL.", "Plugin bundle"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Add the mock server as a custom MCP connection",
      run: async (ctx) => {
        await ctx.prove("The MCP server setup inspects a real name and URL before configuration", {
          action: async () => {
            await ctx.clickText("MCP server", { timeoutMs: 20_000 });
            await ctx.waitFor(
              "Boolean(document.querySelector('input[placeholder=\"notion\"]'))",
              { timeoutMs: 10_000, label: "MCP server setup dialog" },
            );
            await ctx.fill('input[placeholder="notion"]', CONNECTION_NAME);
            await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', `${MOCK_SERVER_URL}/mcp`);
            const inspected = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll('button')]
                .find((entry) => (entry.textContent ?? '').trim() === 'Inspect');
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(inspected, "The MCP setup Inspect button was not found.");
            await ctx.waitFor(
              `(() => {
                const text = document.body?.innerText ?? '';
                return text.includes('Ready to configure')
                  && text.includes('automatic OAuth app registration')
                  && text.includes('REQUESTED OAUTH PERMISSIONS')
                  && text.includes('mcp:read')
                  && text.includes('mcp:write');
              })()`,
              { timeoutMs: 30_000, label: "discovered OAuth registration and scopes" },
            );
            const clicked = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent.trim() === 'One org account');
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(clicked, "One org account button was not found.");
          },
          assert: async () => {
            const values = await ctx.eval(`(() => ({
              name: document.querySelector('input[placeholder="notion"]')?.value ?? null,
              url: document.querySelector('input[placeholder="https://mcp.example.com/mcp"]')?.value ?? null,
              discovery: document.body?.innerText ?? '',
            }))()`);
            ctx.assert(values.name === CONNECTION_NAME, `Expected name input "${CONNECTION_NAME}", got "${values.name}"`);
            ctx.assert(values.url === `${MOCK_SERVER_URL}/mcp`, `Expected URL input "${MOCK_SERVER_URL}/mcp", got "${values.url}"`);
            ctx.assert(values.discovery.includes("OAuth"), "Discovery did not identify OAuth.");
            ctx.assert(values.discovery.includes("automatic OAuth app registration"), "Discovery did not identify dynamic client registration.");
            ctx.assert(values.discovery.includes("REQUESTED OAUTH PERMISSIONS"), "Discovery did not label the protected resource's advertised OAuth permissions.");
            ctx.assert(values.discovery.includes("mcp:read") && values.discovery.includes("mcp:write"), "Discovery did not surface advertised OAuth scopes.");
            const oauthClientInputs = await ctx.eval(`(() => [...document.querySelectorAll('input')]
              .filter((input) => ['Client secret', '1234567890.1234567890123'].includes(input.placeholder))
              .length)()`);
            ctx.assert(oauthClientInputs === 0, "Dynamic registration unexpectedly required a pre-registered OAuth client.");
          },
          screenshot: {
            name: "add-connection-filled",
            claim: "The MCP server dialog identifies OAuth, automatic client registration, and the protected resource's advertised permissions before saving.",
            requireText: ["Add a custom MCP server", "Ready to configure", "OAuth", "automatic OAuth app registration", "REQUESTED OAUTH PERMISSIONS", "mcp:read", "mcp:write"],
            rejectText: ["Something went wrong"],
          },
        });

        const beforeTargetIds = (await listTargets(ctx.cdpBaseUrl)).map((entry) => entry.id);
        await ctx.clickText("Add connection", { timeoutMs: 15_000 });
        const popupTarget = await ctx.switchToNewTab({ beforeTargetIds, timeoutMs: 20_000, label: "OAuth popup" });
        oauthPopupTargetId = popupTarget.id;
      },
    },
    {
      name: "A real browser popup opens for OAuth",
      run: async (ctx) => {
        if (!mockAutoApprove) {
          await ctx.prove("The real OAuth popup shows the provider's requested permissions before consent", {
            action: async () => {
              await ctx.waitForText("Mock MCP OAuth", { timeoutMs: 20_000 });
            },
            assert: async () => {
              await ctx.expectText("Requested scopes");
              await ctx.expectText("mcp:read");
              await ctx.expectText("mcp:write");
              await ctx.expectNoText("Connection failed");
            },
            screenshot: {
              name: "oauth-popup-consent",
              claim: "The provider popup displays the discovered MCP permissions before the admin approves access.",
              requireText: ["Mock MCP OAuth", "Requested scopes", "mcp:read", "mcp:write", "Approve OpenWork"],
              rejectText: ["Connection failed"],
            },
          });
          await ctx.clickText("Approve OpenWork", { selector: "button", timeoutMs: 10_000 });
        } else {
          ctx.log("Mock OAuth auto-approval is enabled; popup consent evidence is skipped.");
        }
        await ctx.switchBack();
      },
    },
    {
      name: "Den's own polling picks up the connected status with zero test-only code",
      run: async (ctx) => {
        await ctx.prove(`${CONNECTION_NAME} shows Connected in the den-web screen via Den's own polling`, {
          assert: async () => {
            await ctx.waitFor(
              `(() => {
                const rows = [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && (e.textContent ?? "").trim() === ${JSON.stringify(CONNECTION_NAME)});
                return rows.some((row) => {
                  let el = row;
                  for (let i = 0; i < 6 && el; i++) {
                    if ((el.textContent ?? "").includes("Connected")) return true;
                    el = el.parentElement;
                  }
                  return false;
                });
              })()`,
              { timeoutMs: 60_000, label: `${CONNECTION_NAME} shows Connected` },
            );
            await ctx.eval(`(() => {
              const row = [...document.querySelectorAll("*")].find((e) => e.children.length === 0 && (e.textContent ?? "").trim() === ${JSON.stringify(CONNECTION_NAME)});
              row?.scrollIntoView({ block: "center" });
              return Boolean(row);
            })()`);
            const requests = await currentRunMockRequests(ctx);
            const registrationIndex = requests.findIndex((entry) => entry.method === "POST" && entry.path === "/register");
            const authorizeIndex = requests.findIndex((entry) => entry.method === "GET" && entry.path === "/authorize");
            const tokenIndex = requests.findIndex((entry) => entry.method === "POST" && entry.path === "/token");
            ctx.assert(registrationIndex >= 0, `OAuth did not dynamically register a client: ${JSON.stringify(requests)}`);
            ctx.assert(
              requests[registrationIndex].body?.token_endpoint_auth_method === "client_secret_basic",
              `Dynamic registration did not request client_secret_basic: ${JSON.stringify(requests[registrationIndex])}`,
            );
            ctx.assert(authorizeIndex > registrationIndex, `OAuth authorization did not follow dynamic registration: ${JSON.stringify(requests)}`);
            ctx.assert(tokenIndex > authorizeIndex, `OAuth token exchange did not follow authorization: ${JSON.stringify(requests)}`);
            const authorizeUrl = new URL(requests[authorizeIndex].url, MOCK_SERVER_URL);
            const codeChallenge = authorizeUrl.searchParams.get("code_challenge") ?? "";
            const requestedScopes = new Set((authorizeUrl.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean));
            ctx.assert(authorizeUrl.searchParams.get("code_challenge_method") === "S256", "OAuth authorization did not require PKCE S256.");
            ctx.assert(codeChallenge.length >= 43, "OAuth authorization did not include a full PKCE code challenge.");
            ctx.assert(requestedScopes.has("mcp:read") && requestedScopes.has("mcp:write"), `OAuth authorization omitted advertised scopes: ${JSON.stringify([...requestedScopes])}`);
          },
          screenshot: {
            name: "den-web-shows-connected",
            claim: `${CONNECTION_NAME} shows Connected in Den, with no manual refresh or test-only trigger.`,
            requireText: [CONNECTION_NAME, "Connected"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "The connected MCP exposes its live tool catalog without executing a tool",
      run: async (ctx) => {
        await ctx.prove("The Connections screen reads tools/list and explains that inspection does not execute a tool", {
          action: async () => {
            const clicked = await ctx.eval(`(() => {
              const label = [...document.querySelectorAll('p')]
                .find((entry) => (entry.textContent ?? '').trim() === ${JSON.stringify(CONNECTION_NAME)});
              let row = label;
              while (row && ![...row.querySelectorAll('button')].some((button) => (button.textContent ?? '').includes('View tools'))) {
                row = row.parentElement;
              }
              const button = [...(row?.querySelectorAll('button') ?? [])]
                .find((entry) => (entry.textContent ?? '').includes('View tools'));
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(clicked, `View tools was not available for ${CONNECTION_NAME}.`);
            await ctx.waitFor(`(() => {
              const text = document.body?.innerText ?? '';
              return text.includes('Tools available to your agents')
                && text.includes('1 tool exposed')
                && text.includes('Mock Echo')
                && text.includes('mock_echo');
            })()`, { timeoutMs: 30_000, label: "live MCP tool catalog" });
            await ctx.eval(`(() => {
              const catalog = document.querySelector('[data-mcp-tool-catalog]');
              catalog?.scrollIntoView({ block: 'center' });
              return Boolean(catalog);
            })()`);
          },
          assert: async () => {
            await ctx.expectText("Inspecting this list does not run a tool.");
            await ctx.expectText("Echoes the provided text from the mock OAuth MCP server.");
            const requests = await currentRunMockRequests(ctx);
            ctx.assert(
              requests.some((entry) => entry.path === "/mcp" && entry.authorized === true && entry.rpcMethods?.includes("tools/list")),
              `Opening the catalog did not make an authenticated tools/list request: ${JSON.stringify(requests)}`,
            );
            ctx.assert(
              !requests.some((entry) => entry.path === "/mcp" && entry.rpcMethods?.includes("tools/call")),
              `Opening the catalog unexpectedly executed a tool: ${JSON.stringify(requests)}`,
            );
          },
          screenshot: {
            name: "connected-mcp-tool-catalog",
            claim: "The live catalog lists Mock Echo and clearly states that inspection does not run it.",
            requireText: ["Tools available to your agents", "Inspecting this list does not run a tool.", "1 tool exposed", "Mock Echo", "mock_echo"],
            rejectText: ["Could not read this MCP's tools", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "search_capabilities finds the real tool and execute_capability really calls it",
      run: async (ctx) => {
        await ctx.prove("The org's harness-facing MCP surface (search_capabilities + execute_capability) picks up the connection with zero desktop-side setup", {
          assert: async () => {
            const sessionToken = await signInApi(DEMO_EMAIL, DEMO_PASSWORD);
            ctx.assert(Boolean(sessionToken), `Den API sign-in failed for ${DEMO_EMAIL}.`);
            const mcpToken = await mintMcpToken(sessionToken, ctx);

            const toolCatalog = await mcpAgentCall(mcpToken, "tools/list", {}, ctx);
            const toolNames = (toolCatalog.tools ?? []).map((tool) => tool.name);
            ctx.assert(toolNames.includes("search_capabilities"), `Agent tools/list omitted search_capabilities: ${JSON.stringify(toolNames)}`);
            ctx.assert(toolNames.includes("execute_capability"), `Agent tools/list omitted execute_capability: ${JSON.stringify(toolNames)}`);

            const searchResult = await mcpAgentCall(mcpToken, "tools/call", {
              name: "search_capabilities",
              arguments: { query: "echo" },
            }, ctx);
            const matchesText = searchResult.content[0].text;
            ctx.assert(matchesText.includes(CONNECTION_NAME), `search_capabilities didn't surface ${CONNECTION_NAME}: ${matchesText}`);
            const match = JSON.parse(matchesText).matches.find((entry) => entry.summary.includes(CONNECTION_NAME));
            ctx.assert(Boolean(match), `No search_capabilities match for ${CONNECTION_NAME}.`);

            const executeResult = await mcpAgentCall(mcpToken, "tools/call", {
              name: "execute_capability",
              arguments: { name: match.name, body: { text: ECHO_TEXT } },
            }, ctx);
            const echoed = executeResult.content?.[0]?.text;
            ctx.assert(echoed === ECHO_TEXT, `execute_capability didn't echo back the exact text: got "${echoed}"`);
            const requests = await currentRunMockRequests(ctx);
            ctx.assert(
              requests.some((entry) => entry.path === "/mcp"
                && entry.authorized === true
                && entry.rpcMethods?.includes("tools/call")
                && entry.toolNames?.includes("mock_echo")),
              `execute_capability did not make an authenticated mock_echo tools/call: ${JSON.stringify(requests)}`,
            );
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        if (oauthPopupTargetId && ctx.cdpBaseUrl) {
          const closeUrl = `${ctx.cdpBaseUrl.replace(/\/$/, "")}/json/close/${encodeURIComponent(oauthPopupTargetId)}`;
          await fetch(closeUrl).catch(() => null);
          oauthPopupTargetId = null;
        }
        const sessionToken = await signInApi(DEMO_EMAIL, DEMO_PASSWORD);
        ctx.assert(Boolean(sessionToken), `Den API sign-in failed for ${DEMO_EMAIL} during cleanup.`);
        const listed = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${sessionToken}` },
        });
        ctx.assert(listed.response.ok, `Cleanup list failed: ${listed.response.status}`);
        const connection = (listed.body.connections ?? []).find((entry) => entry.name === CONNECTION_NAME);
        if (!connection) return;
        const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${sessionToken}` },
        });
        ctx.assert(removed.response.ok, `Cleanup delete failed for ${connection.id}: ${removed.response.status}`);
      },
    },
  ],
};
