import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { expect } from "vitest";
import { createOrgConnection, denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  mcpMock,
  needs,
  server,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type {
  Den,
  MockMcpHandshake,
  MockToolCall,
  NeedsSpec,
  Place,
} from "@openwork/testkit";

async function mysqlIsReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    let socket: Socket | undefined;
    try {
      const connectedSocket = createConnection({ host: "127.0.0.1", port: 3306 });
      socket = connectedSocket;
      let settled = false;
      const finish = (reachable: boolean) => {
        if (settled) return;
        settled = true;
        connectedSocket.destroy();
        resolve(reachable);
      };
      connectedSocket.setTimeout(750);
      connectedSocket.once("data", () => finish(true));
      connectedSocket.once("timeout", () => finish(false));
      connectedSocket.once("error", () => finish(false));
    } catch {
      socket?.destroy();
      resolve(false);
    }
  });
}

const denApiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim() ?? "";
const externalDen = Boolean(denApiUrl);
const mysqlReachable = await mysqlIsReachable();
const externalMockRequirement = externalDen ? ["OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL"] : [];
const requirements: NeedsSpec = { env: externalMockRequirement };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = !denApiUrl && !mysqlReachable
  ? "org connector session reuse skipped — needs: OPENWORK_EVAL_DEN_API_URL or local MySQL on 127.0.0.1:3306"
  : missingRequirements.length > 0
  ? `org connector session reuse skipped — needs: ${missingRequirements.join(", ")}`
  : "organization connector sessions are reused, isolated, rotated, and recovered through Den";

const killSwitchTitle = !mysqlReachable
  ? "org connector session reuse kill switch skipped — needs: local MySQL on 127.0.0.1:3306 (boots its own Den to control the reuse flag)"
  : "DEN_EXTERNAL_MCP_SESSION_REUSE=0 opens a fresh connector session for every downstream operation";

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

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

