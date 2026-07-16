import { execSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { denApiFetch, denApiUrl, denWebUrl, mcpAgentCall, mintMcpToken, signInApi, signInViaBrowser } from "./lib/den-web.mjs";

const FLOW_ID = "marketplace-plugin-mcp-auth";

// Narration is loaded from the approved script (evals/voiceovers/marketplace-plugin-mcp-auth.md).
// The runner fails this flow if the narration drifts from that script.
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const DEN_API_URL = denApiUrl();
const DEN_WEB_URL = denWebUrl();
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MAYA_EMAIL = process.env.OPENWORK_EVAL_MAYA_EMAIL?.trim() || process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "maya.support@acme.test";
const MAYA_PASSWORD = process.env.OPENWORK_EVAL_MAYA_PASSWORD?.trim() || process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const PLATFORM_ADMIN_EMAIL = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL?.trim() || "";
const PLATFORM_ADMIN_PASSWORD = process.env.OPENWORK_EVAL_PLATFORM_ADMIN_PASSWORD?.trim() || "";
const MOCK_PORT = Number(process.env.OPENWORK_EVAL_MARKETPLACE_SLACK_MOCK_PORT ?? 4537);
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const MOCK_MCP_URL = process.env.OPENWORK_EVAL_MARKETPLACE_SLACK_MCP_URL?.trim() || `${MOCK_BASE}/mcp`;
const MOCK_ISSUER = new URL(MOCK_MCP_URL).origin;
const MOCK_CLIENT_ID = process.env.MOCK_CLIENT_ID || "mock-preregistered-client";
const MOCK_CLIENT_SECRET = process.env.MOCK_CLIENT_SECRET || "mock-preregistered-secret";
const MOCK_SERVER_SCRIPT = fileURLToPath(new URL("../../scripts/mock-oauth-mcp-server.mjs", import.meta.url));
const RUN_TAG = Date.now().toString(36);
const MARKETPLACE_NAME = `Support Operations Library ${RUN_TAG}`;
const PLUGIN_NAME = "Support Operations";
const SUPPORT_TEAM_NAME = "Support";
const MCP_SERVER_NAME = "Slack";
const EXTERNAL_TOOL_NAME = "create_shift_handoff";
const EXTERNAL_TOOL_RESULT = "SHIFT_HANDOFF_READY";
const HANDOFF_QUERY = "handoff unresolved support issues shift";
const TOOL_SEARCH_QUERY = "Support Operations Slack shift handoff";
const SKILL_NAMES = [
  "Triage support channel",
  "Prepare escalation brief",
  "Create shift handoff",
];

const state = {
  adminSession: null,
  mayaSession: null,
  orgId: null,
  orgSlug: null,
  adminMemberId: null,
  mayaMemberId: null,
  supportTeamId: null,
  createdSupportTeam: false,
  marketplaceId: null,
  pluginId: null,
  skillConfigObjectIds: [],
  mcpConfigObjectId: null,
  connectionId: null,
  yourConnectionsUrl: null,
  mcpToken: null,
  toolsListPayload: null,
  skillSearchPayload: null,
  skillExecutePayload: null,
  retrySkillSearchPayload: null,
  retrySkillExecutePayload: null,
  externalToolSearchPayload: null,
  externalToolExecutePayload: null,
  shiftHandoffCapabilityName: null,
  externalToolCapabilityName: null,
};

let mockChild = null;

export default {
  id: FLOW_ID,
  title: "Assigned marketplace plugin skills guide each member through their required MCP connection",
  kind: "user-facing",
  preserveTheme: true,
  spec: "evals/voiceovers/marketplace-plugin-mcp-auth.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"],
  steps: [
    {
      name: "Setup",
      run: async (ctx) => {
        await startMock(ctx);
        await ensureAdminContext(ctx);
        await ensureMcpConnectionsCapability(ctx);
        await ensureMayaMember(ctx);
        await ensureSupportTeam(ctx);
        await cleanupSeededResources(ctx);
        await seedMarketplace(ctx);
      },
    },
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Alex grants the Support team access to the one-plugin Support Operations marketplace", {
          voiceover: vo[0],
          action: async () => {
            await signInViaBrowser(ctx, ADMIN_EMAIL, ADMIN_PASSWORD);
            await setBrowserActiveOrganization(ctx);
            await installEvalFetchPatch(ctx);
            await openMarketplaceDetailViaUi(ctx);
            await grantSupportTeamViaUi(ctx);
          },
          assert: async () => {
            const uiState = await readMarketplaceDetailUi(ctx);
            ctx.assert(uiState.bodyText.includes(MARKETPLACE_NAME), "Marketplace detail title is not visible.");
            ctx.assert(uiState.bodyText.includes(SUPPORT_TEAM_NAME), "Support team grant is not visible on the marketplace detail page.");
            ctx.assert(uiState.bodyText.includes(PLUGIN_NAME), "Support Operations plugin is not visible on the marketplace detail page.");
            ctx.assert(uiState.bodyText.includes("3 skills"), `Plugin skill count is not visible: ${uiState.pluginCardText}`);
            ctx.assert(uiState.bodyText.includes("1 MCP server"), `Plugin MCP count is not visible: ${uiState.pluginCardText}`);
            await assertMarketplaceComposition(ctx);
          },
          screenshot: {
            name: "frame-1-support-marketplace-assigned",
            claim: "Alex grants Support access to a marketplace containing only Support Operations with three skills and Slack MCP.",
            requireText: [MARKETPLACE_NAME, "WHO CAN ACCESS THIS", SUPPORT_TEAM_NAME, PLUGIN_NAME, "skills", "MCP server"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("Alex opens the missing Slack setup dialog and sees the read-only plugin-declared URL", {
          voiceover: vo[1],
          action: async () => {
            await openSlackSetupDialog(ctx);
            await openWhoSignsInPicker(ctx);
          },
          assert: async () => {
            await ctx.expectText("Set up Slack");
            await ctx.expectText("Plugin-declared URL");
            await ctx.expectText("Read-only. The URL comes from the plugin and is verified server-side.");
            await ctx.expectText("Each user connects their own account");
            await ctx.expectText("Organization-shared account");
            const dialogState = await ctx.eval(`(() => {
              const text = document.body.innerText;
              const editableUrlFields = [...document.querySelectorAll('input, textarea')]
                .filter((node) => (node.value ?? '').includes(${JSON.stringify(MOCK_MCP_URL)}))
                .map((node) => node.tagName);
              const options = [...document.querySelectorAll('[role="option"]')].map((node) => (node.innerText ?? '').trim());
              return { text, editableUrlFields, options };
            })()`);
            ctx.assert(dialogState.editableUrlFields.length === 0, `Plugin URL appeared in editable fields: ${JSON.stringify(dialogState.editableUrlFields)}`);
            ctx.assert(dialogState.options.includes("Each user connects their own account"), `Individual mode option missing: ${dialogState.options.join(" | ")}`);
            ctx.assert(dialogState.options.includes("Organization-shared account"), `Org-shared mode option missing: ${dialogState.options.join(" | ")}`);
          },
          screenshot: {
            name: "frame-2-slack-setup-dialog",
            claim: "The Slack requirement opens with both sign-in modes and a read-only plugin-declared URL.",
            requireText: ["Set up Slack", "Plugin-declared URL", "Read-only", "Each user connects their own account", "Organization-shared account"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Alex chooses individual accounts and saves the pre-registered Slack OAuth client for the Support-scoped requirement", {
          voiceover: vo[2],
          action: async () => {
            await chooseIndividualAccounts(ctx);
            await fillOAuthClient(ctx);
            await ctx.screenshot("frame-3-slack-oauth-client-entered", {
              claim: "Alex has selected individual accounts and entered the Slack OAuth client data before saving.",
              voiceover: vo[2],
              requireText: ["Set up Slack", "Each user connects their own account", "Slack OAuth app", "Client ID", "Client secret"],
              rejectText: ["Something went wrong"],
            });
            await clickSetupSubmit(ctx);
            await ctx.waitForText("Connection configured", { timeoutMs: 30_000 });
            await ctx.waitFor("Boolean(localStorage.getItem('__marketplacePluginMcpAuthConfigureResponse'))", { timeoutMs: 10_000, label: "captured configure response" });
            const configureLog = await readConfigureLog(ctx);
            state.connectionId = configureLog?.payload?.item?.connection?.id ?? null;
            state.yourConnectionsUrl = configureLog?.payload?.item?.links?.yourConnections ?? null;
          },
          assert: async () => {
            ctx.assert(Boolean(state.connectionId), "Configure response did not include a connection id.");
            ctx.assert(Boolean(state.yourConnectionsUrl), "Configure response did not include a Your Connections URL.");
            await assertConfiguredConnection(ctx);
            await assertAllSkillsSearchableForMaya(ctx);
          },
          screenshot: {
            name: "frame-3-slack-connection-configured",
            claim: "The Slack requirement is configured for individual accounts, scoped by the Support marketplace grant.",
            requireText: ["Connection configured", "Slack", PLUGIN_NAME, "Open Your Connections"],
            rejectText: ["Something went wrong", "Failed to configure connection"],
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Maya's MCP-compatible harness searches OpenWork and finds Create shift handoff from the assigned marketplace", {
          voiceover: vo[3],
          action: async () => {
            await prepareMayaHarness(ctx);
            state.toolsListPayload = await browserMcpCall(ctx, "tools/list", {});
            const searchResult = await browserMcpToolCall(ctx, "search_capabilities", searchArguments());
            state.skillSearchPayload = parseToolJson(searchResult);
            state.shiftHandoffCapabilityName = findCapabilityBySummary(state.skillSearchPayload, "Create shift handoff")?.name ?? null;
            await renderHarness(ctx, "Search result from OpenWork MCP", [
              { title: "Connected MCPs", body: { connected: ["OpenWork MCP"], exposedTools: toolNames(state.toolsListPayload) } },
              { title: "Search request", body: { tool: "search_capabilities", arguments: searchArguments() } },
              { title: "Structured search response", body: state.skillSearchPayload },
            ]);
          },
          assert: async () => {
            const exposedTools = toolNames(state.toolsListPayload);
            ctx.assert(JSON.stringify(exposedTools) === JSON.stringify(["execute_capability", "search_capabilities"]), `Harness should expose only OpenWork MCP search/execute tools: ${JSON.stringify(exposedTools)}`);
            ctx.assert(Boolean(state.shiftHandoffCapabilityName), `Create shift handoff was not found: ${JSON.stringify(state.skillSearchPayload).slice(0, 800)}`);
            ctx.assert(String(state.shiftHandoffCapabilityName).startsWith("plugin:"), `Expected a marketplace plugin capability name, got ${state.shiftHandoffCapabilityName}`);
            await assertNoProviderToolCallBeforeAuth(ctx);
          },
          screenshot: {
            name: "frame-4-harness-search-finds-shift-handoff",
            claim: "Maya's visible harness finds Create shift handoff through OpenWork MCP only.",
            requireText: ["MAYA'S MCP-COMPATIBLE HARNESS", "OpenWork MCP", "search_capabilities", "Create shift handoff", PLUGIN_NAME],
            rejectText: ["Something went wrong", "SHIFT_HANDOFF_READY"],
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Executing the discovered skill returns an actionable Slack needs_connection response and no provider call", {
          voiceover: vo[4],
          action: async () => {
            const executeResult = await browserMcpToolCall(ctx, "execute_capability", executeSkillArguments());
            state.skillExecutePayload = parseToolJson(executeResult);
            state.yourConnectionsUrl = state.skillExecutePayload?.action?.url ?? state.yourConnectionsUrl;
            await renderHarness(ctx, "Execution needs Maya's Slack connection", [
              { title: "Same execute request", body: { tool: "execute_capability", arguments: executeSkillArguments() } },
              { title: "Structured execute response", body: state.skillExecutePayload },
            ]);
          },
          assert: async () => {
            ctx.assert(state.skillExecutePayload?.status === "needs_connection", `Expected needs_connection, got ${JSON.stringify(state.skillExecutePayload).slice(0, 800)}`);
            ctx.assert(String(state.skillExecutePayload?.plugin) === PLUGIN_NAME, "Execute response did not preserve Support Operations provenance.");
            ctx.assert(String(state.skillExecutePayload?.provenance ?? "").includes(PLUGIN_NAME), "Execute response provenance did not name Support Operations.");
            const requirement = (state.skillExecutePayload?.mcpRequirements ?? [])[0];
            ctx.assert(requirement?.name === MCP_SERVER_NAME || requirement?.serverName === MCP_SERVER_NAME, `Slack requirement missing: ${JSON.stringify(requirement)}`);
            assertSameOriginYourConnectionsUrl(ctx, state.skillExecutePayload?.action?.url);
            await assertNoProviderToolCallBeforeAuth(ctx);
          },
          screenshot: {
            name: "frame-5-harness-needs-slack-connection",
            claim: "The harness sees an actionable needs_connection response for Slack with Support Operations provenance.",
            requireText: ["needs_connection", "Slack", PLUGIN_NAME, "Your Connections"],
            rejectText: ["Connection failed", "SHIFT_HANDOFF_READY"],
          },
        });
      },
    },
    {
      name: "Frame 6",
      run: async (ctx) => {
        await ctx.prove("Maya follows the exact Your Connections URL and connects only the focused Slack row", {
          voiceover: vo[5],
          action: async () => {
            await openNeedsConnectionUrl(ctx);
            await ctx.screenshot("frame-6-your-connections-focused-before-click", {
              claim: "The exact action URL opens Your Connections focused on the Slack row that requires Maya's click.",
              voiceover: vo[5],
              requireText: ["Your Connections", "Connect your account", "Required by Support Operations", "Connect"],
              rejectText: ["Nothing has been shared with you yet", "Connection failed"],
            });
            await ctx.switchToNewTab({
              timeoutMs: 20_000,
              label: "Slack mock OAuth popup",
              trigger: () => clickFocusedConnect(ctx),
            });
            await routeLocalSplitOriginCallback(ctx);
            await ctx.waitForText("You're connected", { timeoutMs: 30_000 });
            await ctx.switchBack();
            await waitForConnectedAsMaya(ctx);
          },
          assert: async () => {
            const focusState = await readYourConnectionsFocusState(ctx);
            ctx.assert(focusState.highlightedCount === 1, `Expected exactly one highlighted row: ${JSON.stringify(focusState)}`);
            ctx.assert(focusState.highlightedText.includes("Required by Support Operations"), `Highlighted row missing provenance: ${focusState.highlightedText}`);
            ctx.assert(focusState.highlightedText.includes("Connected as you"), `Highlighted row did not connect as Maya: ${focusState.highlightedText}`);
            const requests = await mockRequests();
            const registerCall = requests.find((entry) => entry.path === "/register");
            ctx.assert(!registerCall, `Pre-registered Slack flow unexpectedly called DCR /register: ${JSON.stringify(registerCall)}`);
          },
          screenshot: {
            name: "frame-6-your-connections-connected-as-you",
            claim: "Your Connections remains focused on the authorized Slack row and shows Connected as you.",
            requireText: ["Your Connections", "Connected as you", "Required by Support Operations"],
            rejectText: ["Connection failed", "Something went wrong"],
          },
        });
      },
    },
    {
      name: "Frame 7",
      run: async (ctx) => {
        await ctx.prove("Maya retries the same request and then executes the discovered Slack MCP tool with her connected account", {
          voiceover: vo[6],
          action: async () => {
            await renderHarness(ctx, "Retry after Maya connects Slack", [
              { title: "Connected MCPs", body: { connected: ["OpenWork MCP"], note: "Maya retries the same search and execute inputs." } },
            ]);
            const retrySearch = await browserMcpToolCall(ctx, "search_capabilities", searchArguments());
            state.retrySkillSearchPayload = parseToolJson(retrySearch);
            const retryExecute = await browserMcpToolCall(ctx, "execute_capability", executeSkillArguments());
            state.retrySkillExecutePayload = parseToolJson(retryExecute);
            const externalSearch = await browserMcpToolCall(ctx, "search_capabilities", toolSearchArguments());
            state.externalToolSearchPayload = parseToolJson(externalSearch);
            state.externalToolCapabilityName = findCapabilityByNameFragment(state.externalToolSearchPayload, EXTERNAL_TOOL_NAME)?.name ?? null;
            const externalExecute = await browserMcpToolCall(ctx, "execute_capability", executeExternalToolArguments());
            state.externalToolExecutePayload = externalExecute;
            await renderHarness(ctx, "Slack tool executed through Maya's account", [
              { title: "Identical search retry", body: state.retrySkillSearchPayload },
              { title: "Identical skill execute retry", body: state.retrySkillExecutePayload },
              { title: "Discovered bound Slack MCP tool", body: state.externalToolSearchPayload },
              { title: "Slack tools/call result", body: state.externalToolExecutePayload },
            ]);
          },
          assert: async () => {
            ctx.assert(String(state.retrySkillExecutePayload?.content ?? "").includes("Create shift handoff"), `Skill execute did not return instructional content: ${JSON.stringify(state.retrySkillExecutePayload).slice(0, 800)}`);
            ctx.assert(!String(state.retrySkillExecutePayload?.status ?? "").includes("needs_connection"), "Skill execute still returned needs_connection after Maya connected Slack.");
            ctx.assert(Boolean(state.externalToolCapabilityName), `Bound Slack MCP tool was not discovered: ${JSON.stringify(state.externalToolSearchPayload).slice(0, 800)}`);
            const externalText = firstText(state.externalToolExecutePayload);
            ctx.assert(externalText === EXTERNAL_TOOL_RESULT, `Expected ${EXTERNAL_TOOL_RESULT}, got ${externalText}`);
            const requests = await mockRequests();
            const toolCall = requests.find((entry) => entry.path === "/mcp" && entry.authorized === true && (entry.toolNames ?? []).includes(EXTERNAL_TOOL_NAME));
            ctx.assert(Boolean(toolCall), `Mock did not receive an authenticated ${EXTERNAL_TOOL_NAME} tools/call: ${JSON.stringify(requests).slice(0, 1200)}`);
          },
          screenshot: {
            name: "frame-7-harness-slack-tool-success",
            claim: "The retry returns skill instructions, and the bound Slack MCP tool returns SHIFT_HANDOFF_READY.",
            requireText: ["Slack tool executed", "Create shift handoff", EXTERNAL_TOOL_NAME, EXTERNAL_TOOL_RESULT],
            rejectText: ["needs_connection", "Connection failed"],
          },
        });
      },
    },
    {
      name: "Cleanup",
      run: async (ctx) => {
        await cleanupSeededResources(ctx).catch((error) => {
          ctx.log(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        await cleanupSupportTeam(ctx).catch((error) => {
          ctx.log(`Support team cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        });
        await stopMock(ctx).catch((error) => {
          ctx.log(`Mock cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
    },
  ],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function recordAssertion(ctx, assertion, passed, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: passed ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(passed, `${assertion}. Actual: ${JSON.stringify(actual)}`);
}

function requireState(value, label) {
  if (typeof value === "string" && value.trim()) return value;
  throw new Error(`${label} was not prepared.`);
}

function authHeaders(token) {
  const headers = { authorization: `Bearer ${token}` };
  if (state.orgId) {
    headers["x-openwork-org-id"] = state.orgId;
    headers["x-openwork-legacy-org-id"] = state.orgId;
  }
  return headers;
}

async function orgApi(ctx, path, init = {}, token = state.adminSession) {
  const response = await denApiFetch(path, {
    ...init,
    headers: { ...authHeaders(requireState(token, "session token")), ...(init.headers ?? {}) },
  });
  const ok = response.response.ok || response.response.status === 204;
  ctx.assert(ok, `${path} failed: ${response.response.status} ${JSON.stringify(response.body).slice(0, 400)}`);
  return response.body;
}

async function signInRequired(ctx, email, password, label) {
  const token = await signInApi(email, password);
  ctx.assert(Boolean(token), `${label} sign-in failed for ${email}.`);
  return token;
}

async function setActiveOrganization(ctx, token) {
  const result = await denApiFetch("/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ organizationId: requireState(state.orgId, "organization id") }),
  });
  ctx.assert(result.response.ok, `Could not activate org ${state.orgId}: ${result.response.status} ${JSON.stringify(result.body).slice(0, 300)}`);
}

async function orgContext(ctx, token = state.adminSession) {
  return orgApi(ctx, "/v1/org", {}, token);
}

async function ensureAdminContext(ctx) {
  state.adminSession = await signInRequired(ctx, ADMIN_EMAIL, ADMIN_PASSWORD, "Admin");
  const listed = await denApiFetch("/v1/me/orgs", { headers: { authorization: `Bearer ${state.adminSession}` } });
  ctx.assert(listed.response.ok, `Could not list admin organizations: ${listed.response.status}`);
  const orgs = Array.isArray(listed.body?.orgs) ? listed.body.orgs : [];
  const selected = orgs.find((org) => String(org.name ?? "").includes("Acme Robotics"))
    ?? orgs.find((org) => ["owner", "admin"].includes(String(org.role ?? "").toLowerCase()))
    ?? orgs[0];
  ctx.assert(selected && typeof selected.id === "string", `No organization found for ${ADMIN_EMAIL}.`);
  state.orgId = selected.id;
  state.orgSlug = selected.slug ?? null;
  state.adminMemberId = selected.orgMemberId ?? selected.membershipId ?? null;
  await setActiveOrganization(ctx, state.adminSession);
  const context = await orgContext(ctx);
  state.adminMemberId = context.currentMember?.id ?? state.adminMemberId;
}

async function ensureMcpConnectionsCapability(ctx) {
  const context = await orgContext(ctx);
  if (context.capabilities?.mcpConnections === true) return;
  ctx.assert(
    PLATFORM_ADMIN_EMAIL.length > 0 && PLATFORM_ADMIN_PASSWORD.length > 0,
    "MCP Connections are disabled for this org. Provide OPENWORK_EVAL_PLATFORM_ADMIN_EMAIL/PASSWORD to enable the eval capability, or run against a seeded org with MCP Connections on.",
  );
  const platformToken = await signInApi(PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD);
  ctx.assert(Boolean(platformToken), "Platform admin sign-in failed while enabling MCP Connections.");
  const updated = await denApiFetch(`/v1/admin/organizations/${requireState(state.orgId, "organization id")}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${platformToken}` },
    body: JSON.stringify({ capabilities: { mcpConnections: true } }),
  });
  ctx.assert(updated.response.ok, `Could not enable MCP Connections: ${updated.response.status} ${JSON.stringify(updated.body).slice(0, 300)}`);
}

async function ensureMayaMember(ctx) {
  state.mayaSession = await signInApi(MAYA_EMAIL, MAYA_PASSWORD);
  if (!state.mayaSession) {
    const invite = await inviteMaya(ctx);
    const signedUp = await denApiFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: MAYA_EMAIL, name: "Maya Support", password: MAYA_PASSWORD }),
    });
    ctx.assert(
      signedUp.response.ok || [400, 409, 422].includes(signedUp.response.status),
      `Maya sign-up failed: ${signedUp.response.status} ${JSON.stringify(signedUp.body).slice(0, 300)}`,
    );
    markEmailVerified(ctx, MAYA_EMAIL);
    state.mayaSession = await signInRequired(ctx, MAYA_EMAIL, MAYA_PASSWORD, "Maya");
    await acceptInvite(ctx, invite);
  } else if (!(await tokenHasOrg(ctx, state.mayaSession))) {
    const invite = await inviteMaya(ctx);
    await acceptInvite(ctx, invite);
  }
  await setActiveOrganization(ctx, state.mayaSession);
  const context = await orgContext(ctx);
  const maya = (context.members ?? []).find((member) => String(member.user?.email ?? "").toLowerCase() === MAYA_EMAIL.toLowerCase());
  ctx.assert(maya && typeof maya.id === "string", `Maya member not found in org context for ${MAYA_EMAIL}.`);
  state.mayaMemberId = maya.id;
}

async function tokenHasOrg(ctx, token) {
  const listed = await denApiFetch("/v1/me/orgs", { headers: { authorization: `Bearer ${token}` } });
  ctx.assert(listed.response.ok, `Could not list Maya organizations: ${listed.response.status}`);
  const orgs = Array.isArray(listed.body?.orgs) ? listed.body.orgs : [];
  return orgs.some((org) => org.id === state.orgId);
}

async function inviteMaya(ctx) {
  const invite = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: authHeaders(requireState(state.adminSession, "admin session")),
    body: JSON.stringify({ email: MAYA_EMAIL, role: "member" }),
  });
  ctx.assert(
    invite.response.ok && typeof invite.body?.inviteToken === "string",
    `Maya invitation failed or did not return an invite token: ${invite.response.status} ${JSON.stringify(invite.body).slice(0, 400)}`,
  );
  return invite.body.inviteToken;
}

async function acceptInvite(ctx, inviteToken) {
  const accepted = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${requireState(state.mayaSession, "Maya session")}` },
    body: JSON.stringify({ id: inviteToken }),
  });
  ctx.assert(accepted.response.ok && accepted.body?.accepted === true, `Maya invitation accept failed: ${accepted.response.status} ${JSON.stringify(accepted.body).slice(0, 300)}`);
}

function markEmailVerified(ctx, email) {
  ctx.assert(
    MARK_VERIFIED_CMD.length > 0,
    `Maya account bootstrap needs email verification. Set OPENWORK_EVAL_MARK_VERIFIED_CMD with an {email} placeholder, or pre-seed ${email}.`,
  );
  execSync(MARK_VERIFIED_CMD.replaceAll("{email}", email), { stdio: "ignore" });
}

async function ensureSupportTeam(ctx) {
  const context = await orgContext(ctx);
  const teams = Array.isArray(context.teams) ? context.teams : [];
  const existing = teams.find((team) => team.name === SUPPORT_TEAM_NAME) ?? null;
  const mayaMemberId = requireState(state.mayaMemberId, "Maya member id");
  if (!existing) {
    const created = await orgApi(ctx, "/v1/teams", {
      method: "POST",
      body: JSON.stringify({ name: SUPPORT_TEAM_NAME, memberIds: [mayaMemberId] }),
    });
    state.supportTeamId = created.team?.id ?? null;
    state.createdSupportTeam = true;
    ctx.assert(Boolean(state.supportTeamId), `Support team creation response missing id: ${JSON.stringify(created).slice(0, 300)}`);
    return;
  }
  state.supportTeamId = existing.id;
  const memberIds = Array.isArray(existing.memberIds) ? existing.memberIds : [];
  if (!memberIds.includes(mayaMemberId)) {
    await orgApi(ctx, `/v1/teams/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ memberIds: [...memberIds, mayaMemberId] }),
    });
  }
}

