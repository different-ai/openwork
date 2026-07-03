/**
 * The piece of the "desktop MCP consolidation" story that did NOT exist
 * before this flow: the member discovers and connects an org-level External
 * MCP Connection FROM INSIDE THE DESKTOP APP's own Settings > Extensions UI
 * — not via a raw HTTP call, and not via a second, independently-configured
 * live engine MCP connection.
 *
 * mcp-connections-desktop-e2e.flow.mjs already proved the tail end (chat ->
 * search_capabilities -> execute_capability -> real result) for a member
 * whose account was connected via raw HTTP as test setup. This flow proves
 * the missing front end: a real button click in the desktop's own "From your
 * organization" section drives the real connect/start call and opens a real,
 * connection-specific authorize URL — then, without any page reload, the
 * SAME card flips from "Connect your account" to "Connected" once the OAuth
 * round trip completes, proving the app's own polling loop (not a manual
 * refresh) picked up the change.
 *
 * Electron's contextBridge freezes what it exposes to the renderer, so this
 * flow does not (and cannot) stub out shell.openExternal — the click drives
 * the REAL bridge call, which really opens the OS default browser against
 * the connection-specific authorize URL. Because the mock IdP auto-approves
 * (AUTO_APPROVE!=0), that real browser tab completes the whole OAuth round
 * trip on its own with no human interaction required. This flow witnesses
 * that real request landing — via the mock server's own request log, not a
 * client-side stub — then waits for the app's own polling loop to notice.
 *
 * Prerequisites:
 * - Desktop app from this worktree running with CDP — pass --cdp-url.
 * - den-api at OPENWORK_EVAL_DEN_API_URL with the seeded demo org.
 * - Mock OAuth+MCP server at MOCK_OAUTH_MCP_URL (reachable from den-api),
 *   AUTO_APPROVE not set to "0".
 * - Member account per mcp-connections-member-scoped.flow.mjs (bootstrapped
 *   automatically with OPENWORK_EVAL_MARK_VERIFIED_CMD if missing).
 */

import { execSync } from "node:child_process";

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? DEN_API_URL).trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const RUN_TAG = Date.now();
const CONNECTION_NAME = `desktop-consolidation-${RUN_TAG}`;
const WORKSPACE_PATH = "/tmp/openwork-desktop-org-mcp-consolidation";

const state = {
  adminSession: null,
  memberSession: null,
  connectionId: null,
  capturedAuthorizeUrl: null,
};