async function organizationId(session: DenSession, orgName: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", { headers: auth(session) });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = orgs.find((entry) => entry.name === orgName);
  const id = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding ${orgName} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

async function selectOrganization(session: DenSession, orgId: string): Promise<void> {
  const result = await denFetch(session, "/v1/me/active-organization", {
    method: "POST",
    headers: auth(session),
    body: JSON.stringify({ organizationId: orgId }),
  });
  if (!result.response.ok) {
    throw new Error(`Selecting organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

async function mintMcpToken(session: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST",
    headers: { ...auth(session), "x-openwork-org-id": orgId },
    body: JSON.stringify({}),
  });
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !token.startsWith("ow_mcp_at_")) {
    throw new Error(`Minting MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return token;
}

async function callAgentTool(
  den: DenSession,
  mcpToken: string,
  name: "search_capabilities" | "execute_capability",
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${den.apiUrl}/mcp/agent`, {
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
    signal: AbortSignal.timeout(45_000),
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

async function searchMockEcho(den: DenSession, token: string, connectionId: string): Promise<{
  name: string;
  schemaDigest: string;
}> {
  const result = await callAgentTool(den, token, "search_capabilities", {
    query: "mock echo",
    limit: 10,
    type: "mcp",
  });
  const payload = requireRecord(toolJson(result), "search_capabilities payload");
  const matches = Array.isArray(payload.matches) ? payload.matches.filter(isRecord) : [];
  const match = matches.find((entry) => entry.name === `mcp:${connectionId}:mock_echo`);
  if (!match || typeof match.name !== "string" || typeof match.schemaDigest !== "string") {
    throw new Error(`mock_echo was not discoverable: ${JSON.stringify(matches).slice(0, 1_000)}`);
  }
  return { name: match.name, schemaDigest: match.schemaDigest };
}

async function executeMockEcho(
  den: DenSession,
  token: string,
  capability: { name: string; schemaDigest: string },
  marker: string,
): Promise<string> {
  const result = await callAgentTool(den, token, "execute_capability", {
    name: capability.name,
    schemaDigest: capability.schemaDigest,
    body: { text: marker },
  });
  const text = toolText(result);
  expect(text).toContain(marker);
  return text;
}

async function completeOAuth(session: DenSession, connectionId: string, connector: Den["mocks"][string]): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = await denFetch(session, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/connect/start`, {
    headers: auth(session),
  });
  const body = requireRecord(started.body, "connect/start response");
  const authorizeUrl = typeof body.authorizeUrl === "string" ? body.authorizeUrl : "";
  if (!started.response.ok || body.status !== "needs_auth" || !authorizeUrl) {
    throw new Error(`OAuth connect/start failed: HTTP ${started.response.status} ${started.text.slice(0, 500)}`);
  }
  const authorize = await fetch(authorizeUrl, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
  const callbackUrl = authorize.headers.get("location");
  if (!callbackUrl) throw new Error(`Mock OAuth authorize did not redirect: HTTP ${authorize.status}`);
  const callback = await fetch(callbackUrl, { signal: AbortSignal.timeout(30_000) });
  if (!callback.ok) throw new Error(`Den OAuth callback failed: HTTP ${callback.status} ${(await callback.text()).slice(0, 500)}`);
  await connector.authorizeRequestSince(startedAt, { timeoutMs: 30_000 });
}

async function disconnectMember(session: DenSession, connectionId: string): Promise<void> {
  const result = await denFetch(session, `/v1/mcp-connections/${encodeURIComponent(connectionId)}/disconnect-my-account`, {
    method: "POST",
    headers: auth(session),
    body: JSON.stringify({}),
  });
  if (!result.response.ok) {
    throw new Error(`Member disconnect failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

async function bootDen(place: Place, sessionReuse: "0" | "1", orgName: string): Promise<Den> {
  const boot = () => server({
    place,
    mocks: {
      connector: mcpMock({
        publicUrl: sessionReuse === "1" ? process.env.OPENWORK_EVAL_CONNECTOR_MOCK_PUBLIC_URL?.trim() || undefined : undefined,
      }),
    },
    org: {
      name: orgName,
      members: {
        a: { name: "Member A Session Spec" },
        b: { name: "Member B Session Spec" },
      },
    },
  });
  if (externalDen && sessionReuse === "1") return boot();

  const previousDenApiUrl = process.env.OPENWORK_EVAL_DEN_API_URL;
  const previous = process.env.DEN_EXTERNAL_MCP_SESSION_REUSE;
  delete process.env.OPENWORK_EVAL_DEN_API_URL;
  process.env.DEN_EXTERNAL_MCP_SESSION_REUSE = sessionReuse;
  try {
    return await boot();
  } finally {
    if (previousDenApiUrl === undefined) delete process.env.OPENWORK_EVAL_DEN_API_URL;
    else process.env.OPENWORK_EVAL_DEN_API_URL = previousDenApiUrl;
    if (previous === undefined) delete process.env.DEN_EXTERNAL_MCP_SESSION_REUSE;
    else process.env.DEN_EXTERNAL_MCP_SESSION_REUSE = previous;
  }
}

function callWithMarker(calls: MockToolCall[], marker: string): MockToolCall | undefined {
  return calls.find((call) => call.args.text === marker);
}

async function noAdditionalHandshake(
  connector: Den["mocks"][string],
  sinceIso: string,
  expectedCount: number,
): Promise<MockMcpHandshake[]> {
  return connector.handshakes({ sinceIso, atLeast: expectedCount + 1, timeoutMs: 1_500 });
}

test.skipIf(!denApiUrl && !mysqlReachable)(title, async ({ evidence, place }) => {
  // Direct Den capability calls have no model or UI surface. The mock connector
  // is the sole witness, so this server-only spec intentionally has no fraimz.
  needs(requirements);
  const orgName = `Session Reuse Spec ${Date.now()}`;
  const runStartedAt = new Date().toISOString();
  await using den = await bootDen(place, "1", orgName);
  const connector = den.mocks.connector;
  const memberA = den.members.a;
  const memberB = den.members.b;
  if (!connector || !memberA || !memberB) throw new Error("Session reuse fixture did not provision its connector and two members.");

  const orgId = await organizationId(den.admin, orgName);
  await Promise.all([
    selectOrganization(den.admin, orgId),
    selectOrganization(memberA, orgId),
    selectOrganization(memberB, orgId),
  ]);
  const connection = await createOrgConnection(den.admin, {
    name: `Session Reuse Connector ${Date.now()}`,
    url: connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  await completeOAuth(memberA, connection.id, connector);
  await completeOAuth(memberB, connection.id, connector);
  const [tokenA, tokenB] = await Promise.all([
    mintMcpToken(memberA, orgId),
    mintMcpToken(memberB, orgId),
  ]);

  let handshakeCount = (await connector.handshakes({ sinceIso: runStartedAt })).length;
  let toolCallCount = (await connector.toolCalls({ sinceIso: runStartedAt })).length;

  // 1. REUSE: discovery and repeated execution stay on member A's one session.
  const capability = await searchMockEcho(memberA, tokenA, connection.id);
  const aFirstMarker = `reuse-a-first-${Date.now()}`;
  const aSecondMarker = `reuse-a-second-${Date.now()}`;
  await executeMockEcho(memberA, tokenA, capability, aFirstMarker);
  await executeMockEcho(memberA, tokenA, capability, aSecondMarker);
  const reuseHandshakes = await connector.handshakes({
    sinceIso: runStartedAt,
    atLeast: handshakeCount + 1,
    timeoutMs: 30_000,
  });
  const reuseCalls = await connector.toolCalls({
    sinceIso: runStartedAt,
    atLeast: toolCallCount + 2,
    timeoutMs: 30_000,
  });
  const newReuseHandshakes = reuseHandshakes.slice(handshakeCount);
  const newReuseCalls = reuseCalls.slice(toolCallCount);
  const aSessionId = newReuseCalls[0]?.sessionId ?? null;
  const aTokenId = newReuseCalls[0]?.tokenId ?? null;
  const noSecondReuseHandshake = await noAdditionalHandshake(connector, runStartedAt, handshakeCount + 1);
  const reuseProven = newReuseHandshakes.length === 1
    && newReuseCalls.length === 2
    && aSessionId !== null
    && newReuseCalls.every((call) => call.sessionId === aSessionId)
    && newReuseHandshakes[0]?.sessionId === aSessionId
    && noSecondReuseHandshake.length === handshakeCount + 1;
  evidence.fact(
    "Member A reused one connector session across discovery and repeated execution",
    `Connector handshakes: ${JSON.stringify(newReuseHandshakes)}; tool calls: ${JSON.stringify(newReuseCalls)}; bounded no-second-handshake count: ${noSecondReuseHandshake.length - handshakeCount}`,
    reuseProven,
  );
  expect(reuseProven).toBe(true);
  handshakeCount += 1;
  toolCallCount += 2;

  // 2. ISOLATION: B gets a different session and credential; A keeps its own.
  const bCapability = await searchMockEcho(memberB, tokenB, connection.id);
  const bMarker = `isolation-b-${Date.now()}`;
  const aReturnMarker = `isolation-a-return-${Date.now()}`;
  await executeMockEcho(memberB, tokenB, bCapability, bMarker);
  await executeMockEcho(memberA, tokenA, capability, aReturnMarker);
  const isolationHandshakes = await connector.handshakes({
    sinceIso: runStartedAt,
    atLeast: handshakeCount + 1,
    timeoutMs: 30_000,
  });
  const isolationCalls = await connector.toolCalls({
    sinceIso: runStartedAt,
    atLeast: toolCallCount + 2,
    timeoutMs: 30_000,
  });
  const newIsolationHandshakes = isolationHandshakes.slice(handshakeCount);
  const newIsolationCalls = isolationCalls.slice(toolCallCount);
  const bCall = callWithMarker(newIsolationCalls, bMarker);
  const returningACall = callWithMarker(newIsolationCalls, aReturnMarker);
  const noIsolationLeakHandshake = await noAdditionalHandshake(connector, runStartedAt, handshakeCount + 1);
  const isolationProven = newIsolationHandshakes.length === 1
    && bCall !== undefined
    && bCall.sessionId !== null
    && bCall.sessionId !== aSessionId
    && bCall.tokenId !== null
    && bCall.tokenId !== aTokenId
    && newIsolationCalls.filter((call) => call.args.text === bMarker).every((call) => call.sessionId !== aSessionId)
    && returningACall?.sessionId === aSessionId
    && returningACall?.tokenId === aTokenId
    && noIsolationLeakHandshake.length === handshakeCount + 1;
  evidence.fact(
    "Member sessions and bearer credentials remained isolated",
    `Connector handshakes: ${JSON.stringify(newIsolationHandshakes)}; B and returning-A calls: ${JSON.stringify(newIsolationCalls)}; bounded handshake count: ${noIsolationLeakHandshake.length - handshakeCount}`,
    isolationProven,
  );
  expect(isolationProven).toBe(true);
  handshakeCount += 1;
  toolCallCount += 2;

  // 3. ROTATION INVALIDATES: A disconnects and reconnects, then gets one new session.
  await disconnectMember(memberA, connection.id);
  await completeOAuth(memberA, connection.id, connector);
  handshakeCount = (await connector.handshakes({ sinceIso: runStartedAt })).length;
  const rotationMarker = `rotation-a-${Date.now()}`;
  await executeMockEcho(memberA, tokenA, capability, rotationMarker);
  const rotationHandshakes = await connector.handshakes({
    sinceIso: runStartedAt,
    atLeast: handshakeCount + 1,
    timeoutMs: 30_000,
  });
  const rotationCalls = await connector.toolCalls({
    sinceIso: runStartedAt,
    atLeast: toolCallCount + 1,
    timeoutMs: 30_000,
  });
  const newRotationHandshakes = rotationHandshakes.slice(handshakeCount);
  const newRotationCalls = rotationCalls.slice(toolCallCount);
  const rotatedCall = callWithMarker(newRotationCalls, rotationMarker);
  const noSecondRotationHandshake = await noAdditionalHandshake(connector, runStartedAt, handshakeCount + 1);
  const rotationProven = newRotationHandshakes.length === 1
    && rotatedCall !== undefined
    && rotatedCall.sessionId !== null
    && rotatedCall.sessionId !== aSessionId
    && rotatedCall.tokenId !== null
    && rotatedCall.tokenId !== aTokenId
    && newRotationHandshakes[0]?.sessionId === rotatedCall.sessionId
    && noSecondRotationHandshake.length === handshakeCount + 1;
  evidence.fact(
    "Rotating member A's credential invalidated the old pooled session",
    `Connector handshakes after reconnect completed: ${JSON.stringify(newRotationHandshakes)}; rotated call: ${JSON.stringify(rotatedCall)}; bounded no-second-handshake count: ${noSecondRotationHandshake.length - handshakeCount}`,
    rotationProven,
  );
  expect(rotationProven).toBe(true);
  handshakeCount += 1;
  toolCallCount += 1;

  // 4. DEAD SESSION: one 404-driven eviction, one fresh retry, successful result.
  const invalidatedSessions = await connector.invalidateSessions();
  const deadSessionMarker = `dead-session-a-${Date.now()}`;
  const deadSessionResult = await executeMockEcho(memberA, tokenA, capability, deadSessionMarker);
  const recoveryHandshakes = await connector.handshakes({
    sinceIso: runStartedAt,
    atLeast: handshakeCount + 1,
    timeoutMs: 30_000,
  });
  const recoveryCalls = await connector.toolCalls({
    sinceIso: runStartedAt,
    atLeast: toolCallCount + 1,
    timeoutMs: 30_000,
  });
  const newRecoveryHandshakes = recoveryHandshakes.slice(handshakeCount);
  const newRecoveryCalls = recoveryCalls.slice(toolCallCount);
  const recoveryCall = callWithMarker(newRecoveryCalls, deadSessionMarker);
  const noSecondRecoveryHandshake = await noAdditionalHandshake(connector, runStartedAt, handshakeCount + 1);
  const recoveryProven = invalidatedSessions > 0
    && deadSessionResult.includes(deadSessionMarker)
    && newRecoveryHandshakes.length === 1
    && recoveryCall !== undefined
    && recoveryCall.sessionId === newRecoveryHandshakes[0]?.sessionId
    && recoveryCall.sessionId !== rotatedCall?.sessionId
    && noSecondRecoveryHandshake.length === handshakeCount + 1;
  evidence.fact(
    "A dead connector session was evicted and retried exactly once",
    `Mock invalidated ${invalidatedSessions} live sessions; recovery handshakes: ${JSON.stringify(newRecoveryHandshakes)}; successful call: ${JSON.stringify(recoveryCall)}; bounded no-second-handshake count: ${noSecondRecoveryHandshake.length - handshakeCount}`,
    recoveryProven,
  );
  expect(recoveryProven).toBe(true);
});

test.skipIf(!mysqlReachable)(killSwitchTitle, async ({ evidence, place }) => {
  // This test always boots its own local Den because an external Den cannot let it control DEN_EXTERNAL_MCP_SESSION_REUSE.
  const orgName = `Session Reuse Off Spec ${Date.now()}`;
  const runStartedAt = new Date().toISOString();
  await using den = await bootDen(place, "0", orgName);
  const connector = den.mocks.connector;
  const memberA = den.members.a;
  if (!connector || !memberA) throw new Error("Kill-switch fixture did not provision its connector and member.");

  const orgId = await organizationId(den.admin, orgName);
  await Promise.all([selectOrganization(den.admin, orgId), selectOrganization(memberA, orgId)]);
  const connection = await createOrgConnection(den.admin, {
    name: `Session Reuse Off Connector ${Date.now()}`,
    url: connector.mcpUrl,
    authType: "oauth",
    credentialMode: "per_member",
    access: { orgWide: true },
  });
  await completeOAuth(memberA, connection.id, connector);
  const tokenA = await mintMcpToken(memberA, orgId);
  const capability = await searchMockEcho(memberA, tokenA, connection.id);

  // Discovery above resolves the exact capability. With reuse disabled, the
  // subsequent execute opens one session to validate tools/list and a second
  // to invoke tools/call; neither may be reused.
  const handshakeBaseline = (await connector.handshakes({ sinceIso: runStartedAt })).length;
  const callBaseline = (await connector.toolCalls({ sinceIso: runStartedAt })).length;
  const marker = `kill-switch-${Date.now()}`;
  await executeMockEcho(memberA, tokenA, capability, marker);
  const handshakes = await connector.handshakes({
    sinceIso: runStartedAt,
    atLeast: handshakeBaseline + 2,
    timeoutMs: 30_000,
  });
  const calls = await connector.toolCalls({
    sinceIso: runStartedAt,
    atLeast: callBaseline + 1,
    timeoutMs: 30_000,
  });
  const freshHandshakes = handshakes.slice(handshakeBaseline);
  const freshCalls = calls.slice(callBaseline);
  const call = callWithMarker(freshCalls, marker);
  const noThirdHandshake = await noAdditionalHandshake(connector, runStartedAt, handshakeBaseline + 2);
  const sessionIds = new Set(freshHandshakes.map((handshake) => handshake.sessionId));
  const killSwitchProven = freshHandshakes.length === 2
    && sessionIds.size === 2
    && !sessionIds.has(null)
    && call?.sessionId === freshHandshakes[1]?.sessionId
    && call?.sessionId !== freshHandshakes[0]?.sessionId
    && noThirdHandshake.length === handshakeBaseline + 2;
  evidence.fact(
    "The kill switch disabled connector session reuse",
    `Execute handshakes: ${JSON.stringify(freshHandshakes)}; tool call: ${JSON.stringify(call)}; bounded no-third-handshake count: ${noThirdHandshake.length - handshakeBaseline}`,
    killSwitchProven,
  );
  expect(killSwitchProven).toBe(true);
});