function skillSource(name) {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} for Support Operations using Slack context.`,
    "---",
    "",
    `# ${name}`,
    "",
    "Use Slack context from the Support Operations plugin before answering.",
    name === "Create shift handoff"
      ? "Create a concise shift handoff with unresolved issues, owners, customer impact, and next action."
      : "Follow the support workflow and cite the current Slack channel context.",
  ].join("\n");
}

function mcpPayload() {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "remote",
        url: MOCK_MCP_URL,
      },
    },
  };
}

async function seedMarketplace(ctx) {
  const marketplace = await orgApi(ctx, "/v1/marketplaces", {
    method: "POST",
    body: JSON.stringify({ name: MARKETPLACE_NAME, description: "Flow-owned marketplace for Support team operations." }),
  });
  state.marketplaceId = marketplace.item?.id ?? null;
  ctx.assert(Boolean(state.marketplaceId), `Marketplace create response missing id: ${JSON.stringify(marketplace).slice(0, 300)}`);

  const payload = mcpPayload();
  const plugin = await orgApi(ctx, "/v1/plugins", {
    method: "POST",
    body: JSON.stringify({
      name: PLUGIN_NAME,
      description: "Slack-backed support workflows for the Support team.",
      marketplaceId: state.marketplaceId,
      components: [
        ...SKILL_NAMES.map((name) => ({
          type: "skill",
          input: {
            rawSourceText: skillSource(name),
            metadata: { name, title: name, description: `${name} for Support Operations.` },
          },
        })),
        {
          type: "mcp",
          input: {
            rawSourceText: JSON.stringify(payload, null, 2),
            normalizedPayloadJson: payload,
            metadata: { name: MCP_SERVER_NAME, title: MCP_SERVER_NAME, description: "Slack MCP server required by Support Operations." },
          },
        },
      ],
    }),
  });
  state.pluginId = plugin.item?.id ?? null;
  ctx.assert(Boolean(state.pluginId), `Plugin create response missing id: ${JSON.stringify(plugin).slice(0, 300)}`);
  await assertMarketplaceComposition(ctx);
}