async function denApiFetch(path, options = {}) {
  const response = await fetch(`${DEN_API_URL}${path}`, {
    ...options,
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

async function signIn(email, password) {
  const { response, body } = await denApiFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  if (!response.ok) return null;
  return body.token;
}

export default {
  id: "desktop-org-mcp-consolidation",
  title: "Desktop app: member discovers and connects an org MCP connection from Settings > Extensions with a real click",
  spec: "evals/cloud-mcp-agent-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Setup: admin publishes a per-member connection the member has NOT yet connected",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        ctx.assert(Boolean(health?.ok), `Mock OAuth+MCP server not reachable at ${MOCK_SERVER_URL}.`);
        const healthBody = await fetch(`${MOCK_SERVER_URL}/health`).then((r) => r.json());
        ctx.assert(healthBody.autoApprove !== false, "Mock server must auto-approve (AUTO_APPROVE!=0) for this flow.");

        state.adminSession = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);

        state.memberSession = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
        if (!state.memberSession) {
          ctx.log(`Bootstrapping member ${MEMBER_EMAIL} via real invitation flow.`);
          const invite = await denApiFetch("/v1/invitations", {
            method: "POST",
            headers: { authorization: `Bearer ${state.adminSession}` },
            body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
          });
          ctx.assert(invite.response.ok, `Invitation failed: ${invite.response.status}`);
          const signUp = await denApiFetch("/api/auth/sign-up/email", {
            method: "POST",
            body: JSON.stringify({ email: MEMBER_EMAIL, name: "Jordan Demo", password: MEMBER_PASSWORD }),
          });
          ctx.assert(signUp.response.ok, `Member sign-up failed: ${signUp.response.status}`);
          ctx.assert(MARK_VERIFIED_CMD.length > 0, "Set OPENWORK_EVAL_MARK_VERIFIED_CMD to verify the member's email.");
          execSync(MARK_VERIFIED_CMD.replaceAll("{email}", MEMBER_EMAIL), { stdio: "ignore" });
          state.memberSession = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
          ctx.assert(Boolean(state.memberSession), "Member sign-in still failing after sign-up.");
          const accept = await denApiFetch("/v1/orgs/invitations/accept", {
            method: "POST",
            headers: { authorization: `Bearer ${state.memberSession}` },
            body: JSON.stringify({ id: invite.body.inviteToken }),
          });
          ctx.assert(accept.response.ok && accept.body.accepted, "Invitation accept failed.");
        }

        // Clean up any leftovers from prior runs of this flow.
        const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        for (const connection of existing.body.connections ?? []) {
          if (connection.name.startsWith("desktop-consolidation-")) {
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
            credentialMode: "per_member",
            access: { orgWide: true },
          }),
        });
        ctx.assert(created.response.ok, `Connection create failed: ${created.response.status}`);
        state.connectionId = created.body.id;

        // Confirm the member sees it as usable-but-not-connected — the
        // starting state the desktop UI must render faithfully.
        const usable = await denApiFetch("/v1/mcp-connections?scope=usable", {
          headers: { authorization: `Bearer ${state.memberSession}` },
        });
        const mine = (usable.body.connections ?? []).find((entry) => entry.id === state.connectionId);
        ctx.assert(Boolean(mine), "Member cannot see the org-wide connection.");
        ctx.assert(mine.connectedForMe === false, "Member's account should not be connected yet at flow start.");
      },
    },
    {
      name: "Desktop app boots",
      run: async (ctx) => {
        await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000 });
      },
    },
    {
      name: "Member signs the desktop app into OpenWork Cloud (real handoff grant)",
      run: async (ctx) => {
        const alreadySignedIn = await ctx.eval("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())");
        if (!alreadySignedIn) {
          await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 30_000, label: "desktop bridge" });
          const bootstrap = {
            baseUrl: DEN_API_URL,
            apiBaseUrl: DEN_API_URL,
            requireSignin: false,
            handoff: null,
          };
          const written = await ctx.eval(`(async () => {
            const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
            if (!bridge) return { ok: false };
            await bridge("setDesktopBootstrapConfig", ${JSON.stringify(bootstrap)});
            return { ok: true };
          })()`, { awaitPromise: true });
          ctx.assert(written?.ok, "Failed to write desktop bootstrap config.");
          await ctx.eval(`(() => {
            localStorage.setItem('openwork.den.baseUrl', ${JSON.stringify(DEN_API_URL)});
            localStorage.setItem('openwork.den.apiBaseUrl', ${JSON.stringify(DEN_API_URL)});
            return true;
          })()`);
          await ctx.eval("location.reload()");
          await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after bootstrap reload" });
          const handoff = await denApiFetch("/v1/auth/desktop-handoff", {
            method: "POST",
            headers: { authorization: `Bearer ${state.memberSession}` },
            body: JSON.stringify({ desktopScheme: "openwork" }),
          });
          ctx.assert(handoff.response.ok, `Handoff create failed: ${handoff.response.status}`);
          await ctx.control("auth.exchange-grant", { grant: handoff.body.grant, baseUrl: DEN_API_URL });
        }
        await ctx.waitFor(
          "Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())",
          { timeoutMs: 45_000, label: "persisted den auth token" },
        );
        await ctx.waitFor(
          "Boolean((localStorage.getItem('openwork.den.activeOrgId') ?? '').trim())",
          { timeoutMs: 60_000, label: "active org resolved" },
        );
      },
    },
    {
      name: "A workspace exists (onboarding handled)",
      run: async (ctx) => {
        const inWorkspace = await ctx.eval("window.location.hash.includes('/workspace/')");
        if (inWorkspace) return;
        await ctx.clickText("Continue with organization", { timeoutMs: 20_000 }).catch(() => {});
        await ctx.clickText("Continue to workspace", { timeoutMs: 30_000 }).catch(() => {});
        await ctx.waitFor(
          "Boolean(document.querySelector('input[placeholder=\"/workspace/my-project\"]')) || window.location.hash.includes('/workspace/')",
          { timeoutMs: 30_000, label: "folder form or workspace" },
        );
        const needsFolder = await ctx.eval("Boolean(document.querySelector('input[placeholder=\"/workspace/my-project\"]'))");
        if (needsFolder) {
          await ctx.fill('input[placeholder="/workspace/my-project"]', WORKSPACE_PATH);
          await ctx.clickText("Use this folder", { timeoutMs: 20_000 });
        }
        await ctx.waitFor("window.location.hash.includes('/workspace/')", { timeoutMs: 60_000, label: "workspace open" });
        await ctx.eval(`(() => {
          const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Continue without OpenWork Models');
          btn?.click();
          return true;
        })()`);
      },
    },
    {
      name: "The desktop's own Extensions UI discovers the org connection, not yet connected",
      run: async (ctx) => {
        const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? null");
        ctx.assert(Boolean(workspaceId), "No workspace id in URL.");
        await ctx.navigateHash(`/workspace/${workspaceId}/settings/extensions/mcp`);
        // The settings route can stay mounted across hash navigation within
        // the same session, so its org-connections fetch (mount-once) may
        // predate a connection created moments ago by this same test run.
        // Refresh is exactly what a real user would click for "show me what
        // just got published" — this also exercises that the button's wiring
        // to the org connections store actually works.
        await ctx.clickText("Refresh", { timeoutMs: 15_000 }).catch(() => {});
        await ctx.prove("The 'From your organization' section renders the admin-published connection, showing it's not yet connected", {
          assert: async () => {
            // The section header is rendered with a CSS uppercase transform
            // (text-transform, not literal casing) — innerText reflects the
            // rendered case, so match case-insensitively for this one.
            await ctx.waitFor(
              `document.body.innerText.toLowerCase().includes("from your organization")`,
              { timeoutMs: 60_000, label: `section header "From your organization"` },
            );
            await ctx.expectText(CONNECTION_NAME, { timeoutMs: 30_000 });
            await ctx.expectText("Connect your account", { timeoutMs: 10_000 });
          },
          screenshot: {
            name: "org-mcp-not-connected",
            claim: "The desktop's Settings > Extensions > MCP page shows the org-published connection with a 'Connect your account' action, discovered from Den — not a locally-configured Quick Connect entry.",
            // Section header renders visually uppercase via CSS text-transform.
            requireText: ["FROM YOUR ORGANIZATION", CONNECTION_NAME, "Connect your account"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Clicking Connect drives a real connect/start call, and the OS browser it opens completes a real, connection-specific OAuth round trip",
      run: async (ctx) => {
        state.clickedAt = new Date().toISOString();
        await ctx.clickText(CONNECTION_NAME, { timeoutMs: 20_000 });

        // The click's only observable effect from here is server-side: Den's
        // connect/start call, then the OS browser's real GET /authorize
        // against the mock IdP (which, auto-approving, immediately drives
        // the rest of the exchange itself — no scripted replay needed).
        let authorizeRequest = null;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !authorizeRequest) {
          const { requests } = await fetch(`${MOCK_SERVER_URL}/requests`).then((r) => r.json());
          authorizeRequest = requests.find((entry) => entry.method === "GET" && entry.path === "/authorize" && entry.at >= state.clickedAt) ?? null;
          if (!authorizeRequest) await new Promise((resolve) => setTimeout(resolve, 500));
        }
        ctx.assert(Boolean(authorizeRequest), "No GET /authorize reached the mock IdP after the Connect click — openDesktopUrl was not driven with a real URL.");
        const params = new URL(`${MOCK_SERVER_URL}${authorizeRequest.url}`).searchParams;
        ctx.assert(Boolean(params.get("state")), "Authorize request is missing the signed state param.");
        ctx.assert(Boolean(params.get("client_id")), "Authorize request is missing a dynamically-registered client_id.");
        ctx.assert(
          (params.get("redirect_uri") ?? "").includes(state.connectionId),
          `Authorize request's redirect_uri is not scoped to this connection: ${params.get("redirect_uri")}`,
        );
        ctx.log(`Real GET /authorize reached the mock IdP: ${authorizeRequest.url}`);
      },
    },
    {
      name: "Without a page reload, the same card in the desktop UI flips to Connected",
      run: async (ctx) => {
        await ctx.prove("The desktop app's own polling loop — not a manual refresh — detects the completed connection and updates the card", {
          assert: async () => {
            await ctx.waitFor(
              `(() => {
                const buttons = [...document.querySelectorAll("button")];
                const card = buttons.find((el) => el.textContent.includes(${JSON.stringify(CONNECTION_NAME)}));
                return Boolean(card && card.textContent.includes("Connected") && !card.textContent.includes("Connect your account"));
              })()`,
              { timeoutMs: 90_000, label: "card flips to Connected" },
            );
          },
          screenshot: {
            name: "org-mcp-connected",
            claim: "After completing the OAuth round trip, the SAME card (no page reload) now shows Connected — proving the desktop app's connect-polling loop works end to end.",
            requireText: [CONNECTION_NAME, "Connected"],
            rejectText: ["Connect your account", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        if (state.connectionId) {
          const removed = await denApiFetch(`/v1/mcp-connections/${state.connectionId}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${state.adminSession}` },
          });
          ctx.assert(removed.response.ok, "Cleanup delete failed.");
        }
      },
    },
  ],
};
