/**
 * The multi-tenant / per-employee story for MCP Connections, proven as two
 * real people in a real browser — the demo script, executed:
 *
 *   1. ADMIN (Alex) signs in to den-web, opens MCP Connections, and adds a
 *      per-member connection ("each person connects their own account"),
 *      granted to everyone — through the real Add Custom dialog, including
 *      the new credential-mode and who-can-use-this pickers.
 *   2. Admin signs out. MEMBER (Jordan, a real second account) signs in,
 *      opens the member-facing "Your Connections" page, sees the connection
 *      marked "Connect your account", clicks Connect — a real browser popup
 *      completes the full OAuth dance (RFC 9728 discovery + dynamic client
 *      registration + PKCE) against a self-controlled stand-in server — and
 *      the row flips to "Connected as you" via Den's own polling.
 *   3. The agent surface then acts AS JORDAN: search_capabilities (with
 *      Jordan's MCP token) finds the connection's real tool, and
 *      execute_capability calls it using Jordan's own stored credential.
 *   4. Negative cases, same session: a second connection scoped to a team
 *      Jordan is not in is invisible to his search and forbidden to his
 *      execute; and the ADMIN's own search returns a needs_connection hint
 *      for the per-member connection (he never connected his account).
 *
 * Prerequisites (same as mcp-connections-cloud-oauth, plus a member user):
 * - den-api at OPENWORK_EVAL_DEN_API_URL, den-web at OPENWORK_EVAL_DEN_WEB_URL.
 * - Mock OAuth+MCP server reachable at MOCK_OAUTH_MCP_URL from den-api.
 * - Admin: OPENWORK_EVAL_DEMO_EMAIL/PASSWORD (default seeded alex@acme.test).
 * - Member: OPENWORK_EVAL_MEMBER_EMAIL/PASSWORD (default
 *   jordan.demo@acme.test / OpenWorkDemo123!). If the member can't sign in,
 *   the flow bootstraps them for real (admin invitation -> sign-up ->
 *   accept); the one non-API step is email verification, which requires
 *   OPENWORK_EVAL_MARK_VERIFIED_CMD — a shell template with {email}, e.g.
 *   docker exec ... mysql ... "UPDATE user SET email_verified=1 WHERE email='{email}'"
 *   (a seed affordance: invitation accept legitimately requires a verified
 *   email, and evals have no inbox).
 * - --cdp-url at a Chrome with --disable-popup-blocking.
 */