async function assertMarketplaceComposition(ctx) {
  const marketplace = await orgApi(ctx, `/v1/marketplaces/${requireState(state.marketplaceId, "marketplace id")}/resolved`);
  const plugins = marketplace.item?.plugins ?? [];
  recordAssertion(ctx, "Flow-owned marketplace resolves exactly one plugin named Support Operations", plugins.length === 1 && plugins[0]?.name === PLUGIN_NAME, {
    marketplace: marketplace.item?.marketplace?.name,
    plugins: plugins.map((plugin) => plugin.name),
  });
  state.pluginId = plugins[0]?.id ?? state.pluginId;

  const plugin = await orgApi(ctx, `/v1/plugins/${requireState(state.pluginId, "plugin id")}/resolved`);
  const configObjects = (plugin.items ?? []).map((item) => item.configObject).filter(Boolean);
  const skillObjects = configObjects.filter((item) => item.objectType === "skill");
  const mcpObjects = configObjects.filter((item) => item.objectType === "mcp");
  state.skillConfigObjectIds = skillObjects.map((item) => item.id);
  state.mcpConfigObjectId = mcpObjects[0]?.id ?? state.mcpConfigObjectId;
  const skillTitles = skillObjects.map((item) => item.title).sort();
  const expectedSkillTitles = [...SKILL_NAMES].sort();
  const serverSpec = mcpObjects[0]?.latestVersion?.normalizedPayloadJson ?? {};
  const slackSpec = serverSpec?.mcpServers?.[MCP_SERVER_NAME];
  recordAssertion(ctx, "Support Operations has exactly the three approved skill config objects and one Slack MCP config object", JSON.stringify(skillTitles) === JSON.stringify(expectedSkillTitles)
    && mcpObjects.length === 1
    && slackSpec?.url === MOCK_MCP_URL, {
    skillTitles,
    mcpObjectCount: mcpObjects.length,
    slackServerName: MCP_SERVER_NAME,
    slackUrl: slackSpec?.url,
  });
}

