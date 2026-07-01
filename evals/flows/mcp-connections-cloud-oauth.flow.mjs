/**
 * The full "search and execute as the main entry point" loop, proven
 * end-to-end through the real den-web "MCP Connections" screen — not a
 * script hitting den-api directly. A real admin action in a real browser:
 *
 *   1. Sign in to den-web (real email+password flow).
 *   2. Open Settings -> MCP Connections (a brand-new Den screen).
 *   3. Click "Add Custom", fill in a real MCP server URL, submit.
 *   4. A real browser popup opens for OAuth; the target server (a
 *      self-controlled stand-in that speaks the full MCP OAuth protocol —
 *      RFC 9728 discovery, RFC 7591 dynamic client registration, PKCE)
 *      auto-approves and redirects to Den's real callback, which performs a
 *      real, PKCE-verified token exchange and shows a real success page.
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

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
const DEMO_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const DEMO_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const CONNECTION_NAME = `fraimz-mcp-${Date.now()}`;
const ECHO_TEXT = "search and execute in the cloud proof";

async function denApiFetch(path, options = {}) {
  const response = await fetch(`${DEN_API_URL}${path}`, {
    ...options,
    // Better Auth rejects auth requests with no Origin header (CSRF
    // protection); a real browser always sends one, Node's fetch doesn't.
    headers: { "content-type": "application/json", origin: DEN_WEB_URL, ...(options.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { response, body };
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
        const currentUrl = await ctx.eval("window.location.href");
        if (!currentUrl.includes(new URL(DEN_WEB_URL).host)) {
          await ctx.eval(`(() => { window.location.href = ${JSON.stringify(DEN_WEB_URL)}; return true; })()`);
        }
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
        await ctx.eval(`fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true).catch(() => true)`, { awaitPromise: true });
        await ctx.eval(`(() => { window.location.href = ${JSON.stringify(DEN_WEB_URL)}; return true; })()`);
        await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
        await ctx.clickText("Sign in", { timeoutMs: 20_000 });
        await ctx.fill("input[type=\"email\"], input", DEMO_EMAIL);
        await ctx.clickText("Next", { timeoutMs: 15_000 });
        await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"]'))", {
          timeoutMs: 15_000,
          label: "password field",
        });
        await ctx.fill("input[type=\"password\"]", DEMO_PASSWORD);
        await ctx.clickText("Sign in", { timeoutMs: 15_000 });
        await ctx.waitForText("Dashboard", { timeoutMs: 30_000 });
      },
    },
    {
      name: "Open Settings -> MCP Connections",
      run: async (ctx) => {
        // Retry the click: on a fresh page load (especially over higher cloud
        // latency), the very first click can land before Next.js has finished
        // hydrating and attaching the link's handler.
        await ctx.waitFor(
          `(() => {
            const link = [...document.querySelectorAll('a')].find((a) => a.getAttribute('href')?.includes('mcp-connections'));
            if (!link) return false;
            if (window.location.pathname.includes('mcp-connections')) return true;
            link.click();
            return false;
          })()`,
          { timeoutMs: 30_000, label: "MCP Connections nav link clicked" },
        );
        await ctx.waitFor("window.location.pathname.includes('mcp-connections')", {
          timeoutMs: 20_000,
          label: "MCP Connections route",
        });
        await ctx.prove("The new MCP Connections screen renders in Den", {
          assert: async () => {
            await ctx.expectText("MCP Connections");
            await ctx.expectText("Add Custom");
            await ctx.expectText("Notion");
          },
          screenshot: {
            name: "mcp-connections-screen",
            claim: "Den has a real MCP Connections settings screen with quick-add presets and a custom-URL form.",
            requireText: ["MCP Connections", "Add Custom", "Notion"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Add the mock server as a custom MCP connection",
      run: async (ctx) => {
        await ctx.prove("The Add Custom MCP server form accepts a real name + URL", {
          action: async () => {
            await ctx.clickText("Add Custom", { timeoutMs: 20_000 });
            await ctx.waitFor(
              "Boolean(document.querySelector('input[placeholder=\"notion\"]'))",
              { timeoutMs: 10_000, label: "Add Custom dialog" },
            );
            await ctx.fill('input[placeholder="notion"]', CONNECTION_NAME);
            await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', `${MOCK_SERVER_URL}/mcp`);
          },
          assert: async () => {
            const values = await ctx.eval(`(() => ({
              name: document.querySelector('input[placeholder="notion"]')?.value ?? null,
              url: document.querySelector('input[placeholder="https://mcp.example.com/mcp"]')?.value ?? null,
            }))()`);
            ctx.assert(values.name === CONNECTION_NAME, `Expected name input "${CONNECTION_NAME}", got "${values.name}"`);
            ctx.assert(values.url === `${MOCK_SERVER_URL}/mcp`, `Expected URL input "${MOCK_SERVER_URL}/mcp", got "${values.url}"`);
          },
          screenshot: {
            name: "add-connection-filled",
            claim: "The Add Custom MCP server dialog is filled with a real name and URL.",
            requireText: ["Add a custom MCP server", "Server URL"],
            rejectText: ["Something went wrong"],
          },
        });

        await ctx.clickText("Add connection", { timeoutMs: 15_000 });
      },
    },
    {
      name: "A real browser popup completes the OAuth handshake",
      run: async (ctx) => {
        await ctx.prove("Submitting opens a real OAuth tab that completes RFC 9728 discovery + dynamic client registration + PKCE for real", {
          action: async () => {
            await ctx.switchToNewTab({ timeoutMs: 20_000, label: "OAuth popup" });
            await ctx.waitForText("Connected", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(CONNECTION_NAME);
            await ctx.expectNoText("Connection failed");
          },
          screenshot: {
            name: "oauth-popup-connected",
            claim: "The OAuth popup shows a real success page after a real, PKCE-verified token exchange.",
            requireText: ["Connected", CONNECTION_NAME],
            rejectText: ["Connection failed"],
          },
        });
        ctx.switchBack();
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
      name: "search_capabilities finds the real tool and execute_capability really calls it",
      run: async (ctx) => {
        await ctx.prove("The org's harness-facing MCP surface (search_capabilities + execute_capability) picks up the connection with zero desktop-side setup", {
          assert: async () => {
            const signIn = await denApiFetch("/api/auth/sign-in/email", {
              method: "POST",
              body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
            });
            ctx.assert(signIn.response.ok, `Den API sign-in failed: ${signIn.response.status}`);
            const sessionToken = signIn.body.token;

            const mint = await denApiFetch("/v1/mcp/token", {
              method: "POST",
              headers: { authorization: `Bearer ${sessionToken}` },
              body: "{}",
            });
            ctx.assert(mint.response.ok, `Minting an MCP token failed: ${mint.response.status}`);
            const mcpToken = mint.body.token;

            async function mcpAgentCall(method, params) {
              const response = await fetch(`${DEN_API_URL}/mcp/agent`, {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  accept: "application/json, text/event-stream",
                  authorization: `Bearer ${mcpToken}`,
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
              });
              const raw = await response.text();
              ctx.assert(response.ok, `MCP ${method} failed: ${response.status} ${raw.slice(0, 200)}`);
              const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
              ctx.assert(Boolean(dataLine), `MCP ${method} returned no data frame.`);
              return JSON.parse(dataLine.slice(5)).result;
            }

            const searchResult = await mcpAgentCall("tools/call", {
              name: "search_capabilities",
              arguments: { query: "echo" },
            });
            const matchesText = searchResult.content[0].text;
            ctx.assert(matchesText.includes(CONNECTION_NAME), `search_capabilities didn't surface ${CONNECTION_NAME}: ${matchesText}`);
            const match = JSON.parse(matchesText).matches.find((entry) => entry.summary.includes(CONNECTION_NAME));
            ctx.assert(Boolean(match), `No search_capabilities match for ${CONNECTION_NAME}.`);

            const executeResult = await mcpAgentCall("tools/call", {
              name: "execute_capability",
              arguments: { name: match.name, body: { text: ECHO_TEXT } },
            });
            const echoed = executeResult.content?.[0]?.text;
            ctx.assert(echoed === ECHO_TEXT, `execute_capability didn't echo back the exact text: got "${echoed}"`);
          },
        });
      },
    },
  ],
};
