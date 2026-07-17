import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import {
  denApiFetch,
  openAdminConnections,
  signInApi,
  signInViaBrowser,
} from "./lib/den-web.mjs";

// Narration is loaded from the approved script (evals/voiceovers/mcp-oauth-popup-error-details.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs("mcp-oauth-popup-error-details");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_SERVER_URL = (process.env.MOCK_DCRLESS_MCP_URL ?? "http://127.0.0.1:3979").trim().replace(/\/+$/, "");
const CONNECTION_NAME = `oauth-popup-error-${Date.now()}`;
const state = {
  adminSession: null,
  connectionId: null,
  callbackUrl: null,
};

function clickConnectionButtonScript() {
  return `(() => {
    const leaves = [...document.querySelectorAll('*')].filter(
      (element) => element.children.length === 0
        && (element.textContent ?? '').trim() === ${JSON.stringify(CONNECTION_NAME)}
    );
    for (const leaf of leaves) {
      let element = leaf;
      for (let depth = 0; depth < 7 && element; depth += 1) {
        const button = [...element.querySelectorAll('button')].find(
          (candidate) => (candidate.textContent ?? '').trim() === 'Connect'
        );
        if (button) {
          element.scrollIntoView({ block: 'center' });
          button.click();
          return true;
        }
        element = element.parentElement;
      }
    }
    return false;
  })()`;
}

export default {
  id: "mcp-oauth-popup-error-details",
  title: "Failed MCP OAuth starts keep the popup open with expandable diagnostics",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  spec: "evals/voiceovers/mcp-oauth-popup-error-details.md",
  steps: [
    {
      name: "Setup a DCR-less OAuth connection without a pre-registered client",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        ctx.assert(Boolean(health?.ok), `DCR-less mock OAuth+MCP server not reachable at ${MOCK_SERVER_URL}.`);
        const healthBody = await health.json();
        ctx.assert(healthBody.disableDcr === true, `Mock server at ${MOCK_SERVER_URL} must run with DISABLE_DCR=1.`);

        state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);

        const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        ctx.assert(existing.response.ok, `Listing manageable connections failed: ${existing.response.status}`);
        for (const connection of existing.body.connections ?? []) {
          if (connection.name.startsWith("oauth-popup-error-")) {
            await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
              method: "DELETE",
              headers: { authorization: `Bearer ${state.adminSession}` },
            });
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
        ctx.assert(
          created.response.ok,
          `Creating DCR-less connection failed: ${created.response.status} ${JSON.stringify(created.body).slice(0, 300)}`,
        );
        state.connectionId = created.body.id;
        state.callbackUrl = created.body.links?.oauthCallback;
        ctx.assert(Boolean(state.connectionId), "Created connection did not return an id.");
        ctx.assert(Boolean(state.callbackUrl), "Created connection did not return its OAuth callback URL.");
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("A failed OAuth start stays open and shows the exact redirect URI", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await openAdminConnections(ctx);
            await ctx.waitForText(CONNECTION_NAME, { timeoutMs: 20_000 });
            await ctx.switchToNewTab({
              timeoutMs: 20_000,
              label: "OAuth error popup",
              trigger: async () => {
                const clicked = await ctx.eval(clickConnectionButtonScript());
                ctx.assert(clicked, `No Connect button found for ${CONNECTION_NAME}.`);
              },
            });
            await ctx.waitForText("Connection failed", { timeoutMs: 20_000 });
          },
          assert: async () => {
            await ctx.expectText("Technical details");
            const expanded = await ctx.eval(`(() => {
              const details = document.querySelector('details');
              details?.querySelector('summary')?.click();
              return details?.open === true;
            })()`);
            ctx.assert(expanded, "Technical details did not expand.");
            const debugText = await ctx.eval("document.querySelector('.details-content')?.textContent ?? ''");
            ctx.assert(debugText.includes("HTTP status") && debugText.includes("409"), "HTTP 409 was missing from the expanded details.");
            ctx.assert(
              debugText.includes("Error code") && debugText.includes("mcp_oauth_configuration_required"),
              "The OAuth error code was missing from the expanded details.",
            );
            ctx.assert(debugText.includes("Response payload"), "The safe response payload was missing from the expanded details.");
            ctx.assert(debugText.includes(state.callbackUrl), "The exact redirect URI was missing from the expanded details.");
            await ctx.eval(`(() => {
              document.querySelector('#response-payload-label')?.scrollIntoView({ block: 'start' });
              return true;
            })()`);
            const stillOpen = await ctx.eval("!window.closed");
            ctx.assert(stillOpen, "The OAuth popup closed after the start error.");
          },
          screenshot: {
            name: "oauth-error-popup-with-redirect-uri",
            claim: "The failed OAuth popup remains visible with expandable, safe debugging details.",
            requireText: ["RESPONSE PAYLOAD", "mcp_oauth_configuration_required", state.callbackUrl],
            rejectText: ["Preparing your connection"],
          },
        });
        await ctx.switchBack();
      },
    },
    {
      name: "Cleanup the test connection",
      run: async (ctx) => {
        if (!state.connectionId || !state.adminSession) return;
        const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        ctx.assert(removed.response.ok, `Cleanup failed for ${state.connectionId}: ${removed.response.status}`);
      },
    },
  ],
};