async function cleanupSeededResources(ctx) {
  if (!state.adminSession) {
    state.adminSession = await signInApi(ADMIN_EMAIL, ADMIN_PASSWORD);
  }
  if (!state.adminSession) return;
  await cleanupConnections(ctx);
  await cleanupMarketplaces(ctx);
}

async function cleanupConnections(ctx) {
  const listed = await denApiFetch("/v1/mcp-connections?scope=manageable", {
    headers: authHeaders(state.adminSession),
  });
  if (!listed.response.ok) return;
  for (const connection of listed.body?.connections ?? []) {
    if (connection.id !== state.connectionId && connection.url !== MOCK_MCP_URL) continue;
    const removed = await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
      method: "DELETE",
      headers: authHeaders(state.adminSession),
    });
    ctx.assert(removed.response.ok || removed.response.status === 404, `Connection cleanup failed for ${connection.id}: ${removed.response.status}`);
  }
  state.connectionId = null;
}

async function cleanupMarketplaces(ctx) {
  const listed = await denApiFetch("/v1/marketplaces?status=active&limit=100", { headers: authHeaders(state.adminSession) });
  if (!listed.response.ok) return;
  for (const marketplace of listed.body?.items ?? []) {
    if (marketplace.id !== state.marketplaceId && !String(marketplace.name ?? "").startsWith("Support Operations Library ")) continue;
    await cleanupMarketplacePlugins(ctx, marketplace.id);
    await denApiFetch(`/v1/marketplaces/${marketplace.id}/archive`, { method: "POST", headers: authHeaders(state.adminSession) });
  }
  state.marketplaceId = null;
  state.pluginId = null;
  state.skillConfigObjectIds = [];
  state.mcpConfigObjectId = null;
}