import { execSync } from "node:child_process";
import { denApiFetch, denApiUrl, openAdminConnections, openYourConnections, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const RUN_TAG = Date.now();
const CONNECTION_NAME = `team-tool-${RUN_TAG}`;
const RESTRICTED_NAME = `restricted-tool-${RUN_TAG}`;
const ECHO_TEXT = `member scoped proof ${RUN_TAG}`;

const state = {
  adminSession: null,
  memberSession: null,
  connectionId: null,
  restrictedConnectionId: null,
  createdTeamId: null,
};

async function mcpAgentCall(mcpToken, method, params, ctx) {
  const response = await fetch(`${denApiUrl()}/mcp/agent`, {
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

async function mintMcpToken(sessionToken, ctx) {
  const { response, body } = await denApiFetch("/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
    body: "{}",
  });
  ctx.assert(response.ok, `Minting an MCP token failed: ${response.status}`);
  return body.token;
}

export default {
  id: "mcp-connections-member-scoped",
  title: "Per-member MCP connections: admin publishes, employee connects their own account, agent acts as them, grants enforced",
  spec: "evals/cloud-mcp-agent-flows.md",
  preserveTheme: true,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Stack reachable; admin and member accounts sign in (member bootstrapped for real if missing)",
      run: async (ctx) => {
        const health = await fetch(`${MOCK_SERVER_URL}/health`).catch(() => null);
        ctx.assert(Boolean(health?.ok), `Mock OAuth+MCP server not reachable at ${MOCK_SERVER_URL}.`);

        state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
        ctx.assert(Boolean(state.adminSession), `Admin sign-in failed for ${ADMIN_EMAIL}.`);

        state.memberSession = await signInApi(MEMBER_EMAIL, MEMBER_PASSWORD);
        if (!state.memberSession) {
          ctx.log(`Member ${MEMBER_EMAIL} can't sign in yet — bootstrapping via real invitation flow.`);
          const invite = await denApiFetch("/v1/invitations", {
            method: "POST",
            headers: { authorization: `Bearer ${state.adminSession}` },
            body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
          });
          ctx.assert(invite.response.ok, `Invitation failed: ${invite.response.status} ${JSON.stringify(invite.body).slice(0, 200)}`);
          const signUp = await denApiFetch("/api/auth/sign-up/email", {
            method: "POST",
            body: JSON.stringify({ email: MEMBER_EMAIL, name: "Jordan Demo", password: MEMBER_PASSWORD }),
          });
          ctx.assert(signUp.response.ok, `Member sign-up failed: ${signUp.response.status}`);
          ctx.assert(
            MARK_VERIFIED_CMD.length > 0,
            "Member email must be verified to accept the invitation; set OPENWORK_EVAL_MARK_VERIFIED_CMD (shell template with {email}).",
          );
          execSync(MARK_VERIFIED_CMD.replaceAll("{email}", MEMBER_EMAIL), { stdio: "ignore" });
          state.memberSession = await signInApi(MEMBER_EMAIL, MEMBER_PASSWORD);
          ctx.assert(Boolean(state.memberSession), "Member sign-in still failing after sign-up.");
          const accept = await denApiFetch("/v1/orgs/invitations/accept", {
            method: "POST",
            headers: { authorization: `Bearer ${state.memberSession}` },
            body: JSON.stringify({ id: invite.body.inviteToken }),
          });
          ctx.assert(accept.response.ok && accept.body.accepted, `Invitation accept failed: ${JSON.stringify(accept.body).slice(0, 200)}`);
        }

        // Clean up leftovers from earlier aborted runs so re-runs stay honest.
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
      },
    },
    {
      name: "Admin signs in to den-web (browser)",
      run: async (ctx) => {
        await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
      },
    },
    {
      name: "Admin publishes a per-member connection for everyone via the real dialog",
      run: async (ctx) => {
        await openAdminConnections(ctx);
        await ctx.waitForText("Add Custom", { timeoutMs: 20_000 });
        await ctx.clickText("Add Custom", { timeoutMs: 20_000 });
        await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"notion\"]'))", { timeoutMs: 10_000, label: "dialog open" });
        await ctx.fill('input[placeholder="notion"]', CONNECTION_NAME);
        await ctx.fill('input[placeholder="https://mcp.example.com/mcp"]', `${MOCK_SERVER_URL}/mcp`);
        await ctx.clickText("Individual accounts", { timeoutMs: 10_000 });

        await ctx.prove("The Add dialog offers per-member credentials and an access picker", {
          assert: async () => {
            await ctx.expectText("Individual accounts");
            await ctx.expectText("Who can use this?");
            await ctx.expectText("Everyone in the org");
            await ctx.expectText("acts as them, with their permissions");
          },
          screenshot: {
            name: "admin-dialog-per-member",
            claim: "Admin chooses per-member credentials and who can use the connection, in one dialog.",
            requireText: ["Individual accounts", "Who can use this?", "Everyone in the org"],
            rejectText: ["Something went wrong"],
          },
        });

        await ctx.clickText("Add connection", { timeoutMs: 15_000 });
        await ctx.prove("The published connection shows per-member + everyone badges, with no admin OAuth step", {
          assert: async () => {
            await ctx.waitForText("Individual accounts", { timeoutMs: 20_000 });
            await ctx.expectText(CONNECTION_NAME);
            await ctx.expectText("Everyone in the org");
            await ctx.eval(`(() => {
              const row = [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && (el.textContent ?? "").trim() === ${JSON.stringify(CONNECTION_NAME)});
              row?.scrollIntoView({ block: "center" });
              return Boolean(row);
            })()`);
          },
          screenshot: {
            name: "admin-connection-published",
            claim: "The connection row shows Individual accounts and Everyone in the org — published, nothing to authorize as admin.",
            requireText: [CONNECTION_NAME, "Individual accounts", "Everyone in the org"],
            rejectText: ["Something went wrong", "Waiting for authorization"],
          },
        });

        const list = await denApiFetch("/v1/mcp-connections?scope=manageable", {
          headers: { authorization: `Bearer ${state.adminSession}` },
        });
        const created = (list.body.connections ?? []).find((entry) => entry.name === CONNECTION_NAME);
        ctx.assert(Boolean(created), "Created connection not found via API.");
        state.connectionId = created.id;

        // Also create the negative-case connection: scoped to a team the
        // member is NOT in (first team in the org — the bootstrapped member
        // has no team memberships). Seeds without teams get one created for
        // real via the Teams API (removed again in cleanup).
        const org = await denApiFetch("/v1/org", { headers: { authorization: `Bearer ${state.adminSession}` } });
        let team = (org.body.teams ?? [])[0];
        if (!team) {
          const createdTeam = await denApiFetch("/v1/teams", {
            method: "POST",
            headers: { authorization: `Bearer ${state.adminSession}` },
            body: JSON.stringify({ name: `eval-restricted-${RUN_TAG}` }),
          });
          ctx.assert(createdTeam.response.ok, `Creating a team for the negative case failed: ${createdTeam.response.status}`);
          team = createdTeam.body.team;
          state.createdTeamId = team?.id ?? null;
        }
        ctx.assert(Boolean(team?.id), "Org has no teams to scope the restricted connection to.");
        const restricted = await denApiFetch("/v1/mcp-connections", {
          method: "POST",
          headers: { authorization: `Bearer ${state.adminSession}` },
          body: JSON.stringify({
            name: RESTRICTED_NAME,
            url: `${MOCK_SERVER_URL}/mcp`,
            authType: "oauth",
            credentialMode: "shared",
            access: { teamIds: [team.id] },
          }),
        });
        ctx.assert(restricted.response.ok, `Restricted connection create failed: ${restricted.response.status}`);
        state.restrictedConnectionId = restricted.body.id;
      },
    },
    {
      name: "Member signs in and sees only what they were granted",
      run: async (ctx) => {
        await signInViaBrowser(ctx, MEMBER_EMAIL, MEMBER_PASSWORD);
        await openYourConnections(ctx);
        await ctx.prove("The member-facing Your Connections page shows the granted connection needing their account — and NOT the team-restricted one", {
          assert: async () => {
            await ctx.waitForText(CONNECTION_NAME, { timeoutMs: 20_000 });
            await ctx.expectText("Connect your account");
            await ctx.expectNoText(RESTRICTED_NAME);
          },
          screenshot: {
            name: "member-your-connections",
            claim: "Jordan sees the org-wide per-member connection (Connect your account) and cannot see the team-restricted one.",
            requireText: [CONNECTION_NAME, "Connect your account"],
            rejectText: [RESTRICTED_NAME, "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Member connects their own account through a real OAuth popup",
      run: async (ctx) => {
        // Exact-match click: clickText substring-matches, and the sidebar
        // "Your Connections" link also contains "Connect".
        const clicked = await ctx.eval(`(() => {
          const button = [...document.querySelectorAll('button')].find((el) => el.textContent.trim() === 'Connect');
          if (!button) return false;
          button.click();
          return true;
        })()`);
        ctx.assert(clicked, "No Connect button found on the member's connection row.");
        await ctx.prove("A real popup completes discovery + dynamic client registration + PKCE for the member's own account", {
          action: async () => {
            await ctx.switchToNewTab({ timeoutMs: 20_000, label: "OAuth popup" });
            await ctx.waitForText("Connected", { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(CONNECTION_NAME);
            await ctx.expectNoText("Connection failed");
          },
          screenshot: {
            name: "member-oauth-popup",
            claim: "The OAuth popup shows a real success page for the member's own authorization.",
            requireText: ["Connected", CONNECTION_NAME],
            rejectText: ["Connection failed"],
          },
        });
        ctx.switchBack();

        await ctx.prove("Den's own polling flips the row to Connected as you", {
          assert: async () => {
            await ctx.waitForText("Connected as you", { timeoutMs: 60_000 });
          },
          screenshot: {
            name: "member-connected-as-you",
            claim: "Jordan's row shows Connected as you — his credential, not a shared org account.",
            requireText: [CONNECTION_NAME, "Connected as you"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "The agent acts as the member: search finds the tool, execute uses THEIR credential, grants are enforced",
      run: async (ctx) => {
        await ctx.prove("search/execute run as Jordan with his own account; the restricted connection is invisible and forbidden; the admin gets a needs_connection hint", {
          assert: async () => {
            const memberMcp = await mintMcpToken(state.memberSession, ctx);

            // 1. Member search finds the real tool on the granted connection.
            const search = await mcpAgentCall(memberMcp, "tools/call", {
              name: "search_capabilities",
              arguments: { query: "echo" },
            }, ctx);
            const searchText = search.content[0].text;
            ctx.assert(searchText.includes(`mcp:${state.connectionId}:mock_echo`), `Member search missing granted tool: ${searchText.slice(0, 300)}`);
            ctx.assert(!searchText.includes(state.restrictedConnectionId), "Member search leaked the team-restricted connection.");

            // 2. Execute uses Jordan's own stored credential and echoes exactly.
            const execute = await mcpAgentCall(memberMcp, "tools/call", {
              name: "execute_capability",
              arguments: { name: `mcp:${state.connectionId}:mock_echo`, body: { text: ECHO_TEXT } },
            }, ctx);
            ctx.assert(execute.content?.[0]?.text === ECHO_TEXT, `Execute didn't echo exactly: ${JSON.stringify(execute).slice(0, 300)}`);

            // 3. The restricted connection is forbidden to execute.
            const forbidden = await mcpAgentCall(memberMcp, "tools/call", {
              name: "execute_capability",
              arguments: { name: `mcp:${state.restrictedConnectionId}:mock_echo`, body: { text: "should fail" } },
            }, ctx);
            ctx.assert(forbidden.isError === true, "Restricted execute should be an error.");
            ctx.assert(String(forbidden.content?.[0]?.text ?? "").includes("forbidden"), `Expected forbidden, got: ${JSON.stringify(forbidden).slice(0, 300)}`);

            // 4. The ADMIN never connected his own account: his search gets a
            //    needs_connection hint instead of silence.
            const adminMcp = await mintMcpToken(state.adminSession, ctx);
            const adminSearch = await mcpAgentCall(adminMcp, "tools/call", {
              name: "search_capabilities",
              arguments: { query: "team tool" },
            }, ctx);
            const adminText = adminSearch.content[0].text;
            ctx.assert(adminText.includes("needs_connection"), `Admin search missing needs_connection hint: ${adminText.slice(0, 300)}`);
            ctx.assert(adminText.includes("Your Connections"), "needs_connection hint should point at Your Connections.");
          },
        });
      },
    },
    {
      name: "Cleanup (delete run connections)",
      run: async (ctx) => {
        for (const id of [state.connectionId, state.restrictedConnectionId]) {
          if (!id) continue;
          const removed = await denApiFetch(`/v1/mcp-connections/${id}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${state.adminSession}` },
          });
          ctx.assert(removed.response.ok, `Cleanup delete failed for ${id}.`);
        }
        if (state.createdTeamId) {
          const removedTeam = await denApiFetch(`/v1/teams/${state.createdTeamId}`, {
            method: "DELETE",
            headers: { authorization: `Bearer ${state.adminSession}` },
          });
          ctx.assert(removedTeam.response.ok, `Cleanup delete failed for team ${state.createdTeamId}.`);
        }
      },
    },
  ],
};
