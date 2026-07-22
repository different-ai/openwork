import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";
import { execSync } from "node:child_process";

const FLOW_ID = "org-mcp-agent-config-demo";
const vo = await loadVoiceoverParagraphs("org-mcp-agent-config-demo");

const DEN_API_URL = (process.env.OPENWORK_EVAL_DEN_API_URL ?? "").trim().replace(/\/+$/, "");
const DEN_WEB_URL = (process.env.OPENWORK_EVAL_DEN_WEB_URL ?? DEN_API_URL.replace("127.0.0.1", "localhost")).trim().replace(/\/+$/, "");
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const MEMBER_EMAIL = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "jordan.demo@acme.test";
const MEMBER_PASSWORD = process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!";
const MARK_VERIFIED_CMD = process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim() || "";
const MOCK_SERVER_URL = (process.env.MOCK_OAUTH_MCP_URL ?? "http://127.0.0.1:3978").trim().replace(/\/+$/, "");
const RUN_TAG = Date.now();
const CONNECTION_NAME = `Agent Config Knowledge Base ${RUN_TAG}`;

const state = {
  adminSession: process.env.OPENWORK_EVAL_DEN_TOKEN?.trim() || null,
  memberSession: null,
  adminMcpToken: null,
  memberMcpToken: null,
  organizationId: null,
  connectionId: null,
  createResponse: null,
  createCapability: null,
  accessCapability: null,
  listCapability: null,
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

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, assertion + (actual === undefined ? "" : ` (actual: ${JSON.stringify(actual).slice(0, 500)})`));
}

function parseToolJson(result) {
  const text = result?.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function mcpAgentCall(ctx, mcpToken, method, params = {}) {
  const response = await fetch(`${DEN_API_URL}/mcp/agent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${mcpToken}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const raw = await response.text();
  witness(ctx, response.ok, `MCP ${method} returned HTTP 200`, raw.slice(0, 300));
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  witness(ctx, Boolean(dataLine), `MCP ${method} returned a data frame`, raw.slice(0, 300));
  const payload = JSON.parse(dataLine.slice(5));
  witness(ctx, !payload.error, `MCP ${method} returned no JSON-RPC error`, payload.error ?? null);
  return payload.result;
}

async function mintMcpToken(ctx, sessionToken, label) {
  const { response, body } = await denApiFetch("/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  witness(ctx, response.ok, `${label} can mint an MCP token`, body);
  return body.token;
}

async function findCapability(ctx, mcpToken, input) {
  const result = await mcpAgentCall(ctx, mcpToken, "tools/call", {
    name: "search_capabilities",
    arguments: { query: input.query, limit: 10 },
  });
  const parsed = parseToolJson(result);
  const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
  const match = matches.find((candidate) => candidate.method === input.method && candidate.path === input.path) ?? null;
  witness(ctx, Boolean(match), `search_capabilities exposes ${input.method} ${input.path}`, {
    query: input.query,
    matches: matches.map((candidate) => ({ name: candidate.name, method: candidate.method, path: candidate.path })),
  });
  return match;
}

async function executeCapability(ctx, mcpToken, capabilityName, args) {
  return mcpAgentCall(ctx, mcpToken, "tools/call", {
    name: "execute_capability",
    arguments: { name: capabilityName, ...args },
  });
}

async function ensureAdmin(ctx) {
  if (!state.adminSession) {
    state.adminSession = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  }
  witness(ctx, Boolean(state.adminSession), `Admin sign-in succeeds for ${ADMIN_EMAIL}`);

  const org = await denApiFetch("/v1/org", {
    headers: { authorization: `Bearer ${state.adminSession}` },
  });
  witness(ctx, org.response.ok, "Admin session resolves an active organization", org.body);
  state.organizationId = org.body.organization?.id ?? null;
  witness(ctx, Boolean(state.organizationId), "Admin organization id is present", org.body.organization ?? null);
}

async function ensureMember(ctx) {
  state.memberSession = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);

  if (!state.memberSession) {
    const signUp = await denApiFetch("/api/auth/sign-up/email", {
      method: "POST",
      body: JSON.stringify({ email: MEMBER_EMAIL, name: "Jordan Demo", password: MEMBER_PASSWORD }),
    });
    witness(ctx, signUp.response.ok, `Member sign-up succeeds for ${MEMBER_EMAIL}`, signUp.body);
    state.memberSession = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
    witness(ctx, Boolean(state.memberSession), "Member can sign in after sign-up");
  }

  const orgs = await denApiFetch("/v1/me/orgs", {
    headers: { authorization: `Bearer ${state.memberSession}` },
  });
  witness(ctx, orgs.response.ok, "Member org list is readable", orgs.body);
  const alreadyInOrg = (orgs.body.orgs ?? []).some((org) => org.id === state.organizationId);
  if (alreadyInOrg) return;

  const invite = await denApiFetch("/v1/invitations", {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminSession}` },
    body: JSON.stringify({ email: MEMBER_EMAIL, role: "member" }),
  });
  witness(ctx, invite.response.ok, "Admin can invite the member to the org", invite.body);

  if (MARK_VERIFIED_CMD) {
    execSync(MARK_VERIFIED_CMD.replaceAll("{email}", MEMBER_EMAIL), { stdio: "ignore" });
  }

  const accept = await denApiFetch("/v1/orgs/invitations/accept", {
    method: "POST",
    headers: { authorization: `Bearer ${state.memberSession}` },
    body: JSON.stringify({ id: invite.body.inviteToken }),
  });
  if (!accept.response.ok && accept.body?.error === "email_verification_required" && !MARK_VERIFIED_CMD) {
    witness(ctx, false, "Member invitation accept needs OPENWORK_EVAL_MARK_VERIFIED_CMD in this environment", accept.body);
  }
  witness(ctx, accept.response.ok && accept.body.accepted === true, "Member accepts the invitation into the admin org", accept.body);
  state.memberSession = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
  witness(ctx, Boolean(state.memberSession), "Member can sign in after joining the org");
}