async function cleanupMarketplacePlugins(ctx, marketplaceId) {
  const memberships = await denApiFetch(`/v1/marketplaces/${marketplaceId}/plugins`, { headers: authHeaders(state.adminSession) });
  if (!memberships.response.ok) return;
  for (const membership of memberships.body?.items ?? []) {
    if (membership.plugin?.name !== PLUGIN_NAME && membership.pluginId !== state.pluginId) continue;
    await denApiFetch(`/v1/marketplaces/${marketplaceId}/plugins/${membership.pluginId}`, { method: "DELETE", headers: authHeaders(state.adminSession) });
    await cleanupPlugin(ctx, membership.pluginId);
  }
}

async function cleanupPlugin(ctx, pluginId) {
  const memberships = await denApiFetch(`/v1/plugins/${pluginId}/config-objects`, { headers: authHeaders(state.adminSession) });
  if (memberships.response.ok) {
    for (const membership of memberships.body?.items ?? []) {
      const configObjectId = membership.configObjectId;
      if (!configObjectId) continue;
      await denApiFetch(`/v1/plugins/${pluginId}/config-objects/${configObjectId}`, { method: "DELETE", headers: authHeaders(state.adminSession) });
      await denApiFetch(`/v1/config-objects/${configObjectId}/delete`, { method: "POST", headers: authHeaders(state.adminSession) });
    }
  }
  const archived = await denApiFetch(`/v1/plugins/${pluginId}/archive`, { method: "POST", headers: authHeaders(state.adminSession) });
  if (!archived.response.ok && archived.response.status !== 404) {
    ctx.log(`Plugin archive returned ${archived.response.status}: ${JSON.stringify(archived.body).slice(0, 200)}`);
  }
}

async function cleanupSupportTeam(ctx) {
  if (!state.createdSupportTeam || !state.supportTeamId || !state.adminSession) return;
  const removed = await denApiFetch(`/v1/teams/${state.supportTeamId}`, {
    method: "DELETE",
    headers: authHeaders(state.adminSession),
  });
  ctx.assert(removed.response.ok || removed.response.status === 404 || removed.response.status === 204, `Support team cleanup failed: ${removed.response.status}`);
}

async function startMock(ctx) {
  if (mockChild) return;
  ctx.assert(!(await mockHealthy()), `Port ${MOCK_PORT} is already serving. Stop that process or set OPENWORK_EVAL_MARKETPLACE_SLACK_MOCK_PORT.`);
  mockChild = spawn(process.execPath, [MOCK_SERVER_SCRIPT], {
    env: {
      ...process.env,
      PORT: String(MOCK_PORT),
      AUTO_APPROVE: "1",
      DISABLE_DCR: "1",
      ISSUER: MOCK_ISSUER,
      MOCK_CLIENT_ID,
      MOCK_CLIENT_SECRET,
      MOCK_EXTRA_TOOL_NAME: EXTERNAL_TOOL_NAME,
      MOCK_EXTRA_TOOL_TITLE: "Create shift handoff",
      MOCK_EXTRA_TOOL_DESCRIPTION: "Create a shift handoff for unresolved Support Operations issues in Slack.",
      MOCK_EXTRA_TOOL_RESULT: EXTERNAL_TOOL_RESULT,
    },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await mockHealthy()) {
      const health = await fetch(`${MOCK_BASE}/health`).then((response) => response.json());
      ctx.assert(health.disableDcr === true, "Slack stand-in must run with DISABLE_DCR=1.");
      return;
    }
    await sleep(250);
  }
  throw new Error(`Mock OAuth MCP server did not start at ${MOCK_BASE}.`);
}

