/**
 * Exa quick-add connection: the real hosted Exa MCP server is added from the
 * Cloud Connections preset with an org API key, then discovered through the
 * org's agent-facing MCP surface.
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, mcpAgentCall, mintMcpToken, openAdminConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("exa-connection");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const EXA_URL = "https://mcp.exa.ai/mcp";
const EXA_API_KEY = process.env.OPENWORK_EVAL_EXA_API_KEY?.trim() || "exa-eval-placeholder-key";
const HAS_REAL_EXA_API_KEY = EXA_API_KEY !== "exa-eval-placeholder-key";

const state = {
  adminSession: null,
  connectionId: null,
};

function clickExaCardScript() {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => {
      const text = entry.textContent ?? '';
      return text.includes('Exa') && text.includes('Tap to add');
    });
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`;
}

function exaConnectedRowScript() {
  // Returns true only when the connected row is INSIDE the viewport — the
  // list re-renders on the page's 2s polling, which can reset an earlier
  // scroll before the screenshot is captured, so keep scrolling until the
  // row is genuinely visible.
  return `(() => {
    const leaves = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() === 'Exa');
    for (const leaf of leaves) {
      let el = leaf;
      for (let i = 0; i < 6 && el; i++) {
        const text = el.textContent ?? '';
        if (text.includes('Connected') && text.includes(${JSON.stringify(EXA_URL)})) {
          const rect = el.getBoundingClientRect();
          if (rect.top >= 0 && rect.bottom <= window.innerHeight) return true;
          el.scrollIntoView({ block: 'center' });
          return false;
        }
        el = el.parentElement;
      }
    }
    return false;
  })()`;
}

export default {
  id: "exa-connection",
  title: "Exa is a quick-add Cloud Connection with org API-key setup",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  spec: "evals/org-mcp-connections-ux.md",
  steps: [
    {
      name: "Setup: admin signs in and leftover Exa connections are removed",
      run: async (ctx) => {
        state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);

        const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        ctx.assert(existing.response.ok, `Listing manageable connections failed: ${existing.response.status}`);

        for (const connection of existing.body.connections ?? []) {
          if (connection.url === EXA_URL || connection.name === "Exa") {
            const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${state.adminSession}` },
            });
            ctx.assert(removed.response.ok, `Cleanup delete failed for leftover ${connection.id}.`);
          }
        }
      },
    },
    {
      name: "Admin opens Connections and sees the Exa quick-add card",
      run: async (ctx) => {
        await ctx.prove("The Exa preset is visible in Cloud Connections quick-add", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await openAdminConnections(ctx);
          },
          assert: async () => {
            await ctx.waitForText("Exa", { timeoutMs: 20_000 });
            await ctx.expectText("Tap to add");
          },
          screenshot: {
            name: "exa-quick-add-card",
            claim: "Exa is available as a first-class quick-add preset on the Cloud Connections screen.",
            requireText: ["Exa", "Tap to add"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Admin opens Add Exa, pastes the org API key, and submits",
      run: async (ctx) => {
        await ctx.prove("The Exa preset opens an API-key-only Add Exa dialog", {
          voiceover: vo[1],
          action: async () => {
            const clicked = await ctx.eval(clickExaCardScript());
            ctx.assert(clicked, "Exa quick-add card with Tap to add was not found.");
            await ctx.waitForText("Add Exa", { timeoutMs: 10_000 });
            await ctx.waitFor("Boolean(document.querySelector('input[type=\"password\"][placeholder=\"sk-...\"]'))", {
              timeoutMs: 10_000,
              label: "Exa API key input",
            });
            await ctx.fill('input[type="password"][placeholder="sk-..."]', EXA_API_KEY);
          },
          assert: async () => {
            await ctx.expectText("Add Exa");
            await ctx.expectText("API key");
            const hasPasswordInput = await ctx.eval("Boolean(document.querySelector('input[type=\"password\"]'))");
            ctx.assert(hasPasswordInput, "Add Exa did not render a password input for the API key.");
          },
          screenshot: {
            name: "add-exa-api-key-field",
            claim: "Add Exa asks for the org's Exa API key, with no OAuth picker or custom URL work.",
            requireText: ["Add Exa", "API key"],
            rejectText: ["Something went wrong"],
          },
        });

        await ctx.waitFor(
          `(() => {
            const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Add connection');
            return Boolean(button && !button.disabled);
          })()`,
          { timeoutMs: 10_000, label: "enabled Add connection button" },
        );
        await ctx.clickText("Add connection", { timeoutMs: 15_000 });
      },
    },
    {
      name: "Exa is connected and its real tools appear in the agent MCP surface",
      run: async (ctx) => {
        await ctx.prove("The Exa row is connected and search_capabilities lists Exa's real MCP tools", {
          voiceover: vo[2],
          assert: async () => {
            await ctx.waitFor(exaConnectedRowScript(), { timeoutMs: 60_000, label: "Exa row shows Connected" });

            const list = await denApiFetch("/v1/mcp-connections?scope=manageable", {
              headers: { authorization: `Bearer ${state.adminSession}` },
            });
            ctx.assert(list.response.ok, `Listing manageable connections failed: ${list.response.status}`);
            const connection = (list.body.connections ?? []).find((entry) => entry.url === EXA_URL && entry.name === "Exa");
            ctx.assert(Boolean(connection), "Created Exa connection not found via API.");
            state.connectionId = connection.id;
            ctx.assert(connection.connected === true, `Exa connection did not report connected via API: ${JSON.stringify(connection).slice(0, 200)}`);

            const mcpToken = await mintMcpToken(state.adminSession, ctx);
            const search = await mcpAgentCall(mcpToken, "tools/call", {
              name: "search_capabilities",
              arguments: { query: "web search" },
            }, ctx);
            const searchText = String(search.content?.[0]?.text ?? "");
            const exaToolName = `mcp:${state.connectionId}:web_search_exa`;
            ctx.assert(searchText.includes(exaToolName), `search_capabilities missing ${exaToolName}: ${searchText.slice(0, 500)}`);

            if (HAS_REAL_EXA_API_KEY) {
              const execute = await mcpAgentCall(mcpToken, "tools/call", {
                name: "execute_capability",
                arguments: {
                  name: exaToolName,
                  body: { query: "OpenWork AI agents", numResults: 1 },
                },
              }, ctx);
              const executeText = JSON.stringify(execute);
              ctx.assert(!executeText.includes("Invalid API key"), `Exa execution rejected the API key: ${executeText.slice(0, 500)}`);
              ctx.assert(execute.isError !== true, `Exa execution returned an error: ${executeText.slice(0, 500)}`);
            } else {
              ctx.log("Skipping real Exa web_search_exa execution because real execution requires OPENWORK_EVAL_EXA_API_KEY; placeholder keys only validate create and tool discovery.");
            }

            // The list polls/re-renders while the API checks above run, which
            // can reset the scroll position — bring the connected row back
            // into view so the frame shows what the claim says.
            await ctx.waitFor(exaConnectedRowScript(), { timeoutMs: 10_000, label: "Exa row back in view" });
          },
          screenshot: {
            name: "exa-connected-row",
            claim: "The Exa row shows Connected, and the org agent surface lists Exa's real web_search_exa tool.",
            requireText: ["Exa", "Connected"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Cleanup: delete the created Exa connection",
      run: async (ctx) => {
        if (!state.connectionId) return;
        const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        ctx.assert(removed.response.ok, `Cleanup delete failed for ${state.connectionId}.`);
      },
    },
  ],
};
