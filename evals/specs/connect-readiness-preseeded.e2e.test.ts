import { expect, onTestFinished } from "vitest";
import { createOrgConnection, deleteConnection, denFetch, evalIn, go } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import type { Surface } from "@openwork/cdp";
import {
  app,
  eventually,
  localMysqlIsRunning,
  mcpMock,
  needs,
  readConnectState,
  server,
  test,
} from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const remotePlacement = process.env.OPENWORK_EVAL_DAYTONA === "1" || Boolean(process.env.OPENWORK_EVAL_DEN_API_URL?.trim());
const mysqlOpen = remotePlacement || await localMysqlIsRunning();
const title = !e2eTestsEnabled
  ? "preseeded Connect readiness skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !mysqlOpen
    ? "preseeded Connect readiness skipped — needs: MySQL on 127.0.0.1:3306 for local placement"
    : "bundled engine connects to preseeded organization skills and connections";
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
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs.filter(isRecord) : [];
  const id = orgs[0] && typeof orgs[0].id === "string" ? orgs[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the provisioned organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function mintMcpToken(session: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId },
    body: JSON.stringify({}),
  });
  const mcpToken = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !mcpToken.startsWith("ow_mcp_at_")) {
    throw new Error(`Minting the member Connect token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return mcpToken;
}

async function callTool(
  apiUrl: string,
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

async function readCloudMcpHealth(surface: Surface, workspaceId: string): Promise<Record<string, unknown>> {
  const raw = await evalIn(surface, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return JSON.stringify({ error: "missing local server credentials" });
    const response = await fetch(
      "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/mcp/openwork-cloud/health?probe=1",
      { headers: { Authorization: "Bearer " + token } },
    );
    const text = await response.text();
    if (!response.ok) return JSON.stringify({ error: "HTTP " + response.status, body: text.slice(0, 500) });
    return text;
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  if (typeof raw !== "string") throw new Error(`Cloud MCP health response was not text: ${JSON.stringify(raw)}`);
  return requireRecord(JSON.parse(raw), "Cloud MCP health response");
}

function healthIsReady(health: Record<string, unknown>): boolean {
  const engine = isRecord(health.engine) ? health.engine : null;
  const tools = isRecord(health.tools) ? health.tools : null;
  const direct = tools && isRecord(tools.direct) ? tools.direct : null;
  return health.phase === "ready"
    && health.usable === true
    && engine?.status === "connected"
    && Array.isArray(tools?.present)
    && tools.present.includes("openwork-cloud_search_capabilities")
    && tools.present.includes("openwork-cloud_execute_capability")
    && Array.isArray(direct?.present)
    && direct.present.includes("search_capabilities")
    && direct.present.includes("execute_capability");
}

test.skipIf(!e2eTestsEnabled || !mysqlOpen)(title, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  const run = Date.now();
  const skillName = `pr3806-connect-proof-${run}`;
  const connectionName = `PR3806 conn ${String(run).slice(-6)}`;
  const nonsenseName = `no-such-capability-${run}`;
  const rawSourceText = `---\nname: ${skillName}\ndescription: Proves preseeded Connect skill discovery on OpenCode 1.18.18.\n---\n\nReturn the PR 3806 Connect proof phrase.`;

  await using den = await server({
    place,
    org: {
      name: `PR 3806 Connect Readiness ${run}`,
      admin: {
        email: `pr3806-connect-admin-${run}@openwork.test`,
        name: "PR 3806 Connect Admin",
        password: "OpenWorkEval123!",
      },
    },
    mocks: { connector: mcpMock() },
  });

  const orgId = await organizationId(den.admin);
  const createdSkill = await denFetch(den.admin, "/v1/plugins", {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": orgId },
    body: JSON.stringify({
      name: skillName,
      orgWide: true,
      components: [{ type: "skill", input: { rawSourceText } }],
    }),
  });
  const skillItem = isRecord(createdSkill.body) && isRecord(createdSkill.body.item) ? createdSkill.body.item : null;
  const pluginId = skillItem && typeof skillItem.id === "string" ? skillItem.id : "";
  if (!createdSkill.response.ok || !pluginId) {
    throw new Error(`Creating the org-wide proof skill failed: HTTP ${createdSkill.response.status} ${createdSkill.text.slice(0, 500)}`);
  }
  onTestFinished(async () => {
    await denFetch(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/archive`, {
      method: "POST",
      headers: { authorization: `Bearer ${den.admin.token}`, "x-openwork-org-id": orgId },
    }).catch(() => undefined);
  });

  const connectionInput = {
    name: connectionName,
    url: den.mocks.connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  };
  const connection = await createOrgConnection(den.admin, connectionInput);
  onTestFinished(async () => deleteConnection(den.admin, connection.id).catch(() => undefined));
  evidence.recordAssertionEvidence(
    "The organization was seeded before desktop boot",
    `Skill plugin ${pluginId} used components=[{type:"skill",input:{rawSourceText}}] with orgWide=true; connection input: ${JSON.stringify(connectionInput)}.`,
    createdSkill.response.status === 201 && connection.name === connectionName,
  );

  await using desktopApp = await app({
    den,
    as: "admin",
    place,
    beforeSignIn: async (surface) => {
      const signedOutState = await eventually(() => readConnectState(surface), {
        within: 15_000,
        label: "signed-out fresh-profile Connect state",
        until: (state) => state.ok && state.status === "missing",
      });
      const signedOutNotAvailable = signedOutState.status !== "available";
      expect(signedOutState.status).toBe("missing");
      expect(signedOutState.connectEnabled).toBe(false);
      expect(signedOutNotAvailable).toBe(true);
      evidence.recordAssertionEvidence(
        "A signed-out fresh profile has no Connect capability access",
        `Observed Connect state before sign-in: ${JSON.stringify(signedOutState)}.`,
        signedOutState.status === "missing" && signedOutState.connectEnabled === false && signedOutNotAvailable,
      );
      const shot = await screenshot(surface);
      const seen = await validate(shot, [
        "The OpenWork desktop is visible before organization sign-in",
        "No crash or error dialog is visible",
      ]);
      expect(seen.ok, seen.why).toBe(true);
    },
  });

  const signedInState = await eventually(() => readConnectState(desktopApp), {
    within: 90_000,
    label: "signed-in available Connect state",
    until: (state) => state.ok && state.status === "available" && state.connectEnabled === true,
  });
  const signedInNotMissing = signedInState.status !== "missing";
  expect(signedInState.status).toBe("available");
  expect(signedInState.connectEnabled).toBe(true);
  expect(signedInNotMissing).toBe(true);
  evidence.recordAssertionEvidence(
    "Organization sign-in enables Connect",
    `Observed Connect state after sign-in: ${JSON.stringify(signedInState)}.`,
    signedInState.status === "available" && signedInState.connectEnabled === true && signedInNotMissing,
  );

  const health = await eventually(() => readCloudMcpHealth(desktopApp, desktopApp.workspaceId), {
    within: 180_000,
    label: "OpenCode 1.18.18 openwork-cloud engine and agent-tool readiness",
    until: healthIsReady,
  });
  const engine = requireRecord(health.engine, "Cloud MCP engine health");
  const tools = requireRecord(health.tools, "Cloud MCP tools health");
  expect(health.phase).toBe("ready");
  expect(health.usable).toBe(true);
  expect(engine.status).toBe("connected");
  expect(engine.status).not.toBe("needs_auth");
  expect(engine.status).not.toBe("failed");
  expect(engine.status).not.toBe("needs_client_registration");
  expect(tools.present).toEqual(expect.arrayContaining([
    "openwork-cloud_search_capabilities",
    "openwork-cloud_execute_capability",
  ]));
  evidence.recordAssertionEvidence(
    "OpenCode 1.18.18 connects openwork-cloud with both agent tools",
    `Health payload: ${JSON.stringify({ phase: health.phase, usable: health.usable, engine, tools: tools.present })}.`,
    healthIsReady(health)
      && engine.status !== "needs_auth"
      && engine.status !== "failed"
      && engine.status !== "needs_client_registration",
  );

  const mcpToken = await mintMcpToken(den.admin, orgId);
  const skillSearch = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: skillName,
    limit: 20,
    type: "skills",
  });
  const skillMatch = searchMatches(skillSearch).find((match) => (
    match.kind === "skill" && typeof match.name === "string" && match.name.startsWith(`plugin:${pluginId}:`)
  ));
  if (!skillMatch || typeof skillMatch.name !== "string") throw new Error(`Connect did not discover the exact skill ${skillName}.`);
  const capabilityName = skillMatch.name;
  expect(skillMatch.kind).toBe("skill");
  expect(capabilityName.startsWith(`plugin:${pluginId}:`)).toBe(true);
  const execution = await callTool(den.ref.apiUrl, mcpToken, "execute_capability", { name: capabilityName });
  expect(isRecord(execution) && execution.isError === true).toBe(false);
  expect(toolJson(execution)).toMatchObject({ kind: "skill", content: rawSourceText });
  evidence.recordAssertionEvidence(
    "The member's Connect token discovers and executes the preseeded skill",
    `Search query ${skillName} returned ${JSON.stringify(skillMatch)}; execution returned the exact ${rawSourceText.length}-character source.`,
    skillMatch.kind === "skill" && capabilityName.startsWith(`plugin:${pluginId}:`) && JSON.stringify(toolJson(execution)).includes(rawSourceText),
  );

  const nonsenseSearch = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: nonsenseName,
    limit: 20,
    type: "skills",
  });
  const nonsenseSkillMatches = searchMatches(nonsenseSearch).filter((match) => (
    match.kind === "skill" && JSON.stringify(match).includes(nonsenseName)
  ));
  expect(nonsenseSkillMatches).toEqual([]);
  evidence.recordAssertionEvidence(
    "Connect does not invent a nonexistent skill",
    `Search query ${nonsenseName} returned no skill match naming that capability.`,
    nonsenseSkillMatches.length === 0,
  );

  const connectionSearch = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: connectionName,
    limit: 20,
    type: "mcp",
  });
  const connectionMatch = searchMatches(connectionSearch).find((match) => {
    const status = isRecord(match.connectionStatus) ? match.connectionStatus : null;
    return status?.connectionName === connectionName || JSON.stringify(match).includes(connectionName);
  });
  if (!connectionMatch) throw new Error(`Connect did not discover the preseeded connection ${connectionName}.`);
  const connectionStatus = isRecord(connectionMatch.connectionStatus) ? connectionMatch.connectionStatus : null;
  const readiness = connectionStatus?.state === "needs_connection" && connectionStatus.actor === "member"
    ? "needs_signin"
    : connectionStatus?.actor === "organization_admin"
      ? "needs_admin_setup"
      : "ready";
  expect(["ready", "needs_signin", "needs_admin_setup"]).toContain(readiness);
  evidence.recordAssertionEvidence(
    "The preseeded organization connection is discoverable with truthful readiness",
    `Connection match: ${JSON.stringify(connectionMatch)}; normalized readiness=${readiness}.`,
    Boolean(connectionMatch) && ["ready", "needs_signin", "needs_admin_setup"].includes(readiness),
  );

  const connectionsDeadline = Date.now() + 30_000;
  while (Date.now() < connectionsDeadline) {
    const settled = await evalIn(
      desktopApp,
      `document.body.innerText.includes(${JSON.stringify(connectionName)})`,
      { timeoutMs: 5_000 },
    ).catch(() => false);
    if (settled === true) break;
    await go(desktopApp, "/workspace/" + desktopApp.workspaceId + "/settings/extensions/connections").catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  expect(await evalIn(desktopApp, `document.body.innerText.includes(${JSON.stringify(connectionName)})`)).toBe(true);
  const signedInShot = await screenshot(desktopApp);
  const signedInSeen = await validate(signedInShot, [
    `A Library view of skills, connections, and tools lists an organization connection card named '${connectionName}'`,
    "No crash or error dialog is visible",
  ]);
  expect(signedInSeen.ok, signedInSeen.why).toBe(true);
});