async function stopMock(ctx) {
  if (!mockChild) return;
  mockChild.kill("SIGKILL");
  mockChild = null;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await mockHealthy())) return;
    await sleep(200);
  }
  ctx.assert(false, `Mock OAuth MCP server did not stop at ${MOCK_BASE}.`);
}

async function mockHealthy() {
  try {
    const response = await fetch(`${MOCK_BASE}/health`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function mockRequests() {
  const response = await fetch(`${MOCK_BASE}/requests`, { signal: AbortSignal.timeout(2_000) });
  const payload = await response.json();
  return payload.requests ?? [];
}

async function setBrowserActiveOrganization(ctx) {
  await ctx.eval(`fetch('/api/den/v1/me/active-organization', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ organizationId: ${JSON.stringify(requireState(state.orgId, "organization id"))} }),
  }).then((response) => response.ok)`, { awaitPromise: true });
}

async function installEvalFetchPatch(ctx) {
  await ctx.eval(`(() => {
    const original = window.__marketplacePluginMcpAuthOriginalFetch ?? window.fetch.bind(window);
    window.__marketplacePluginMcpAuthOriginalFetch = original;
    window.fetch = async (...args) => {
      const input = args[0];
      const init = args[1] ?? {};
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = (init.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
      const response = await original(...args);
      if (url.includes('/v1/mcp-connections/presets') && response.ok) {
        const payload = await response.clone().json().catch(() => ({}));
        const presets = Array.isArray(payload.presets) ? payload.presets.filter((preset) => preset?.presetId !== 'slack') : [];
        presets.push({
          presetId: 'slack',
          displayName: 'Slack',
          description: 'Slack local OAuth MCP stand-in for the marketplace auth eval.',
          url: ${JSON.stringify(MOCK_MCP_URL)},
          authType: 'oauth',
          requiresOAuthClient: true,
        });
        const headers = new Headers(response.headers);
        headers.set('content-type', 'application/json');
        return new Response(JSON.stringify({ presets }), { status: response.status, statusText: response.statusText, headers });
      }
      if (method === 'POST' && url.includes('/v1/plugins/') && url.includes('/mcp-connections')) {
        const requestBody = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        const sanitizedRequest = requestBody ? {
          ...requestBody,
          requestHadUrl: Object.prototype.hasOwnProperty.call(requestBody, 'url'),
          ...(requestBody.oauthClient ? { oauthClient: { clientId: requestBody.oauthClient.clientId, clientSecret: '<redacted>' } } : {}),
        } : null;
        response.clone().json().then((payload) => {
          localStorage.setItem('__marketplacePluginMcpAuthConfigureResponse', JSON.stringify({ status: response.status, request: sanitizedRequest, payload }));
        }).catch(() => undefined);
      }
      return response;
    };
    localStorage.removeItem('__marketplacePluginMcpAuthConfigureResponse');
    return true;
  })()`);
}

async function openMarketplaceDetailViaUi(ctx) {
  await ctx.waitForText("Dashboard", { timeoutMs: 30_000 });
  const marketplaceNavVisible = await ctx.eval(`Boolean([...document.querySelectorAll('a')].find((entry) => (entry.getAttribute('href') ?? '').endsWith('/dashboard/marketplaces')))`);
  if (!marketplaceNavVisible) {
    await ctx.clickText("Extensions", { timeoutMs: 20_000 });
  }
  const clickedNav = await ctx.waitFor(`(() => {
    const link = [...document.querySelectorAll('a')].find((entry) => (entry.getAttribute('href') ?? '').endsWith('/dashboard/marketplaces'));
    link?.click();
    return Boolean(link);
  })()`, { timeoutMs: 30_000, label: "Marketplaces nav" });
  ctx.assert(Boolean(clickedNav), "Could not click Marketplaces under Extensions.");
  await ctx.waitFor("window.location.pathname.endsWith('/dashboard/marketplaces')", { timeoutMs: 30_000, label: "marketplaces route" });
  await ctx.waitFor("Boolean(document.querySelector('input[placeholder=\"Search marketplaces...\"]'))", { timeoutMs: 30_000, label: "marketplace search" });
  await ctx.fill('input[placeholder="Search marketplaces..."]', MARKETPLACE_NAME);
  await ctx.waitForText(MARKETPLACE_NAME, { timeoutMs: 30_000 });
  const clickedMarketplace = await ctx.waitFor(`(() => {
    const link = [...document.querySelectorAll('a')].find((entry) => (entry.innerText ?? '').includes(${JSON.stringify(MARKETPLACE_NAME)}));
    link?.click();
    return Boolean(link);
  })()`, { timeoutMs: 30_000, label: "marketplace card" });
  ctx.assert(Boolean(clickedMarketplace), `Could not click marketplace card for ${MARKETPLACE_NAME}.`);
  await ctx.waitFor(`window.location.pathname.includes('/dashboard/marketplaces/${requireState(state.marketplaceId, "marketplace id")}')`, { timeoutMs: 30_000, label: "marketplace detail route" });
  await ctx.waitForText(PLUGIN_NAME, { timeoutMs: 30_000 });
}

async function grantSupportTeamViaUi(ctx) {
  await ctx.waitForText("WHO CAN ACCESS THIS", { timeoutMs: 30_000 });
  await ctx.eval(`(() => {
    const heading = [...document.querySelectorAll('*')].find((node) => (node.textContent ?? '').trim() === 'Who can access this');
    heading?.scrollIntoView({ block: 'center' });
    return true;
  })()`);
  await ctx.clickText("Add team", { timeoutMs: 20_000 });
  await ctx.fill('input[placeholder="Search teams..."]', SUPPORT_TEAM_NAME);
  const clicked = await ctx.waitFor(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const option = buttons.find((button) => {
      const text = (button.innerText ?? '').trim();
      return text.includes(${JSON.stringify(SUPPORT_TEAM_NAME)}) && !text.includes('Add team');
    });
    option?.click();
    return Boolean(option);
  })()`, { timeoutMs: 20_000, label: "Support team option" });
  ctx.assert(Boolean(clicked), "Support team option was not available in the marketplace access picker.");
  await ctx.waitFor(`(() => {
    const teams = [...document.querySelectorAll('*')].find((node) => (node.textContent ?? '').trim() === 'Teams');
    return Boolean(teams) && document.body.innerText.includes(${JSON.stringify(SUPPORT_TEAM_NAME)});
  })()`, { timeoutMs: 30_000, label: "Support team grant visible" });
  await ctx.waitFor("document.body.innerText.replace(/\\s+/g, ' ').includes('3 skills')", { timeoutMs: 30_000, label: "three plugin skills" });
  await ctx.waitFor("document.body.innerText.replace(/\\s+/g, ' ').includes('1 MCP server')", { timeoutMs: 30_000, label: "one plugin MCP server" });
}

async function readMarketplaceDetailUi(ctx) {
  return ctx.eval(`(() => {
    const compact = (value) => (value ?? '').replace(/\\s+/g, ' ').trim();
    const pluginCard = [...document.querySelectorAll('a, div, article, button')]
      .find((node) => compact(node.innerText).includes(${JSON.stringify(PLUGIN_NAME)}) && compact(node.innerText).includes('3 skills'));
    return { bodyText: compact(document.body.innerText), pluginCardText: compact(pluginCard?.innerText) };
  })()`);
}

async function openSlackSetupDialog(ctx) {
  await ctx.waitForText("Needs connection", { timeoutMs: 30_000 });
  await ctx.waitForText("Plugin-declared URL", { timeoutMs: 30_000 });
  const clicked = await ctx.waitFor(`(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => ['Configure connection', 'Quick connect'].includes((entry.textContent ?? '').trim()));
    button?.scrollIntoView({ block: 'center' });
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 30_000, label: "configure Slack connection" });
  ctx.assert(Boolean(clicked), "Slack configuration button was not visible. The local Slack preset did not match the plugin-declared URL.");
  await ctx.waitForText("Set up Slack", { timeoutMs: 20_000 });
}

