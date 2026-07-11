/**
 * Proves the deterministic ServiceNow-style mock through the real Plane 1
 * den-web -> den-api OAuth and one-shot connection-test path.
 *
 * Start beside the isolated Den with:
 *   MCP_MOCK_ENABLE_DCR=1 pnpm dev:mcp-diagnostic -- --profile servicenow
 */
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openAdminConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("mcp-diagnostic-mock-server");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MCP_URL = (process.env.MOCK_DIAGNOSTIC_MCP_URL
  || "http://127.0.0.1:20508/sncapps/mcp-server/mcp/sn_mcp_server_default").trim();
const MOCK_ORIGIN = new URL(MCP_URL).origin;
const CONNECTION_NAME = `diagnostic-servicenow-${Date.now()}`;
const state = { adminSession: null, connectionId: null };

function rowScript(action) {
  return `(() => {
    const leaf = [...document.querySelectorAll("*")].find((entry) => entry.children.length === 0 && (entry.textContent ?? "").trim() === ${JSON.stringify(CONNECTION_NAME)});
    let row = leaf;
    for (let depth = 0; depth < 7 && row; depth += 1) {
      if ((row.textContent ?? "").includes(${JSON.stringify(CONNECTION_NAME)})) {
        const button = [...row.querySelectorAll("button")].find((entry) => (entry.textContent ?? "").trim() === "Test connection");
        if (${JSON.stringify(action)} === "click-test" && button) { button.click(); return true; }
        if (${JSON.stringify(action)} === "connected" && (row.textContent ?? "").includes("Connected")) { row.scrollIntoView({ block: "center" }); return true; }
      }
      row = row.parentElement;
    }
    return false;
  })()`;
}

export default {
  id: "mcp-diagnostic-mock-server",
  title: "Diagnose an enterprise MCP with a deterministic ServiceNow-style server",
  kind: "user-facing",
  spec: "evals/voiceovers/mcp-diagnostic-mock-server.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup: verify the mock and sign in as the Den admin",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_ORIGIN}/health`).then((response) => response.json()).catch(() => null);
        ctx.assert(health?.ok === true && health?.profile === "servicenow", `ServiceNow diagnostic mock is not ready at ${MOCK_ORIGIN}.`);
        state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Den API sign-in failed for ${ADMIN_EMAIL}.`);
        await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
      },
    },
    {
      name: "Frame 1: Connections is the operator entry point",
      run: async (ctx) => {
        await ctx.prove("The real Den Connections screen is ready for the enterprise diagnostic server", {
          voiceover: vo[0],
          action: async () => openAdminConnections(ctx),
          assert: async () => {
            await ctx.expectText("Add a connection");
            await ctx.expectText("MCP server");
          },
          screenshot: {
            name: "diagnostic-connections-entry",
            claim: "The admin starts from the ordinary Connections screen.",
            requireText: ["Add a connection", "MCP server"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2: configure the exact ServiceNow-style endpoint",
      run: async (ctx) => {
        await ctx.prove("The diagnostic server uses the normal custom MCP connection form", {
          voiceover: vo[1],
          action: async () => {
            await ctx.clickText("MCP server", { selector: "button", timeoutMs: 20_000 });
            await ctx.fill('input[placeholder="notion"]', CONNECTION_NAME);
            await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', MCP_URL);
            const selected = await ctx.eval(`(() => {
              const button = [...document.querySelectorAll("button")].find((entry) => (entry.textContent ?? "").trim() === "One org account");
              button?.click();
              return Boolean(button);
            })()`);
            ctx.assert(selected, "One org account option was not available.");
          },
          assert: async () => {
            const configured = await ctx.eval(`document.querySelector('input[placeholder="https://mcp.example.com/mcp"]')?.value`);
            ctx.assert(configured === MCP_URL, `Expected ${MCP_URL}, got ${configured}.`);
          },
          screenshot: {
            name: "diagnostic-servicenow-configured",
            claim: "The exact ServiceNow quickstart-style path is configured as one org account.",
            requireText: ["Add a custom MCP server", "One org account"],
            rejectText: ["Something went wrong"],
          },
        });
        const prepared = await ctx.eval(`(() => {
          const button = [...document.querySelectorAll("button")].find((entry) => (entry.textContent ?? "").trim() === "Add connection" && entry.getClientRects().length > 0);
          if (!button) return false;
          button.id = "fraimz-add-mcp-connection";
          return true;
        })()`);
        ctx.assert(prepared, "The Add connection button was not available for a trusted click.");
        await ctx.trustedClick("#fraimz-add-mcp-connection", { timeoutMs: 20_000 });
      },
    },
    {
      name: "Frame 3: complete the real synthetic OAuth handshake",
      run: async (ctx) => {
        await ctx.prove("The synthetic provider completes Den's real OAuth callback", {
          voiceover: vo[2],
          action: async () => {
            await ctx.switchToNewTab({ timeoutMs: 20_000, label: "diagnostic OAuth popup" });
            await ctx.waitForText("Connected", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(CONNECTION_NAME);
            await ctx.expectNoText("Connection failed");
          },
          screenshot: {
            name: "diagnostic-oauth-connected",
            claim: "Protected-resource discovery, the mock-only DCR override, PKCE, token exchange, and Den callback completed.",
            requireText: ["Connected", CONNECTION_NAME],
            rejectText: ["Connection failed"],
          },
        });
        await ctx.switchBack();
      },
    },
    {
      name: "Frame 4: the connected row exposes a read-only test",
      run: async (ctx) => {
        await ctx.prove("The ordinary connected row now offers Test connection", {
          voiceover: vo[3],
          assert: async () => {
            await ctx.waitFor(rowScript("connected"), { timeoutMs: 60_000, label: "diagnostic MCP connected" });
            await ctx.expectText("Test connection");
          },
          screenshot: {
            name: "diagnostic-row-ready-to-test",
            claim: "The connected org-account row offers the one-shot read-only test.",
            requireText: [CONNECTION_NAME, "Connected", "Test connection"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 5: protocol and complete catalog readiness are visible",
      run: async (ctx) => {
        await ctx.prove("The result identifies the negotiated protocol and complete paged catalog without secrets", {
          voiceover: vo[4],
          action: async () => {
            const clicked = await ctx.eval(rowScript("click-test"));
            ctx.assert(clicked, "Could not click the scoped Test connection button.");
          },
          assert: async () => {
            await ctx.waitForText("Protocol ready · 2025-06-18 · 4 tools across 2 pages", { timeoutMs: 45_000 });
            await ctx.expectText("look_up_incident_records");
            await ctx.expectText("session established");
            await ctx.expectNoText("mock-access-token");
          },
          screenshot: {
            name: "diagnostic-connection-test-passed",
            claim: "Protocol 2025-06-18, session use, all four documented Quickstart tools, two pages, and a catalog fingerprint are proven.",
            requireText: ["Protocol ready", "2025-06-18", "4 tools", "2 pages", "session established"],
            rejectText: ["mock-access-token", "Connection test failed"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        const list = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        const connection = (list.body.connections ?? []).find((entry) => entry.name === CONNECTION_NAME);
        state.connectionId = connection?.id ?? null;
        if (state.connectionId) {
          const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${state.adminSession}` },
          });
          ctx.assert(removed.response.ok, `Cleanup failed for ${state.connectionId}.`);
        }
      },
    },
  ],
};
