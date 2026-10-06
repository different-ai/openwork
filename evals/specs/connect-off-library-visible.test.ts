import { expect } from "vitest";
import { createOrgConnection, denFetch, saveWorkflow } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { mcpMock, needs, server, test } from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value: unknown, label = "value"): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`Expected ${label} to be an object: ${JSON.stringify(value)?.slice(0, 500)}`);
  return value;
}
function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error(`Expected a string, got ${JSON.stringify(value)}`);
  return value;
}
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

type Surfaces = { connect: boolean; library: boolean };

// Turning OpenWork Connect off for an organization hides its connections. Until
// libraryWithoutConnect is rolled out it also hides marketplace skills, plugin
// capabilities and Workflows, exactly as before; with it on, they stay.
test("Connect off hides connections; skills and Workflows stay only with libraryWithoutConnect", { timeout: 300_000 }, async ({ place, evidence }) => {
  needs({ commands: ["bun", "pnpm"], placement: "local" });
  const stamp = Date.now();
  const organizationName = `Connect Off Library ${stamp}`;
  await using den = await server({
    place, web: false,
    org: { name: organizationName, members: {} },
    mocks: { tools: mcpMock({ allowUnauthenticatedMcp: true }) },
  });
  expect(den.database, "Must cold-boot an owned isolated database, never attach a shared Den").toBeDefined();
  const admin = den.admin;
  const auth = (session: DenSession) => ({ authorization: `Bearer ${session.token}` });

  const orgs = await denFetch(admin, "/v1/me/orgs", { headers: auth(admin) });
  expect(orgs.response.status, orgs.text).toBe(200);
  const organizationId = text(rows(record(orgs.body).orgs).find((org) => org.name === organizationName)?.id);

  const connection = await createOrgConnection(admin, {
    name: `Library probe tools ${stamp}`, url: den.mocks.tools.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true },
  });

  const skillName = `connect-off-skill-${stamp}`;
  const skillBody = `Return the connect-off proof phrase ${stamp}.`;
  const created = await denFetch(admin, "/v1/plugins", {
    method: "POST", headers: auth(admin),
    body: JSON.stringify({
      name: `Connect off plugin ${stamp}`,
      components: [{ type: "skill", input: { rawSourceText: `---\nname: ${skillName}\ndescription: Proves skills survive Connect being off.\n---\n\n${skillBody}` } }],
    }),
  });
  expect(created.response.ok, created.text).toBe(true);
  const pluginId = text(record(record(created.body).item, "plugin").id);

  const minted = await denFetch(admin, "/v1/mcp/token", {
    method: "POST", headers: { ...auth(admin), "x-openwork-org-id": organizationId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  expect(minted.response.status, minted.text).toBe(200);
  const mcpToken = text(record(minted.body).token);

  let requestId = 0;
  async function rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${mcpToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(120_000),
    });
    const raw = await response.text();
    expect(response.status, raw).toBe(200);
    const line = raw.split("\n").find((value) => value.startsWith("data:"));
    const message = record(JSON.parse(line ? line.slice(5) : raw), "JSON-RPC message");
    expect(message.error, JSON.stringify(message.error)).toBeUndefined();
    return record(message.result, `${method} result`);
  }
  async function tool(name: string, args: Record<string, unknown>) {
    const result = await rpc("tools/call", { name, arguments: args });
    const first = rows(result.content)[0];
    return { result, payload: parseJson(typeof first?.text === "string" ? first.text : "") };
  }

  // A Workflow with no connection tools, saved from a successful Code Mode run.
  const workflowName = `Connect off workflow ${stamp}`;
  const workflowCode = "return { echoed: input.marker }";
  const workflowSchemas = {
    inputSchema: { type: "object", properties: { marker: { type: "string" } }, required: ["marker"], additionalProperties: false },
    outputSchema: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"], additionalProperties: false },
  };
  const tested = await tool("execute_capability_script", { code: workflowCode, input: { marker: "probe" }, ...workflowSchemas });
  expect(tested.result.isError, JSON.stringify(tested.payload)).not.toBe(true);
  const saved = await saveWorkflow(admin, { name: workflowName, code: workflowCode, currentInput: { marker: "probe" }, ...workflowSchemas });
  expect(saved.status, saved.text).toBe(201);
  const workflowCapability = `plugin:${text(record(saved.body).pluginId)}:${text(record(saved.body).configObjectId)}`;

  async function setFeatures(capabilities: { mcpConnections: boolean; libraryWithoutConnect: boolean }) {
    const switched = await denFetch(admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
      method: "PUT", headers: auth(admin), body: JSON.stringify({ capabilities }),
    });
    expect(switched.response.status, switched.text).toBe(200);
    expect(switched.body).toMatchObject({ capabilities });
  }

  let skillCapability = "";
  let skillLocation = "";
  async function observe(): Promise<Surfaces> {
    // Connections.
    const usable = await denFetch(admin, "/v1/mcp-connections?scope=usable", { headers: auth(admin) });
    expect(usable.response.status, usable.text).toBe(200);
    const connectionListed = rows(record(usable.body).connections).some((entry) => entry.id === connection.id);
    const mcpSearch = await tool("search_capabilities", { query: "mock_echo", type: "mcp", limit: 20 });
    const mcpMatches = rows(record(mcpSearch.payload, "mcp search").matches).filter((entry) => text(entry.name).startsWith("mcp:"));
    expect(mcpMatches.length > 0, "connection tools are searchable exactly when connections are listed").toBe(connectionListed);

    // Marketplace skill: search, list_skills, get_skill, skill:// resources, execute_capability.
    const skillSearch = await tool("search_capabilities", { query: skillName, type: "skills", limit: 20 });
    const skillMatch = rows(record(skillSearch.payload, "skill search").matches).find((entry) => text(entry.name).startsWith(`plugin:${pluginId}:`));
    if (skillMatch) skillCapability = text(skillMatch.name);
    if (!skillCapability) throw new Error("The skill must be found while Connect is on before it can be checked hidden");
    const listed = await tool("list_skills", {});
    const skill = rows(record(listed.result.structuredContent, "list_skills").skills).find((entry) => entry.capability === skillCapability);
    expect(Boolean(skill), "list_skills agrees with skill search").toBe(Boolean(skillMatch));
    if (skill) skillLocation = text(skill.location);
    const resources = await rpc("resources/list", {});
    const skillResource = rows(resources.resources).some((entry) => entry.uri === skillLocation);
    expect(skillResource, "skill:// resources agree with list_skills").toBe(Boolean(skill));
    const index = await rpc("resources/read", { uri: "skill://index.json" });
    const indexText = text(rows(index.contents)[0]?.text);
    expect(indexText.includes(skillCapability), "skill://index.json agrees with list_skills").toBe(Boolean(skill));
    const executedSkill = await tool("execute_capability", { name: skillCapability });
    if (skill) {
      const read = await tool("get_skill", { name: skillCapability });
      expect(read.result.isError, JSON.stringify(read.payload)).not.toBe(true);
      expect(JSON.stringify(read.result.content)).toContain(skillBody);
      expect(executedSkill.result.isError, JSON.stringify(executedSkill.payload)).not.toBe(true);
    } else {
      expect(executedSkill.result.isError).toBe(true);
      expect(executedSkill.payload).toMatchObject({ error: "unknown_capability" });
    }

    // Workflow: search as kind workflow, and run it.
    const workflowSearch = await tool("search_capabilities", { query: workflowName, type: "marketplace", limit: 20 });
    const workflowMatch = rows(record(workflowSearch.payload, "workflow search").matches).find((entry) => entry.name === workflowCapability);
    if (workflowMatch) expect(workflowMatch.kind).toBe("workflow");
    const marker = `run-${Date.now()}`;
    const ran = await tool("execute_capability", { name: workflowCapability, body: { marker } });
    if (workflowMatch) {
      expect(ran.result.isError, JSON.stringify(ran.payload)).not.toBe(true);
      expect(JSON.stringify(ran.payload)).toContain(marker);
    } else {
      expect(ran.result.isError).toBe(true);
      expect(ran.payload).toMatchObject({ error: "unknown_capability" });
    }
    // Hidden or not, a library item never asks the member to connect anything.
    expect(JSON.stringify(ran.payload)).not.toMatch(/needs_connection|reauth_required|reconnect|connect your account/i);

    // The desktop's assigned-capabilities inventory.
    const assigned = await denFetch(admin, "/v1/resources/marketplace-capabilities", { headers: { ...auth(admin), "x-openwork-org-id": organizationId } });
    expect(assigned.response.status, assigned.text).toBe(200);
    const assignedPlugins = new Set(rows(record(assigned.body).items).map((entry) => entry.pluginId));
    expect(assignedPlugins.has(pluginId), "assigned inventory agrees with list_skills").toBe(Boolean(skill));
    expect(assignedPlugins.has(record(saved.body).pluginId), "assigned inventory agrees with Workflow search").toBe(Boolean(workflowMatch));

    expect(Boolean(workflowMatch), "Workflows and skills share one gate").toBe(Boolean(skill));
    return { connect: connectionListed, library: Boolean(skill) };
  }

  const cases: { features: { mcpConnections: boolean; libraryWithoutConnect: boolean }; expected: Surfaces; claim: string }[] = [
    { features: { mcpConnections: true, libraryWithoutConnect: false }, expected: { connect: true, library: true }, claim: "Connect on: connections, skills and Workflows are all available" },
    { features: { mcpConnections: false, libraryWithoutConnect: false }, expected: { connect: false, library: false }, claim: "Connect off before the rollout: today's behavior, connections, skills and Workflows are all hidden" },
    { features: { mcpConnections: false, libraryWithoutConnect: true }, expected: { connect: false, library: true }, claim: "Connect off with libraryWithoutConnect: connections are hidden, skills and Workflows stay" },
    { features: { mcpConnections: true, libraryWithoutConnect: true }, expected: { connect: true, library: true }, claim: "Connect on with libraryWithoutConnect: nothing changes" },
  ];
  for (const { features, expected, claim } of cases) {
    await setFeatures(features);
    const observed = await observe();
    expect(observed, claim).toEqual(expected);
    evidence.recordAssertionEvidence(claim, `mcpConnections=${features.mcpConnections}, libraryWithoutConnect=${features.libraryWithoutConnect}: connection listed=${observed.connect}, skill and Workflow available=${observed.library}.`, true);
  }
});