async function openWhoSignsInPicker(ctx) {
  const opened = await ctx.waitFor(`(() => {
    const trigger = [...document.querySelectorAll('button[aria-haspopup="listbox"]')]
      .find((button) => (button.innerText ?? '').includes('Each user connects their own account'));
    trigger?.click();
    return Boolean(trigger);
  })()`, { timeoutMs: 10_000, label: "Who signs in picker" });
  ctx.assert(Boolean(opened), "Who signs in picker did not open.");
  await ctx.waitForText("Organization-shared account", { timeoutMs: 10_000 });
}

async function chooseIndividualAccounts(ctx) {
  const chosen = await ctx.waitFor(`(() => {
    const option = [...document.querySelectorAll('[role="option"], button')]
      .find((entry) => (entry.innerText ?? '').trim() === 'Each user connects their own account');
    option?.click();
    return Boolean(option);
  })()`, { timeoutMs: 10_000, label: "Individual accounts option" });
  ctx.assert(Boolean(chosen), "Could not choose Individual accounts.");
  await ctx.waitForText("Slack OAuth app", { timeoutMs: 10_000 });
}

async function fillOAuthClient(ctx) {
  await ctx.fill('input[placeholder="Client ID"]', MOCK_CLIENT_ID);
  await ctx.fill('input[placeholder="Client secret"]', MOCK_CLIENT_SECRET);
}

async function clickSetupSubmit(ctx) {
  const clicked = await ctx.waitFor(`(() => {
    const buttons = [...document.querySelectorAll('button')]
      .filter((entry) => (entry.textContent ?? '').trim() === 'Quick connect' && !entry.disabled);
    const button = buttons.at(-1);
    button?.click();
    return Boolean(button);
  })()`, { timeoutMs: 10_000, label: "Quick connect submit" });
  ctx.assert(Boolean(clicked), "Quick connect submit was not enabled.");
}

async function readConfigureLog(ctx) {
  return ctx.eval(`(() => {
    const raw = localStorage.getItem('__marketplacePluginMcpAuthConfigureResponse');
    return raw ? JSON.parse(raw) : null;
  })()`);
}

async function assertConfiguredConnection(ctx) {
  const configureLog = await readConfigureLog(ctx);
  ctx.assert(configureLog?.request?.configObjectId === state.mcpConfigObjectId, `Configure request was not bound to the Slack configObjectId: ${JSON.stringify(configureLog?.request)}`);
  ctx.assert(configureLog?.request?.serverName === MCP_SERVER_NAME, `Configure request did not use serverName Slack: ${JSON.stringify(configureLog?.request)}`);
  ctx.assert(configureLog?.request?.requestHadUrl === false, `Configure request unexpectedly accepted a URL: ${JSON.stringify(configureLog?.request)}`);
  ctx.assert(configureLog?.payload?.item?.binding?.configObjectId === state.mcpConfigObjectId, `Configure response binding missing configObjectId: ${JSON.stringify(configureLog?.payload).slice(0, 500)}`);
  ctx.assert(configureLog?.payload?.item?.binding?.serverName === MCP_SERVER_NAME, `Configure response binding missing serverName Slack: ${JSON.stringify(configureLog?.payload).slice(0, 500)}`);

  const listed = await orgApi(ctx, "/v1/mcp-connections?scope=manageable");
  const connection = (listed.connections ?? []).find((entry) => entry.id === state.connectionId);
  ctx.assert(Boolean(connection), `Configured connection ${state.connectionId} not found.`);
  recordAssertion(ctx, "Configured connection is per-member, bound to Support Operations, and uses the plugin payload URL", connection.credentialMode === "per_member"
    && connection.url === MOCK_MCP_URL
    && (connection.requiredBy ?? []).some((entry) => entry.pluginId === state.pluginId && entry.name === PLUGIN_NAME)
    && (connection.identityManagedBy ?? []).some((entry) => entry.pluginId === state.pluginId && entry.name === PLUGIN_NAME), {
    id: connection.id,
    name: connection.name,
    url: connection.url,
    credentialMode: connection.credentialMode,
    access: connection.access,
    requiredBy: connection.requiredBy,
  });
}

async function assertAllSkillsSearchableForMaya(ctx) {
  state.mcpToken = await mintMcpToken(requireState(state.mayaSession, "Maya session"), ctx);
  const searchable = [];
  for (const skillName of SKILL_NAMES) {
    const result = await mcpAgentCall(state.mcpToken, "tools/call", {
      name: "search_capabilities",
      arguments: { query: skillName, type: "skills", limit: 10 },
    }, ctx);
    const payload = parseToolJson(result);
    const match = findCapabilityBySummary(payload, skillName);
    searchable.push({ skillName, found: Boolean(match), matchName: match?.name ?? null, summary: match?.summary ?? null });
  }
  recordAssertion(ctx, "All three Support Operations skills remain searchable for Maya through OpenWork MCP", searchable.every((entry) => entry.found), searchable);
}

async function prepareMayaHarness(ctx) {
  await signInViaBrowser(ctx, MAYA_EMAIL, MAYA_PASSWORD);
  await setBrowserActiveOrganization(ctx);
  if (!state.mcpToken) {
    state.mcpToken = await mintMcpToken(requireState(state.mayaSession, "Maya session"), ctx);
  }
  await renderHarness(ctx, "Maya's MCP-compatible harness", [
    { title: "Connection", body: { connected: ["OpenWork MCP"], token: "Maya MCP token minted from /v1/mcp/token (redacted)" } },
  ]);
}

function searchArguments() {
  return { query: HANDOFF_QUERY, type: "skills", limit: 10 };
}

function executeSkillArguments() {
  return { name: requireState(state.shiftHandoffCapabilityName, "Create shift handoff capability name") };
}

function toolSearchArguments() {
  return { query: TOOL_SEARCH_QUERY, type: "mcp", limit: 10 };
}

function executeExternalToolArguments() {
  return {
    name: requireState(state.externalToolCapabilityName, "Slack MCP tool capability name"),
    body: { channel: "#support", unresolved: "handoff unresolved support issues" },
  };
}

async function browserMcpToolCall(ctx, name, args) {
  return browserMcpCall(ctx, "tools/call", { name, arguments: args });
}

