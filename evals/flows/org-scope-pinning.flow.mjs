/**
 * Regression proof for multi-org active-org drift on the Connections surface.
 *
 * Bug class: den-web relied on the session's global active organization for
 * org-scoped calls. With multiple orgs, a mid-flow active-org change (another
 * tab, the desktop app, a stale session) made POST /v1/mcp-connections either
 * fail with organization_not_found or silently write into the wrong org.
 *
 * Fix under test: den-web pins Connections requests with x-openwork-org-id,
 * and den-api gives that explicit scope precedence over the session value.
 *
 * Requires a multi-org Den deployment (DEN_ORG_MODE=multi_org); gate with
 * OPENWORK_EVAL_DEN_MULTI_ORG so single-org CI setups skip instead of fail.
 */

import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, openAdminConnections as openConnections, signInApi as signIn } from "./lib/den-web.mjs";

const vo = await loadVoiceoverParagraphs("org-scope-pinning");

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MOCK_SERVER_URL = (process.env.MOCK_DCRLESS_MCP_URL ?? "http://127.0.0.1:3979").trim().replace(/\/+$/, "");
const MOCK_CLIENT_ID = process.env.MOCK_CLIENT_ID || "mock-preregistered-client";
const MOCK_CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET || "mock-preregistered-secret";
const DRIFT_ORG_NAME = "Drift Probe Org";
const ORG_SCOPE_HEADER = "x-openwork-org-id";
const CONNECTION_NAME = `pin-probe-${Date.now()}`;

function denWebUrl() {
  return (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? "").trim().replace(/\/+$/, "");
}

const state = {
  adminToken: null,
  orgA: null,
  orgB: null,
  connectionId: null,
};

function orgScopedHeaders(orgId, extra = {}) {
  return { authorization: `Bearer ${state.adminToken}`, [ORG_SCOPE_HEADER]: orgId, ...extra };
}

async function listConnections(orgId) {
  const { response, body } = await denApiFetch("/v1/mcp-connections?scope=manageable", {
    headers: orgScopedHeaders(orgId),
  });
  return { response, connections: body.connections ?? [] };
}

async function cleanupProbeConnections(ctx, orgId) {
  const { response, connections } = await listConnections(orgId);
  ctx.assert(response.ok, `Listing connections for cleanup failed in ${orgId}: ${response.status}`);
  for (const connection of connections) {
    if (connection.name.startsWith("pin-probe-")) {
      const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
        method: "DELETE",
        headers: orgScopedHeaders(orgId),
      });
      ctx.assert(removed.response.ok, `Cleanup delete failed for leftover ${connection.id} in ${orgId}.`);
    }
  }
}

