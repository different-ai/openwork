/**
 * The LAST leg of the per-member MCP connection story — the part that
 * happens in the OpenWork DESKTOP APP, from the member's point of view:
 *
 *   Given an org admin already published a per-member connection in Den and
 *   the member (Jordan) already connected his own account (that half is
 *   proven browser-first in mcp-connections-member-scoped.flow.mjs; here
 *   the same real HTTP round trips run as setup), then:
 *
 *   1. Jordan signs the DESKTOP APP into OpenWork Cloud (real handoff
 *      grant exchange against the local Den).
 *   2. The app auto-configures "OpenWork Cloud Control" — the /mcp/agent
 *      connection whose only tools are search_capabilities and
 *      execute_capability — with a token minted for JORDAN.
 *   3. In a real chat session, the agent is asked to find and run the echo
 *      capability. It calls search_capabilities -> finds the org's
 *      connection's real tool -> execute_capability -> Den executes it
 *      against the external MCP server using JORDAN'S OWN stored
 *      credential -> the exact result appears in the chat UI.
 *   4. The external server's own request log confirms a fresh tools/call
 *      landed during the chat — the call really traveled
 *      desktop -> Den -> external MCP, not a cached or simulated response.
 *
 * Prerequisites:
 * - Desktop app from this worktree running with CDP (fresh userdata is
 *   fine; the flow handles onboarding) — pass --cdp-url.
 * - den-api at OPENWORK_EVAL_DEN_API_URL with the seeded demo org.
 * - Mock OAuth+MCP server at MOCK_OAUTH_MCP_URL (reachable from den-api).
 * - Member account per mcp-connections-member-scoped.flow.mjs (bootstrapped
 *   automatically with OPENWORK_EVAL_MARK_VERIFIED_CMD if missing).
 * - A working default model in the app (OpenCode Zen "Big Pickle" works
 *   with zero keys) — this flow drives a REAL agent turn.
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
const CONNECTION_NAME = `team-tool-${RUN_TAG}`;
const ECHO_TEXT = `desktop e2e proof ${RUN_TAG}`;
const WORKSPACE_PATH = "/tmp/openwork-mcp-desktop-e2e";

const state = {
  adminSession: null,
  memberSession: null,
  connectionId: null,
  chatStartedAt: null,
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
  id: "mcp-connections-desktop-e2e",
  title: "Desktop app: the member's agent finds and executes an org MCP connection as them, in real chat",
  spec: "evals/cloud-mcp-agent-flows.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Setup: admin publishes per-member connection; member's account is connected (real HTTP round trips)",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        ctx.assert(Boolean(health?.ok), `Mock OAuth+MCP server not reachable at ${MOCK_SERVER_URL}.`);

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

        // Clean leftovers, then publish a fresh per-member connection.
        const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        for (const connection of existing.body.connections ?? []) {
          if (connection.name.startsWith("team-tool-") || connection.name.startsWith("restricted-tool-")) {
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

        // Member connects his own account: the same real
        // discovery/registration/PKCE/token-exchange round trips the
        // browser popup performs (browser leg proven in
        // mcp-connections-member-scoped.flow.mjs).
        const start = await denApiFetch(`/v1/mcp-connections/${state.connectionId}/connect/start`, {
          headers: { authorization: `Bearer ${state.memberSession}` },
        });
        ctx.assert(start.response.ok && start.body.status === "needs_auth", `connect/start unexpected: ${JSON.stringify(start.body).slice(0, 200)}`);
        const authorizeResponse = await fetch(start.body.authorizeUrl, { redirect: "manual" });
        const callbackUrl = authorizeResponse.headers.get("location")
        ctx.assert(Boolean(callbackUrl), "Authorize did not redirect to the callback.");
        const callback = await fetch(callbackUrl)
        ctx.assert(callback.ok, `Callback failed: ${callback.status}`);

        const usable = await denApiFetch("/v1/mcp-connections?scope=usable", {
          headers: { authorization: `Bearer ${state.memberSession}` },
        });
        const mine = (usable.body.connections ?? []).find((entry) => entry.id === state.connectionId);
        ctx.assert(mine?.connectedForMe === true, "Member's account is not connected after the OAuth dance.");
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
          // Point the app at the local Den control plane the designed way:
          // desktop-bootstrap.json (via the desktop bridge). Everything
          // derives from it — including getDenMcpUrl(), which the cloud MCP
          // auto-config uses; localStorage overrides alone are not enough.
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
        // Fresh userdata + cloud sign-in: org picker -> resources -> folder.
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
        // Dismiss the OpenWork Models upsell if it appears.
        await ctx.eval(`(() => {
          const btn = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Continue without OpenWork Models');
          btn?.click();
          return true;
        })()`);
      },
    },
    {
      name: "OpenWork Cloud Control auto-configures with the member's token",
      run: async (ctx) => {
        // The auto-sync runs while the settings route is mounted — same as a
        // real user visiting settings once after sign-in.
        const workspaceId = await ctx.eval("(window.location.hash.match(/\\/workspace\\/([^/]+)/) ?? [])[1] ?? null");
        ctx.assert(Boolean(workspaceId), "No workspace id in URL.");
        await ctx.navigateHash(`/workspace/${workspaceId}/settings/extensions/mcp`);
        await ctx.waitFor(
          "Boolean(localStorage.getItem('openwork.den.mcp.sync'))",
          { timeoutMs: 120_000, label: "openwork.den.mcp.sync marker" },
        );
        ctx.log(`marker: ${await ctx.eval("localStorage.getItem('openwork.den.mcp.sync')")}`);
        await ctx.prove("OpenWork Cloud Control is configured in the member's app", {
          assert: async () => {
            await ctx.expectText("OpenWork Cloud Control", { timeoutMs: 30_000 });
          },
          screenshot: {
            name: "desktop-cloud-control-configured",
            claim: "The member's desktop app auto-configured the OpenWork Cloud Control connection after cloud sign-in.",
            requireText: ["OpenWork Cloud Control"],
            rejectText: ["Something went wrong"],
          },
        });
        await ctx.navigateHash(`/workspace/${workspaceId}/session`);
        await ctx.waitFor("window.location.hash.includes('/session')", { timeoutMs: 20_000 });
      },
    },
    {
      name: "In real chat, the agent finds and executes the org connection's tool as the member",
      run: async (ctx) => {
        state.chatStartedAt = new Date().toISOString();
        await ctx.prove("The member asks their AI coworker; it uses search_capabilities + execute_capability and the exact result comes back in the chat", {
          action: async () => {
            // A new task in the workspace.
            const inSession = await ctx.eval("Boolean(document.querySelector('[contenteditable=\"true\"][data-lexical-editor=\"true\"]'))");
            if (!inSession) {
              await ctx.waitFor(
                "window.__openworkControl?.listActions?.().find((a) => a.id === 'session.create_task')?.disabled === false",
                { timeoutMs: 30_000, label: "session.create_task enabled" },
              );
              await ctx.control("session.create_task");
            }
            await ctx.waitFor(
              "Boolean(document.querySelector('[contenteditable=\"true\"][data-lexical-editor=\"true\"]'))",
              { timeoutMs: 30_000, label: "composer" },
            );
            const prompt = `Use the OpenWork Cloud Control connection: call search_capabilities with query "echo", then call execute_capability with the exact match name and body {"text":"${ECHO_TEXT}"}. Reply with the exact text the tool returned.`;
            await ctx.eval(`(() => {
              const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
              editor.focus();
              const data = new DataTransfer();
              data.setData('text/plain', ${JSON.stringify(prompt)});
              editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
              return editor.innerText.length > 0;
            })()`);
            await ctx.clickText("Run task", { timeoutMs: 15_000 });
          },
          assert: async () => {
            // Wait for the assistant to finish (Stop gone) AND the echoed
            // text to appear at least twice: once in the user's prompt
            // bubble, once in the real tool result / reply.
            await ctx.waitFor(
              `!Boolean([...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stop'))`,
              { timeoutMs: 180_000, label: "assistant finished" },
            );
            await ctx.waitFor(
              `(document.body.innerText.match(new RegExp(${JSON.stringify(ECHO_TEXT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}, 'g')) ?? []).length >= 2`,
              { timeoutMs: 60_000, label: "echoed text in prompt AND result" },
            );
            await new Promise((resolve) => setTimeout(resolve, 700));
          },
          screenshot: {
            name: "desktop-agent-executed",
            claim: "The member's agent, in the real desktop chat, executed the org's per-member MCP connection and the exact result came back.",
            requireText: [ECHO_TEXT],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "The external MCP server's own log confirms a fresh call landed during the chat",
      run: async (ctx) => {
        const response = await fetch(`${MOCK_SERVER_URL}/requests`);
        const { requests } = await response.json();
        const fresh = requests.filter((entry) => entry.method === "POST" && entry.path === "/mcp" && entry.at >= state.chatStartedAt);
        ctx.assert(fresh.length > 0, `No POST /mcp on the external server after ${state.chatStartedAt} — the chat result did not come from a real call.`);
        ctx.log(`External server saw ${fresh.length} fresh MCP POSTs during the chat.`);
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