async function browserMcpCall(ctx, method, params) {
  const endpoint = `${DEN_WEB_URL}/api/den/mcp/agent`;
  const result = await ctx.eval(`(async () => {
    const response = await fetch(${JSON.stringify(endpoint)}, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer ' + ${JSON.stringify(requireState(state.mcpToken, "Maya MCP token"))},
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }),
    });
    const raw = await response.text();
    const dataLine = raw.split('\\n').find((line) => line.startsWith('data:'));
    let parsed = null;
    try { parsed = dataLine ? JSON.parse(dataLine.slice(5)) : JSON.parse(raw); } catch {}
    return { ok: response.ok, status: response.status, raw, parsed };
  })()`, { awaitPromise: true });
  ctx.assert(result?.ok, `Browser MCP ${method} failed: ${result?.status} ${String(result?.raw ?? "").slice(0, 500)}`);
  ctx.assert(!result.parsed?.error, `Browser MCP ${method} returned JSON-RPC error: ${JSON.stringify(result.parsed?.error)}`);
  return result.parsed?.result;
}

function parseToolJson(result) {
  const text = firstText(result);
  try {
    return JSON.parse(text);
  } catch {
    return { content: text };
  }
}

function firstText(result) {
  return String(result?.content?.[0]?.text ?? "");
}

function toolNames(payload) {
  const names = (payload?.tools ?? []).map((tool) => tool.name).sort();
  return names;
}

function findCapabilityBySummary(payload, text) {
  return (payload?.matches ?? []).find((match) => String(match.summary ?? "").includes(text) || String(match.name ?? "").includes(text));
}

function findCapabilityByNameFragment(payload, fragment) {
  return (payload?.matches ?? []).find((match) => String(match.name ?? "").includes(fragment) || String(match.summary ?? "").includes(fragment));
}

async function renderHarness(ctx, title, panels) {
  const html = harnessHtml(title, panels);
  await ctx.eval(`(() => {
    document.title = 'OpenWork MCP harness';
    document.body.innerHTML = ${JSON.stringify(html)};
    return true;
  })()`);
  await ctx.waitForText("MAYA'S MCP-COMPATIBLE HARNESS", { timeoutMs: 10_000 });
}

function harnessHtml(title, panels) {
  return `
    <main style="min-height:100vh;background:#eef6ff;color:#0f172a;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:36px;">
      <section style="max-width:1040px;margin:0 auto;">
        <p style="text-transform:uppercase;letter-spacing:.16em;font-size:12px;color:#2563eb;font-weight:700;margin:0 0 8px;">Maya's MCP-compatible harness</p>
        <h1 style="font-size:32px;line-height:1.1;margin:0 0 10px;">${escapeHtml(title)}</h1>
        <p style="font-size:15px;color:#475569;margin:0 0 24px;">Only the OpenWork MCP is connected here. The harness calls <code>/mcp/agent</code> and renders the structured responses it receives.</p>
        <div style="display:grid;gap:16px;">
          ${panels.map((panel) => `
            <article style="background:#fff;border:1px solid #bfdbfe;border-radius:22px;box-shadow:0 18px 50px rgba(30,64,175,.10);overflow:hidden;">
              <h2 style="font-size:15px;margin:0;padding:14px 18px;border-bottom:1px solid #dbeafe;background:#eff6ff;color:#1e3a8a;">${escapeHtml(panel.title)}</h2>
              <pre style="white-space:pre-wrap;word-break:break-word;margin:0;padding:18px;font-size:13px;line-height:1.55;color:#0f172a;">${escapeHtml(JSON.stringify(panel.body, null, 2))}</pre>
            </article>
          `).join("")}
        </div>
      </section>
    </main>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function assertNoProviderToolCallBeforeAuth(ctx) {
  const requests = await mockRequests();
  const providerToolCall = requests.find((entry) => entry.path === "/mcp" && entry.method === "POST");
  ctx.assert(!providerToolCall, `Provider MCP was called before Maya connected Slack: ${JSON.stringify(providerToolCall)}`);
}

function assertSameOriginYourConnectionsUrl(ctx, value) {
  ctx.assert(typeof value === "string" && value.length > 0, "Missing Your Connections URL.");
  const url = new URL(value);
  const web = new URL(DEN_WEB_URL);
  recordAssertion(ctx, "needs_connection action URL is a same-origin Your Connections URL scoped to the configured connection", url.origin === web.origin
    && url.pathname.endsWith("/dashboard/your-connections")
    && url.searchParams.get("connectionId") === state.connectionId, {
    url: value,
    webOrigin: web.origin,
    connectionId: state.connectionId,
  });
}

async function openNeedsConnectionUrl(ctx) {
  assertSameOriginYourConnectionsUrl(ctx, state.yourConnectionsUrl);
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(requireState(state.yourConnectionsUrl, "Your Connections URL"))}; return true; })()`);
  await ctx.waitFor("window.location.pathname.endsWith('/dashboard/your-connections')", { timeoutMs: 30_000, label: "Your Connections route" });
  await ctx.waitForText("Your Connections", { timeoutMs: 30_000 });
  await ctx.waitForText("Required by Support Operations", { timeoutMs: 30_000 });
  await ctx.waitForText("Connect your account", { timeoutMs: 30_000 });
}

async function clickFocusedConnect(ctx) {
  const selector = '[data-openwork-eval-focused-connect="true"]';
  const marked = await ctx.eval(`(() => {
    const highlighted = [...document.querySelectorAll('div')]
      .find((node) => (node.className ?? '').toString().includes('ring-blue-200') && (node.innerText ?? '').includes('Required by Support Operations'));
    const button = highlighted ? [...highlighted.querySelectorAll('button')].find((entry) => (entry.textContent ?? '').trim() === 'Connect') : null;
    button?.setAttribute('data-openwork-eval-focused-connect', 'true');
    return Boolean(button);
  })()`);
  ctx.assert(marked, "Focused Slack row did not expose a Connect button.");
  await ctx.trustedClick(selector, { timeoutMs: 20_000 });
}

async function routeLocalSplitOriginCallback(ctx) {
  await ctx.waitFor(`(() => {
    const path = window.location.pathname;
    return path.includes('/connect/callback') || path === '/v1/mcp-connections/oauth/callback';
  })()`, { timeoutMs: 30_000, label: "provider redirect to OpenWork callback" });
  const location = await ctx.eval(`({ origin: window.location.origin, pathname: window.location.pathname, search: window.location.search })`);
  if (!String(location.pathname).includes("/connect/callback") || location.origin === new URL(DEN_API_URL).origin) return;
  const callbackUrl = new URL(`${location.pathname}${location.search}`, DEN_API_URL).toString();
  await ctx.eval(`(() => { window.location.href = ${JSON.stringify(callbackUrl)}; return true; })()`);
  await ctx.waitFor("document.readyState === 'complete'", { timeoutMs: 30_000, label: "local split-origin OAuth callback" });
}

async function waitForConnectedAsMaya(ctx) {
  await ctx.waitFor(`(() => {
    const highlighted = [...document.querySelectorAll('div')]
      .find((node) => (node.className ?? '').toString().includes('ring-blue-200') && (node.innerText ?? '').includes('Required by Support Operations'));
    highlighted?.scrollIntoView({ block: 'center' });
    return Boolean(highlighted && (highlighted.innerText ?? '').includes('Connected as you'));
  })()`, { timeoutMs: 90_000, label: "Connected as you" });
}

async function readYourConnectionsFocusState(ctx) {
  return ctx.eval(`(() => {
    const highlighted = [...document.querySelectorAll('div')]
      .filter((node) => (node.className ?? '').toString().includes('ring-blue-200'));
    return {
      highlightedCount: highlighted.length,
      highlightedText: (highlighted[0]?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
      pageText: document.body.innerText,
    };
  })()`);
}