async function browserJson(ctx, script) {
  const raw = await ctx.eval(script, { awaitPromise: true });
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function browserSetActiveOrg(ctx, organizationId) {
  return browserJson(
    ctx,
    `fetch('/api/auth/organization/set-active', { method: 'POST', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(JSON.stringify({ organizationId }))} }).then((response) => response.status)`,
  );
}

async function browserActiveOrgId(ctx) {
  return browserJson(
    ctx,
    `fetch('/api/den/v1/me/orgs').then((response) => response.json()).then((data) => JSON.stringify(data.activeOrgId ?? null))`,
  );
}

export default {
  id: "org-scope-pinning",
  title: "Connections requests stay pinned to the org on screen when the session's active org drifts",
  kind: "user-facing",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_DEN_MULTI_ORG"],
  spec: "evals/org-mcp-connections-ux.md",
  steps: [
    {
      name: "Setup: admin signs in, has (or gets) a second org, and leftover probe connections are removed",
      run: async (ctx) => {
        state.adminToken = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminToken), `Admin sign-in failed for ${ADMIN_EMAIL}.`);

        const orgsFirst = await denApiFetch("/v1/me/orgs", {
          headers: { authorization: `Bearer ${state.adminToken}` },
        });
        ctx.assert(orgsFirst.response.ok, `Listing orgs failed: ${orgsFirst.response.status}`);
        let orgs = orgsFirst.body.orgs ?? [];
        ctx.assert(orgs.length >= 1, "Admin has no organizations.");

        state.orgB = orgs.find((org) => org.name === DRIFT_ORG_NAME) ?? null;
        if (!state.orgB) {
          const created = await denApiFetch("/v1/org", {
            method: "POST",
            headers: { authorization: `Bearer ${state.adminToken}` },
            body: JSON.stringify({ name: DRIFT_ORG_NAME }),
          });
          ctx.assert(
            created.response.ok,
            `Creating the drift org failed (${created.response.status}): ${JSON.stringify(created.body)} — this flow needs DEN_ORG_MODE=multi_org.`,
          );
          const refreshed = await denApiFetch("/v1/me/orgs", {
            headers: { authorization: `Bearer ${state.adminToken}` },
          });
          ctx.assert(refreshed.response.ok, `Re-listing orgs failed: ${refreshed.response.status}`);
          orgs = refreshed.body.orgs ?? [];
          state.orgB = orgs.find((org) => org.name === DRIFT_ORG_NAME) ?? null;
        }
        ctx.assert(Boolean(state.orgB), "Drift org missing after create.");

        state.orgA = orgs.find((org) => org.id !== state.orgB.id && org.slug === "default")
          ?? orgs.find((org) => org.id !== state.orgB.id);
        ctx.assert(Boolean(state.orgA), "No primary org distinct from the drift org.");

        await cleanupProbeConnections(ctx, state.orgA.id);
        await cleanupProbeConnections(ctx, state.orgB.id);
      },
    },
    {
      name: "Multi-org admin picks an org and lands on its Connections screen",
      run: async (ctx) => {
        await ctx.prove("The admin is unmistakably operating in the chosen org's Connections screen", {
          voiceover: vo[0],
          action: async () => {
            await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
            await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
            await ctx.eval(
              `fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(() => true).catch(() => true)`,
              { awaitPromise: true },
            );
            await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
            await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
            await ctx.waitFor(
              "Boolean(document.querySelector('input[type=\"email\"]')) && Boolean(document.querySelector('input[type=\"password\"]'))",
              { timeoutMs: 30_000, label: "email + password fields" },
            );
            await ctx.fill('input[type="email"]', ADMIN_EMAIL);
            await ctx.fill('input[type="password"]', ADMIN_PASSWORD);
            const submitted = await ctx.eval(`(() => {
              const button = document.querySelector('button[type="submit"]');
              if (!button) return false;
              button.click();
              return true;
            })()`);
            ctx.assert(submitted, "No submit button found on the sign-in card.");
            await ctx.waitFor(
              "!document.querySelector('input[type=\"password\"]')",
              { timeoutMs: 30_000, label: "sign-in card dismissed" },
            );

            // A fresh multi-org session has no active org, so the org chooser
            // appears; pick the primary org explicitly (that IS the feature).
            await ctx.waitFor(
              `(() => {
                const text = document.body?.innerText ?? '';
                return text.includes('Choose an organization') || text.includes('Dashboard');
              })()`,
              { timeoutMs: 30_000, label: "org chooser or dashboard" },
            );
            const chooserVisible = await ctx.eval(`(document.body?.innerText ?? '').includes('Choose an organization')`);
            if (chooserVisible) {
              const picked = await ctx.eval(`(() => {
                const button = [...document.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').includes(${JSON.stringify(state.orgA.name)}));
                button?.click();
                return Boolean(button);
              })()`);
              ctx.assert(picked, `Org chooser did not list ${state.orgA.name}.`);
            }
            await ctx.waitForText("Dashboard", { timeoutMs: 30_000 });

            // Pin the starting state deterministically: whatever org the
            // session landed on, make org A active and boot fresh on it.
            const status = await browserSetActiveOrg(ctx, state.orgA.id);
            ctx.assert(status === 200, `Selecting the primary org failed with status ${status}.`);
            await ctx.eval(`(() => { window.location.href = ${JSON.stringify(denWebUrl())}; return true; })()`);
            await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
            await ctx.waitForText("Dashboard", { timeoutMs: 30_000 });
            await openConnections(ctx);
          },
          assert: async () => {
            await ctx.waitForText("Slack", { timeoutMs: 20_000 });
            await ctx.expectText("Add Custom");
            // The screen chrome doesn't print the org name; the session's
            // active org is the ground truth for which org is on screen.
            const active = await browserActiveOrgId(ctx);
            ctx.assert(active === state.orgA.id, `Browser session active org is ${active}, expected ${state.orgA.id}.`);
          },
          screenshot: {
            name: "connections-in-chosen-org",
            claim: "The Connections screen is open in the org the admin chose.",
            requireText: ["Connections", "Add Custom", "Slack"],
            rejectText: ["Something went wrong", "organization_not_found"],
          },
        });
      },
    },
    {
      name: "Active org drifts mid-flow; the open dialog still creates the connection without organization_not_found",
      run: async (ctx) => {
        await ctx.prove("Creating a connection survives an active-org drift because requests are pinned to the on-screen org", {
          voiceover: vo[1],
          action: async () => {
            // Simulate the drift: another tab / the desktop app flips the
            // session's active organization while this screen stays open.
            const status = await browserSetActiveOrg(ctx, state.orgB.id);
            ctx.assert(status === 200, `set-active drift call failed with status ${status}.`);
            const active = await browserActiveOrgId(ctx);
            ctx.assert(active === state.orgB.id, `Session did not drift (active org ${active}).`);

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
            await ctx.expectText("/connect/callback");
            await ctx.expectNoText("organization_not_found");
            await ctx.expectNoText("Something went wrong");

            // The session is still drifted; only the explicit org scope can
            // have routed this write into the org on screen.
            const active = await browserActiveOrgId(ctx);
            ctx.assert(active === state.orgB.id, `Drift ended early (active org ${active}); the proof needs the drifted session.`);

            const inOrgA = await listConnections(state.orgA.id);
            ctx.assert(inOrgA.response.ok, `Listing org A connections failed: ${inOrgA.response.status}`);
            const created = inOrgA.connections.find((entry) => entry.name === CONNECTION_NAME);
            ctx.assert(Boolean(created), "Connection was not created in the org shown on screen.");
            state.connectionId = created.id;

            const inOrgB = await listConnections(state.orgB.id);
            ctx.assert(inOrgB.response.ok, `Listing org B connections failed: ${inOrgB.response.status}`);
            const strayWrite = inOrgB.connections.find((entry) => entry.name === CONNECTION_NAME);
            ctx.assert(!strayWrite, "Connection leaked into the drifted org — the write was not pinned.");
          },
          screenshot: {
            name: "create-survives-org-drift",
            claim: "The connection is created and the redirect-URL handoff renders even though the session's active org drifted mid-dialog.",
            requireText: ["Almost done", "/connect/callback"],
            rejectText: ["organization_not_found", "Something went wrong"],
          },
        });
        await ctx.clickText("Done", { timeoutMs: 10_000 });
      },
    },
    {
      name: "The connection lives in the org the admin saw, and the screen still shows it after the drift is undone",
      run: async (ctx) => {
        await ctx.prove("The org on screen owns the connection; the drifted org never saw the write", {
          voiceover: vo[2],
          action: async () => {
            const status = await browserSetActiveOrg(ctx, state.orgA.id);
            ctx.assert(status === 200, `Restoring the active org failed with status ${status}.`);
            await ctx.eval(`(() => { window.location.reload(); return true; })()`);
            await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000 });
            await openConnections(ctx);
          },
          assert: async () => {
            await ctx.waitForText(CONNECTION_NAME, { timeoutMs: 20_000 });
            const active = await browserActiveOrgId(ctx);
            ctx.assert(active === state.orgA.id, `Browser session active org is ${active}, expected ${state.orgA.id}.`);
          },
          screenshot: {
            name: "connection-listed-in-correct-org",
            claim: "After the drift is undone, the org's Connections list shows the probe connection exactly where the admin created it.",
            requireText: [CONNECTION_NAME],
            rejectText: ["Something went wrong", "organization_not_found"],
          },
        });
      },
    },
    {
      name: "Cleanup: delete the probe connection",
      run: async (ctx) => {
        if (!state.connectionId) return;
        const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
          method: "DELETE",
          headers: orgScopedHeaders(state.orgA.id),
        });
        ctx.assert(removed.response.ok, `Cleanup delete failed for ${state.connectionId}.`);
      },
    },
  ],
};
