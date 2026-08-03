import { expect, onTestFinished, test } from "vitest";
import { denFetch, ensureMemberSession, signIn } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";

const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const title = apiUrl
  ? "grant-native cloud skills can be shared by their creator without recipient re-sharing"
  : "skill grant access skipped: set OPENWORK_EVAL_DEN_API_URL";
let requestId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} was not an object: ${JSON.stringify(value).slice(0, 500)}`);
  return value;
}

function toolText(result: unknown): string {
  const record = requireRecord(result, "MCP tool result");
  const first = Array.isArray(record.content) ? record.content[0] : null;
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new Error(`MCP tool result had no text content: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return first.text;
}

function toolJson(result: unknown): unknown {
  return JSON.parse(toolText(result));
}

function searchMatches(result: unknown): Record<string, unknown>[] {
  const payload = requireRecord(toolJson(result), "search_capabilities payload");
  return Array.isArray(payload.matches) ? payload.matches.filter(isRecord) : [];
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = orgs.find((entry) => entry.slug === "acme-robotics-demo")
    ?? orgs.find((entry) => entry.name === "Acme Robotics")
    ?? orgs[0];
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding Acme Robotics failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function selectOrganization(session: DenSession, orgId: string): Promise<void> {
  const result = await denFetch(session, "/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ organizationId: orgId }),
  });
  if (!result.response.ok) throw new Error(`Selecting Acme Robotics failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
}

async function mintMcpToken(session: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({}),
  });
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !token.startsWith("ow_mcp_at_")) {
    throw new Error(`Minting MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return token;
}

async function organizationMemberIdByEmail(session: DenSession, orgId: string, email: string): Promise<string> {
  const result = await denFetch(session, "/v1/org", {
    headers: {
      authorization: `Bearer ${session.token}`,
      "x-openwork-org-id": orgId,
    },
  });
  const members = isRecord(result.body) && Array.isArray(result.body.members)
    ? result.body.members.filter(isRecord)
    : [];
  const member = members.find((entry) => isRecord(entry.user) && entry.user.email === email);
  const memberId = member && typeof member.id === "string" ? member.id : "";
  if (!result.response.ok || !memberId.startsWith("om_")) {
    throw new Error(`Resolving ${email} in the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return memberId;
}

async function callTool(
  mcpToken: string,
  name: "search_capabilities" | "execute_capability",
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${apiUrl}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mcpToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`MCP tools/call failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) throw new Error(`MCP tools/call returned no SSE data frame: ${raw.slice(0, 500)}`);
  const payload: unknown = JSON.parse(dataLine.slice(5));
  const record = requireRecord(payload, "MCP JSON-RPC payload");
  if (record.error) throw new Error(`MCP tools/call returned JSON-RPC error: ${JSON.stringify(record.error)}`);
  return record.result;
}

function matchNamed(result: unknown, capabilityName: string): Record<string, unknown> | undefined {
  return searchMatches(result).find((entry) => entry.name === capabilityName);
}

test.skipIf(!apiUrl)(title, async () => {
  const den = {
    apiUrl,
    webUrl: (process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim() || apiUrl.replace("127.0.0.1", "localhost")).replace(/\/+$/, ""),
  };
  const admin = await signIn(den, {
    email: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
    password: process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!",
  });
  const orgId = await organizationId(admin);
  await selectOrganization(admin, orgId);
  const creator = await ensureMemberSession(den, admin, {
    email: process.env.OPENWORK_EVAL_CREATOR_EMAIL?.trim() || "casey.spec@acme.test",
    password: process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!",
    name: "Casey Spec",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  await selectOrganization(creator, orgId);
  const deniedEmail = process.env.OPENWORK_EVAL_MEMBER_EMAIL?.trim() || "nova.spec@acme.test";
  const denied = await ensureMemberSession(den, admin, {
    email: deniedEmail,
    password: process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!",
    name: "Nova Spec",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  await selectOrganization(denied, orgId);
  const thirdEmail = process.env.OPENWORK_EVAL_THIRD_MEMBER_EMAIL?.trim() || "riley.spec@acme.test";
  const third = await ensureMemberSession(den, admin, {
    email: thirdEmail,
    password: process.env.OPENWORK_EVAL_MEMBER_PASSWORD?.trim() || "OpenWorkDemo123!",
    name: "Riley Spec",
    markVerifiedCmd: process.env.OPENWORK_EVAL_MARK_VERIFIED_CMD?.trim(),
  });
  await selectOrganization(third, orgId);
  const skillName = `spec-grant-native-${Date.now()}`;
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves grant-native skill access over MCP.\n---\n\nReturn the grant-native proof phrase.`;
  // Plugin creation is member-level since #3411; this creator is deliberately a plain member.
  const created = await denFetch(creator, "/v1/plugins", {
    method: "POST",
    headers: {
      authorization: `Bearer ${creator.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({
      name: skillName,
      components: [{ type: "skill", input: { rawSourceText } }],
    }),
  });
  const item = isRecord(created.body) && isRecord(created.body.item) ? created.body.item : null;
  const pluginId = item && typeof item.id === "string" ? item.id : "";
  if (!created.response.ok || !pluginId) {
    throw new Error(`Creating grant-native skill failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  }
  onTestFinished(async () => {
    await denFetch(creator, `/v1/plugins/${encodeURIComponent(pluginId)}/archive`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${creator.token}`,
        "x-openwork-org-id": orgId,
      },
    }).catch(() => undefined);
  });

  const creatorToken = await mintMcpToken(creator, orgId);
  const deniedToken = await mintMcpToken(denied, orgId);
  const creatorSkillSearch = await callTool(creatorToken, "search_capabilities", { query: skillName, limit: 20, type: "skills" });
  const match = searchMatches(creatorSkillSearch).find((entry) => typeof entry.name === "string" && entry.name.startsWith(`plugin:${pluginId}:`));
  if (!match || typeof match.name !== "string") throw new Error(`Creator did not discover ${skillName}.`);
  const capabilityName = match.name;
  expect(capabilityName.length).toBeGreaterThan(`plugin:${pluginId}:`.length);
  expect(match.kind).toBe("skill");
  expect(match).not.toHaveProperty("marketplace");

  const creatorAllSearch = await callTool(creatorToken, "search_capabilities", { query: skillName, limit: 20 });
  const allMatch = matchNamed(creatorAllSearch, capabilityName);
  expect(allMatch).toBeDefined();
  expect(allMatch).not.toHaveProperty("marketplace");

  const creatorExecution = await callTool(creatorToken, "execute_capability", { name: capabilityName });
  expect(isRecord(creatorExecution) && creatorExecution.isError === true).toBe(false);
  expect(toolJson(creatorExecution)).toMatchObject({ kind: "skill", content: rawSourceText, marketplace: null });

  const deniedSkillSearch = await callTool(deniedToken, "search_capabilities", { query: skillName, limit: 20, type: "skills" });
  const deniedAllSearch = await callTool(deniedToken, "search_capabilities", { query: skillName, limit: 20 });
  expect(matchNamed(deniedSkillSearch, capabilityName)).toBeUndefined();
  expect(matchNamed(deniedAllSearch, capabilityName)).toBeUndefined();

  const deniedExecution = requireRecord(
    await callTool(deniedToken, "execute_capability", { name: capabilityName }),
    "denied execute_capability result",
  );
  expect(deniedExecution.isError).toBe(true);
  expect(toolJson(deniedExecution)).toEqual({
    error: "forbidden",
    message: "You have not been granted access to this plugin capability.",
  });

  const deniedMemberId = await organizationMemberIdByEmail(creator, orgId, deniedEmail);
  const shared = await denFetch(creator, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${creator.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ orgMembershipId: deniedMemberId, role: "viewer" }),
  });
  if (!shared.response.ok) {
    throw new Error(`Sharing grant-native skill failed: HTTP ${shared.response.status} ${shared.text.slice(0, 500)}`);
  }

  const sharedSkillSearch = await callTool(deniedToken, "search_capabilities", { query: skillName, limit: 20, type: "skills" });
  const sharedAllSearch = await callTool(deniedToken, "search_capabilities", { query: skillName, limit: 20 });
  expect(matchNamed(sharedSkillSearch, capabilityName)).toBeDefined();
  expect(matchNamed(sharedAllSearch, capabilityName)).toBeDefined();

  const sharedExecution = await callTool(deniedToken, "execute_capability", { name: capabilityName });
  expect(isRecord(sharedExecution) && sharedExecution.isError === true).toBe(false);
  expect(toolJson(sharedExecution)).toMatchObject({ kind: "skill", content: rawSourceText, marketplace: null });

  const thirdMemberId = await organizationMemberIdByEmail(creator, orgId, thirdEmail);
  const reshared = await denFetch(denied, `/v1/plugins/${encodeURIComponent(pluginId)}/access`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${denied.token}`,
      "x-openwork-org-id": orgId,
    },
    body: JSON.stringify({ orgMembershipId: thirdMemberId, role: "viewer" }),
  });
  expect(reshared.response.status).toBe(403);
});
