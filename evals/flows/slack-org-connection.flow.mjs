/**
 * Slack-style org MCP connection: Slack's real MCP server requires a
 * pre-registered OAuth app because it does not support dynamic client
 * registration. CI cannot complete real Slack OAuth, so this flow uses a
 * DCR-less mock OAuth+MCP server as Slack's stand-in while still proving the
 * real Cloud UX and the exact no-DCR OAuth path Slack needs.
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openAdminConnections as openConnections, openYourConnections, signInApi as signIn, signInViaBrowser } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("slack-org-connection");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_SERVER_URL = (process.env.MOCK_DCRLESS_MCP_URL ?? "http://127.0.0.1:3979").trim().replace(/\/+$/, "");
const MOCK_CLIENT_ID = process.env.MOCK_CLIENT_ID || "mock-preregistered-client";
const MOCK_CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET || "mock-preregistered-secret";
const RUN_TAG = Date.now();
const CONNECTION_NAME = `slack-style-${RUN_TAG}`;

const state = {
  adminSession: null,
  connectionId: null,
  callbackUrl: null,
};

function clickSlackCardScript() {
  return `(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => {
      const text = entry.textContent ?? '';
      return text.includes('Slack') && text.includes('Tap to add');
    });
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`;
}

function callbackUrlScript() {
  return `(() => {
    const elements = [...document.querySelectorAll('*')];
    return elements.find((entry) => (entry.textContent ?? '').includes('/connect/callback'))?.textContent?.trim() ?? null;
  })()`;
}

function clickConnectionButtonScript() {
  return `(() => {
    const leaves = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() === ${JSON.stringify(CONNECTION_NAME)});
    for (const leaf of leaves) {
      let el = leaf;
      for (let i = 0; i < 5 && el; i++) {
        const text = el.textContent ?? '';
        const button = [...el.querySelectorAll('button')].find((candidate) => (candidate.textContent ?? '').trim() === 'Connect');
        if (text.includes('Connect your account') && button) {
          el.scrollIntoView({ block: 'center' });
          button.click();
          return true;
        }
        el = el.parentElement;
      }
    }
    return false;
  })()`;
}

function rowConnectedAsYouScript() {
  return `(() => {
    const leaves = [...document.querySelectorAll('*')].filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() === ${JSON.stringify(CONNECTION_NAME)});
    return leaves.some((leaf) => {
      let el = leaf;
      for (let i = 0; i < 5 && el; i++) {
        if ((el.textContent ?? '').includes('Connected as you')) {
          el.scrollIntoView({ block: 'center' });
          return true;
        }
        el = el.parentElement;
      }
      return false;
    });
  })()`;
}

export default {
  id: "slack-org-connection",
  title: "Slack-style Cloud Connection uses a pre-registered OAuth client instead of DCR",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  spec: "evals/org-mcp-connections-ux.md",
  steps: [
    {
      name: "Setup: DCR-less mock is healthy, admin signs in, and leftover slack-style connections are removed",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        ctx.assert(Boolean(health?.ok), `DCR-less mock OAuth+MCP server not reachable at ${MOCK_SERVER_URL}.`);
        const healthBody = await health.json();
        ctx.assert(healthBody.disableDcr === true, `Mock server at ${MOCK_SERVER_URL} must run with DISABLE_DCR=1.`);
        const metadata = await fetch(`${MOCK_SERVER_URL}/.well-known/oauth-authorization-server`).then((response) => response.json());
        ctx.assert(!("registration_endpoint" in metadata), "DCR-less mock metadata unexpectedly advertised registration_endpoint.");

        state.adminSession = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);

        const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        ctx.assert(existing.response.ok, `Listing manageable connections failed: ${existing.response.status}`);
        for (const connection of existing.body.connections ?? []) {
          if (connection.name.startsWith("slack-style-")) {
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
      name: "Admin opens Extensions -> Connections and sees Slack quick-add",
      run: async (ctx) => {
        await ctx.prove("The real Slack preset is visible in Cloud Connections quick-add", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await openConnections(ctx);
          },
          assert: async () => {
            // The section heading is CSS-uppercased ("QUICK ADD" in innerText),
            // so anchor on the Slack card itself.
            await ctx.waitForText("Slack", { timeoutMs: 20_000 });
            await ctx.expectText("Tap to add");
          },
          screenshot: {
            name: "slack-quick-add-card",
            claim: "Slack is a first-class quick-add preset on the Cloud Connections screen.",
            requireText: ["Slack", "Tap to add"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Admin opens Add Slack and confirms the OAuth app fields, then cancels before real Slack OAuth",
      run: async (ctx) => {
        await ctx.prove("The Slack preset asks for a pre-registered OAuth app before anyone connects", {
          voiceover: vo[1],
          action: async () => {
            const clicked = await ctx.eval(clickSlackCardScript());
            ctx.assert(clicked, "Slack quick-add card with Tap to add was not found.");
            await ctx.waitForText("Add Slack", { timeoutMs: 10_000 });
          },
          assert: async () => {
            await ctx.expectText("Client ID");
            await ctx.expectText("Client secret");
            await ctx.expectText("OAuth app");
          },
          screenshot: {
            name: "add-slack-oauth-app-fields",
            claim: "The Add Slack dialog makes the pre-registered OAuth app requirement explicit.",
            requireText: ["Add Slack", "Client ID", "Client secret"],
            rejectText: ["Something went wrong"],
          },
        });
        await ctx.clickText("Cancel", { timeoutMs: 10_000 });
      },
    },
    {
      name: "Admin adds a Slack-style custom server and receives the redirect URL to whitelist",
      run: async (ctx) => {
        await ctx.prove("A DCR-less custom server accepts a pre-registered client and hands back the exact redirect URL", {
          voiceover: vo[2],
          action: async () => {
            await ctx.clickText("Add Custom", { timeoutMs: 20_000 });
            await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"notion\"]'))", { timeoutMs: 10_000, label: "Add Custom dialog" });
            await ctx.fill('input[placeholder="notion"]', CONNECTION_NAME);
            await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', `${MOCK_SERVER_URL}/mcp`);
            await ctx.clickText("This server needs a pre-registered OAuth app", { timeoutMs: 10_000 });
            await ctx.fill('input[placeholder="1234567890.1234567890123"]', MOCK_CLIENT_ID);
            await ctx.fill('input[placeholder="Client secret"]', MOCK_CLIENT_SECRET);
            await ctx.clickText("Add connection", { timeoutMs: 15_000 });
          },
          assert: async () => {
            await ctx.waitForText("Almost done", { timeoutMs: 20_000 });
            await ctx.expectText("redirect URL");
            await ctx.expectText("/connect/callback");
            state.callbackUrl = await ctx.eval(callbackUrlScript());
            ctx.assert(Boolean(state.callbackUrl), "The redirect URL handoff did not render a callback URL.");
            ctx.assert(state.callbackUrl.includes("/v1/mcp-connections/"), `Callback URL did not include the connection route: ${state.callbackUrl}`);

            const list = await denApiFetch("/v1/mcp-connections?scope=manageable", {
              headers: { authorization: `Bearer ${state.adminSession}` },
            });
            ctx.assert(list.response.ok, `Listing manageable connections failed: ${list.response.status}`);
            const connection = (list.body.connections ?? []).find((entry) => entry.name === CONNECTION_NAME);
            ctx.assert(Boolean(connection), "Created Slack-style connection not found via API.");
            state.connectionId = connection.id;
          },
          screenshot: {
            name: "slack-style-redirect-url-handoff",
            claim: "After create, OpenWork shows the exact redirect URL the admin must whitelist in the app.",
            requireText: ["redirect URL", "/connect/callback"],
            rejectText: ["Something went wrong"],
          },
        });
        await ctx.clickText("Done", { timeoutMs: 10_000 });
      },
    },
    {
      name: "Admin connects from Your Connections; popup succeeds and the mock proves /register was never called",
      run: async (ctx) => {
        await ctx.prove("The member connection completes OAuth with the pre-registered client and no dynamic registration", {
          voiceover: vo[3],
          action: async () => {
            await openYourConnections(ctx);
            await ctx.waitForText(CONNECTION_NAME, { timeoutMs: 20_000 });
            const clicked = await ctx.eval(clickConnectionButtonScript());
            ctx.assert(clicked, `No scoped Connect button found for ${CONNECTION_NAME}.`);
            await ctx.switchToNewTab({ timeoutMs: 20_000, label: "OAuth popup" });
            await ctx.waitForText("Connected", { timeoutMs: 30_000 });
            await ctx.switchBack();
          },
          assert: async () => {
            await ctx.waitFor(rowConnectedAsYouScript(), { timeoutMs: 60_000, label: `${CONNECTION_NAME} shows Connected as you` });
            const requestLog = await fetch(`${MOCK_SERVER_URL}/requests`).then((response) => response.json());
            const registerCall = (requestLog.requests ?? []).find((entry) => entry.path === "/register");
            ctx.assert(!registerCall, `The DCR-less Slack-style flow unexpectedly called /register: ${JSON.stringify(registerCall)}`);
          },
          screenshot: {
            name: "slack-style-connected-without-dcr",
            claim: "Your Connections shows the account connected, while the mock request log proves no dynamic registration happened.",
            requireText: [CONNECTION_NAME, "Connected as you"],
            rejectText: ["Something went wrong", "Connection failed"],
          },
        });
      },
    },
    {
      name: "Cleanup: delete the Slack-style connection",
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