async function cleanupConnections(ctx) {
  if (!state.adminSession) return;
  const existing = await denApiFetch("/v1/mcp-connections?scope=manageable", {
    headers: { authorization: `Bearer ${state.adminSession}` },
  });
  if (!existing.response.ok) return;
  for (const connection of existing.body.connections ?? []) {
    if (connection.name.startsWith("Agent Config Knowledge Base ") || connection.name.startsWith("Agent Config API Key Guard ")) {
      await denApiFetch(`/v1/mcp-connections/${connection.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${state.adminSession}` },
      });
    }
  }
}

export default {
  id: FLOW_ID,
  title: "Org admins can publish an MCP connection through the agent surface, hand members the existing connect path, and members cannot exceed their role",
  kind: "internal",
  requiresApp: false,
  spec: "evals/voiceovers/org-mcp-agent-config-demo.md",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL"],
  steps: [
    {
      name: "Frame 1",
      run: async (ctx) => {
        await ctx.prove("Alex's agent discovers the org MCP create capability and publishes a per-member connection for everyone", {
          voiceover: vo[0],
          action: async () => {
            await ensureAdmin(ctx);
            await ensureMember(ctx);
            await cleanupConnections(ctx);
            state.adminMcpToken = await mintMcpToken(ctx, state.adminSession, "Admin");

            const tools = await mcpAgentCall(ctx, state.adminMcpToken, "tools/list", {});
            const toolNames = (tools.tools ?? []).map((tool) => tool.name).sort();
            witness(ctx, toolNames.join(",") === "execute_capability,search_capabilities", "The agent endpoint only exposes search_capabilities and execute_capability", toolNames);

            state.createCapability = await findCapability(ctx, state.adminMcpToken, {
              query: "register MCP connection",
              method: "POST",
              path: "/v1/mcp-connections",
            });

            const created = await executeCapability(ctx, state.adminMcpToken, state.createCapability.name, {
              body: {
                name: CONNECTION_NAME,
                url: `${MOCK_SERVER_URL}/mcp`,
                authType: "oauth",
                credentialMode: "per_member",
                access: { orgWide: true, memberIds: [], teamIds: [] },
              },
            });
            witness(ctx, created.isError !== true, "execute_capability creates the org MCP connection", parseToolJson(created));
            const createdBody = parseToolJson(created);
            state.connectionId = createdBody.id;
            state.createResponse = createdBody;
            ctx.output("created-connection.json", JSON.stringify(createdBody, null, 2));
          },
          assert: async () => {
            witness(ctx, Boolean(state.connectionId), "Created connection id is present", state.connectionId);
            const manageable = await denApiFetch("/v1/mcp-connections?scope=manageable", {
              headers: { authorization: `Bearer ${state.adminSession}` },
            });
            const connection = (manageable.body.connections ?? []).find((entry) => entry.id === state.connectionId);
            witness(ctx, Boolean(connection), "The connection exists in Den's manageable org list", manageable.body);
            witness(ctx, connection?.credentialMode === "per_member" && connection?.authType === "oauth", "The connection is OAuth per-member, not a shared secret", connection);
          },
        });
      },
    },
    {
      name: "Frame 2",
      run: async (ctx) => {
        await ctx.prove("The create response gives Alex the member handoff link and refuses API-key secrets through the agent", {
          voiceover: vo[1],
          action: async () => {
            const rejected = await executeCapability(ctx, state.adminMcpToken, state.createCapability.name, {
              body: {
                name: `Agent Config API Key Guard ${RUN_TAG}`,
                url: `${MOCK_SERVER_URL}/mcp`,
                authType: "apikey",
                credentialMode: "shared",
                apiKey: "eval-placeholder-not-a-real-secret",
                access: { orgWide: true, memberIds: [], teamIds: [] },
              },
            });
            witness(ctx, rejected.isError === true, "API-key connection creation is rejected on the agent surface", parseToolJson(rejected));
            ctx.output("apikey-guard-response.json", JSON.stringify(parseToolJson(rejected), null, 2));
          },
          assert: async () => {
            state.listCapability = await findCapability(ctx, state.adminMcpToken, {
              query: "list MCP connections",
              method: "GET",
              path: "/v1/mcp-connections",
            });
            const listed = await executeCapability(ctx, state.adminMcpToken, state.listCapability.name, {
              query: { scope: "manageable" },
            });
            const body = parseToolJson(listed);
            const connection = (body.connections ?? []).find((entry) => entry.id === state.connectionId);
            witness(ctx, Boolean(connection), "The created connection is readable through execute_capability", body);
            witness(ctx, connection?.name === CONNECTION_NAME, "The agent-created connection is named in the readback", connection);
            ctx.output("handoff-link-response.json", JSON.stringify({ id: state.createResponse.id, name: state.createResponse.name, links: state.createResponse.links }, null, 2));
            witness(ctx, typeof state.createResponse.links?.yourConnections === "string" && state.createResponse.links.yourConnections.endsWith("/dashboard/your-connections"), "Create response includes links.yourConnections for teammates", state.createResponse.links);
          },
        });
      },
    },
    {
      name: "Frame 3",
      run: async (ctx) => {
        await ctx.prove("Alex's agent can manage and read back who can use the connection", {
          voiceover: vo[2],
          action: async () => {
            state.accessCapability = await findCapability(ctx, state.adminMcpToken, {
              query: "replace MCP connection access",
              method: "PUT",
              path: "/v1/mcp-connections/{connectionId}/access",
            });
            const updated = await executeCapability(ctx, state.adminMcpToken, state.accessCapability.name, {
              path: { connectionId: state.connectionId },
              body: { access: { orgWide: true, memberIds: [], teamIds: [] } },
            });
            witness(ctx, updated.isError !== true, "execute_capability can update connection access", parseToolJson(updated));
            ctx.output("access-update-response.json", JSON.stringify(parseToolJson(updated), null, 2));
          },
          assert: async () => {
            const listed = await executeCapability(ctx, state.adminMcpToken, state.listCapability.name, {
              query: { scope: "manageable" },
            });
            const body = parseToolJson(listed);
            const connection = (body.connections ?? []).find((entry) => entry.id === state.connectionId);
            witness(ctx, connection?.access?.orgWide === true, "Access readback says everyone in the org can use it", connection?.access ?? connection);
            witness(ctx, Array.isArray(connection?.access?.memberIds) && connection.access.memberIds.length === 0, "Access readback has no individual-only restriction", connection?.access ?? connection);
            witness(ctx, Array.isArray(connection?.access?.teamIds) && connection.access.teamIds.length === 0, "Access readback has no team-only restriction", connection?.access ?? connection);
          },
        });
      },
    },
    {
      name: "Frame 4",
      run: async (ctx) => {
        await ctx.prove("Jordan's member-scoped connection list contains the org-published card in Connect your account state", {
          voiceover: vo[3],
          action: async () => {
            state.memberMcpToken = await mintMcpToken(ctx, state.memberSession, "Member");
          },
          assert: async () => {
            const usable = await denApiFetch("/v1/mcp-connections?scope=usable", {
              headers: { authorization: `Bearer ${state.memberSession}` },
            });
            witness(ctx, usable.response.ok, "Member can read usable org MCP connections", usable.body);
            const connection = (usable.body.connections ?? []).find((entry) => entry.id === state.connectionId);
            ctx.output("member-usable-connections.json", JSON.stringify(usable.body, null, 2));
            witness(ctx, Boolean(connection), "The member-visible list includes Alex's connection", usable.body);
            witness(ctx, connection?.connectedForMe === false, "The member-visible connection is waiting for Jordan to connect her own account", connection);
            witness(ctx, connection?.credentialMode === "per_member", "The member-visible connection preserves per-member credential mode", connection);
          },
        });
      },
    },
    {
      name: "Frame 5",
      run: async (ctx) => {
        await ctx.prove("Jordan's agent cannot publish an org MCP connection because Jordan is not an admin", {
          voiceover: vo[4],
          action: async () => {
            state.createCapability = await findCapability(ctx, state.memberMcpToken, {
              query: "register MCP connection",
              method: "POST",
              path: "/v1/mcp-connections",
            });
          },
          assert: async () => {
            const denied = await executeCapability(ctx, state.memberMcpToken, state.createCapability.name, {
              body: {
                name: `Agent Config Knowledge Base Member Denied ${RUN_TAG}`,
                url: `${MOCK_SERVER_URL}/mcp`,
                authType: "oauth",
                credentialMode: "per_member",
                access: { orgWide: true, memberIds: [], teamIds: [] },
              },
            });
            const body = parseToolJson(denied);
            ctx.output("member-denied-response.json", JSON.stringify(body, null, 2));
            witness(ctx, denied.isError === true, "Member execute_capability create attempt is an error", body);
            witness(ctx, body.error === "forbidden" || String(body.message ?? "").includes("admins"), "The denial is the normal admin-required route guard", body);
            await cleanupConnections(ctx);
          },
        });
      },
    },
  ],
};
