/**
 * Admin-facing rescue path for shared-credential MCP connections: a shared
 * OAuth connection can be published but not authorized if the original popup
 * was abandoned. This proves an admin can finish that org-account OAuth from
 * the member-facing Your Connections page instead of hitting a dead end.
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openYourConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("your-connections-admin-shared-connect");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const RUN_TAG = Date.now();
const CONNECTION_NAME = `shared-tool-${RUN_TAG}`;

const state = {
  adminSession: null,
  connectionId: null,
};

function rowHasAdminConnectButtonScript() {
  return `(() => {
    const leaves = [...document.querySelectorAll("*")].filter((el) => el.children.length === 0 && (el.textContent ?? "").trim() === ${JSON.stringify(CONNECTION_NAME)});
    return leaves.some((leaf) => {
      let el = leaf;
      for (let i = 0; i < 5 && el; i++) {
        const text = el.textContent ?? "";
        const button = [...el.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").trim() === "Connect");
        if (text.includes("Connect the org account") && button) {
          el.scrollIntoView({ block: "center" });
          return true;
        }
        el = el.parentElement;
      }
      return false;
    });
  })()`;
}

function clickAdminConnectButtonScript() {
  return `(() => {
    const leaves = [...document.querySelectorAll("*")].filter((el) => el.children.length === 0 && (el.textContent ?? "").trim() === ${JSON.stringify(CONNECTION_NAME)});
    for (const leaf of leaves) {
      let el = leaf;
      for (let i = 0; i < 5 && el; i++) {
        const text = el.textContent ?? "";
        const button = [...el.querySelectorAll("button")].find((candidate) => (candidate.textContent ?? "").trim() === "Connect");
        if (text.includes("Connect the org account") && button) {
          button.click();
          return true;
        }
        el = el.parentElement;
      }
    }
    return false;
  })()`;
}

function rowShowsConnectedScript() {
  return `(() => {
    const leaves = [...document.querySelectorAll("*")].filter((el) => el.children.length === 0 && (el.textContent ?? "").trim() === ${JSON.stringify(CONNECTION_NAME)});
    return leaves.some((leaf) => {
      let el = leaf;
      for (let i = 0; i < 4 && el; i++) {
        if ((el.textContent ?? "").includes("Org account connected")) {
          el.scrollIntoView({ block: "center" });
          return true;
        }
        el = el.parentElement;
      }
      return false;
    });
  })()`;
}

export default {
  id: "your-connections-admin-shared-connect",
  title: "Shared MCP connection: an admin connects the org account right on Your Connections",
  kind: "user-facing",
  spec: "evals/org-mcp-connections-ux.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup: create an unconnected shared OAuth MCP connection",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        ctx.assert(Boolean(health?.ok), `Mock OAuth+MCP server not reachable at ${MOCK_SERVER_URL}.`);

        state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);

        const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        ctx.assert(existing.response.ok, `Listing manageable connections failed: ${existing.response.status}`);
        for (const connection of existing.body.connections ?? []) {
          if (connection.name.startsWith("shared-tool-")) {
            const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${state.adminSession}` },
            });
            ctx.assert(removed.response.ok, `Cleanup delete failed for leftover ${connection.id}.`);
          }
        }

        const created = await denApiFetch("/v1/mcp-connections", {
          method: "POST",
          headers: { authorization: `Bearer ${state.adminSession}` },
          body: JSON.stringify({
            name: CONNECTION_NAME,
            url: `${MOCK_SERVER_URL}/mcp`,
            authType: "oauth",
            credentialMode: "shared",
            access: { orgWide: true },
          }),
        });
        ctx.assert(created.response.ok, `Creating shared connection failed: ${created.response.status} ${JSON.stringify(created.body).slice(0, 200)}`);
        ctx.assert(created.body.connected === false, `Created connection should start unconnected: ${JSON.stringify(created.body).slice(0, 200)}`);
        state.connectionId = created.body.id;
        ctx.assert(Boolean(state.connectionId), "Created connection did not return an id.");
      },
    },
    {
      name: "Admin signs in to den-web (browser)",
      run: async (ctx) => {
        await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
      },
    },
    {
      name: "Admin opens Your Connections and sees an org-account Connect action",
      run: async (ctx) => {
        await ctx.prove("An admin can connect an unconnected shared OAuth row from Your Connections", {
          voiceover: vo[0],
          action: async () => {
            await openYourConnections(ctx);
          },
          assert: async () => {
            await ctx.waitForText(CONNECTION_NAME, { timeoutMs: 20_000 });
            await ctx.expectText("Connect the org account");
            const hasScopedConnect = await ctx.eval(rowHasAdminConnectButtonScript());
            ctx.assert(hasScopedConnect, "The shared connection row did not expose a scoped Connect button for the admin.");
          },
          screenshot: {
            name: "admin-shared-row-connect-action",
            claim: "The previously dead-end shared OAuth row now offers Connect to an admin right on Your Connections.",
            requireText: [CONNECTION_NAME, "Connect the org account", "Your Connections"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Admin connects the org account through the OAuth popup",
      run: async (ctx) => {
        await ctx.prove("The shared connection opens a real OAuth popup and completes authorization", {
          voiceover: vo[1],
          action: async () => {
            const clicked = await ctx.eval(clickAdminConnectButtonScript());
            ctx.assert(clicked, "No scoped Connect button found on the shared connection row.");
            await ctx.switchToNewTab({ timeoutMs: 20_000, label: "OAuth popup" });
            await ctx.waitForText("Connected", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(CONNECTION_NAME);
            await ctx.expectNoText("Connection failed");
          },
          screenshot: {
            name: "admin-shared-oauth-popup-connected",
            claim: "The OAuth popup shows the shared org account connection succeeded.",
            requireText: ["Connected", CONNECTION_NAME],
            rejectText: ["Connection failed"],
          },
        });
        ctx.switchBack();
      },
    },
    {
      name: "Your Connections polling flips the shared row to Connected",
      run: async (ctx) => {
        await ctx.prove("The shared row flips to Connected and the API agrees", {
          voiceover: vo[2],
          assert: async () => {
            await ctx.waitFor(rowShowsConnectedScript(), { timeoutMs: 60_000, label: `${CONNECTION_NAME} shows Connected` });
            const list = await denApiFetch("/v1/mcp-connections?scope=usable", {
              headers: { authorization: `Bearer ${state.adminSession}` },
            });
            ctx.assert(list.response.ok, `Listing usable connections failed: ${list.response.status}`);
            const connection = (list.body.connections ?? []).find((entry) => entry.id === state.connectionId);
            ctx.assert(Boolean(connection), "Connected shared connection not found in usable list.");
            ctx.assert(connection.connected === true, `API did not mark the shared connection connected: ${JSON.stringify(connection).slice(0, 200)}`);
            ctx.assert(connection.connectedForMe === true, `API did not mark connectedForMe true for the shared connection: ${JSON.stringify(connection).slice(0, 200)}`);
          },
          screenshot: {
            name: "admin-shared-row-connected",
            claim: "The background poll updates the shared row to Connected without a refresh, matching the API state.",
            requireText: [CONNECTION_NAME, "Org account connected"],
            rejectText: ["Something went wrong", "Waiting for authorization"],
          },
        });
      },
    },
    {
      name: "Cleanup: delete the shared connection",
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
