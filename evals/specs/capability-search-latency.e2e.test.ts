import { expect } from "vitest";
import {
  createOrgConnection,
  deleteConnection,
  denFetch,
  evalIn,
  waitFor,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { allocateFreePort, closeTarget, listTargets, navigate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { startMockMcp } from "@openwork/labs";
import type { MockMcpHandle } from "@openwork/labs";
import {
  faultProxy,
  mcpMock,
  needs,
  server,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `capability search latency skipped — needs: ${missingRequirements.join(", ")}`
  : "external MCP capability search is cached, bounded, and fresh across connection identities";

interface MockRawRequest {
  at?: string;
  rpcMethods?: string[];
}

interface MockRawLog {
  requests: MockRawRequest[];
}

interface Connection {
  id: string;
  name: string;
}

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
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const id = organizations[0] && typeof organizations[0].id === "string" ? organizations[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
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
    signal: AbortSignal.timeout(120_000),
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

function hasCapability(matches: Record<string, unknown>[], connectionId: string): boolean {
  return matches.some((entry) => entry.name === `mcp:${connectionId}:mock_echo`);
}

async function toolsListCount(mock: MockMcpHandle): Promise<number> {
  const response = await fetch(`${mock.url}/requests`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Reading mock request log failed: HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value) || !Array.isArray(value.requests)) {
    throw new Error(`Mock request log was malformed: ${JSON.stringify(value).slice(0, 500)}`);
  }
  const raw: MockRawLog = {
    requests: value.requests.filter(isRecord).map((entry) => ({
      at: typeof entry.at === "string" ? entry.at : undefined,
      rpcMethods: Array.isArray(entry.rpcMethods)
        ? entry.rpcMethods.filter((method): method is string => typeof method === "string")
        : undefined,
    })),
  };
  return raw.requests.filter(
    (entry) => Array.isArray(entry.rpcMethods) && entry.rpcMethods.includes("tools/list"),
  ).length;
}

async function oauthConnect(
  browser: Surface,
  denWebUrl: string,
  connection: Connection,
  mock: MockMcpHandle,
): Promise<void> {
  await navigate(browser.client, `${denWebUrl}/dashboard/your-connections`);
  await waitFor(browser, `document.body.innerText.includes("Your Connections")
    && document.body.innerText.includes(${JSON.stringify(connection.name)})`, {
    timeoutMs: 60_000,
    label: `${connection.name} row on Your Connections`,
  });
  const connectStartedAt = new Date().toISOString();
  await waitFor(browser, `(() => {
    const name = [...document.querySelectorAll("p")]
      .find((entry) => (entry.textContent ?? "").trim() === ${JSON.stringify(connection.name)});
    let row = name?.parentElement ?? null;
    while (row && ![...row.querySelectorAll("button")].some((button) => (button.textContent ?? "").trim() === "Connect")) {
      row = row.parentElement;
    }
    const connect = row ? [...row.querySelectorAll("button")]
      .find((button) => (button.textContent ?? "").trim() === "Connect" && !button.disabled) : null;
    connect?.click();
    return Boolean(connect);
  })()`, { timeoutMs: 30_000, label: `Connect ${connection.name} org account` });
  await mock.authorizeRequestSince(connectStartedAt, { timeoutMs: 120_000 });
  await waitFor(browser, `Boolean(document.querySelector(${JSON.stringify(`[data-testid="toggle-mcp-tool-runner-${connection.id}"]`)}))`, {
    timeoutMs: 120_000,
    label: `${connection.name} connected tool tester action`,
  });
  const oauthTargets = (await listTargets(browser.handle.cdpUrl))
    .filter((target) => target.type === "page" && !target.url.startsWith(denWebUrl));
  for (const target of oauthTargets) await closeTarget(browser.handle.cdpUrl, target.id);
}

test(title, async ({ place, evidence, skip }) => {
  needs(requirements);
  await using den = await server({
    place,
    mocks: { healthy: mcpMock() },
  });
  const flakyPort = await allocateFreePort();
  const flakyUrl = `http://127.0.0.1:${flakyPort}`;
  await using proxy = await faultProxy({
    webUrl: flakyUrl,
    apiUrl: flakyUrl,
  });
  await using flakyMock = await startMockMcp({ port: flakyPort, issuer: proxy.ref.webUrl });
  const healthy = await createOrgConnection(den.admin, {
    name: `Capability Search Healthy ${Date.now()}`,
    url: `${den.mocks.healthy.url}/mcp`,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  await using browser = await chrome({
    name: "capability-search-latency",
    startUrl: den.ref.webUrl,
    headless: true,
    host: place.host(),
  });
  await browser.client.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
    timeoutMs: 60_000,
    label: "Den Web origin before admin auth token handoff",
  });
  const tokenStored = await evalIn(browser, `(() => {
    localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
    return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
  })()`);
  expect(tokenStored).toBe(true);
  await oauthConnect(browser, den.ref.webUrl, healthy, den.mocks.healthy);
  const flaky = await createOrgConnection(den.admin, {
    name: `Capability Search Flaky ${Date.now()}`,
    url: `${proxy.ref.webUrl}/mcp`,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  await oauthConnect(browser, den.ref.webUrl, flaky, flakyMock);

  const baselineHealthyCount = await toolsListCount(den.mocks.healthy);
  const baselineFlakyCount = await toolsListCount(flakyMock);
  const orgId = await organizationId(den.admin);
  const mcpToken = await mintMcpToken(den.admin, orgId);

  const coldStartedAt = Date.now();
  const coldResult = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: "mock echo",
    limit: 20,
  });
  const coldDurationMs = Date.now() - coldStartedAt;
  const coldMatches = searchMatches(coldResult);
  const coldHealthyCount = await toolsListCount(den.mocks.healthy);
  const coldBounded = coldDurationMs < 15_000;
  const coldFoundHealthy = hasCapability(coldMatches, healthy.id);
  const coldProbedHealthy = coldHealthyCount - baselineHealthyCount >= 1;
  evidence.recordAssertionEvidence(
    "A cold capability search is correct and bounded",
    JSON.stringify({ coldDurationMs, baselineHealthyCount, baselineFlakyCount, coldHealthyCount, coldMatches }),
    coldBounded && coldFoundHealthy && coldProbedHealthy,
  );
  expect(coldDurationMs).toBeLessThan(15_000);
  expect(coldFoundHealthy).toBe(true);
  expect(coldHealthyCount - baselineHealthyCount).toBeGreaterThanOrEqual(1);

  const warmHealthyBefore = await toolsListCount(den.mocks.healthy);
  const warmFlakyBefore = await toolsListCount(flakyMock);
  const warmQueries = ["mock echo", "echo tool", "batch mock"];
  const warmObservations: { durationMs: number; foundHealthy: boolean; query: string }[] = [];
  for (const query of warmQueries) {
    const startedAt = Date.now();
    const result = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", { query, limit: 20 });
    warmObservations.push({
      durationMs: Date.now() - startedAt,
      foundHealthy: hasCapability(searchMatches(result), healthy.id),
      query,
    });
  }
  const warmHealthyAfter = await toolsListCount(den.mocks.healthy);
  const warmFlakyAfter = await toolsListCount(flakyMock);
  const allWarmFastAndCorrect = warmObservations.every(
    (observation) => observation.durationMs < 3_000 && observation.foundHealthy,
  );
  const warmHealthyReprobes = warmHealthyAfter - warmHealthyBefore;
  const warmFlakyReprobes = warmFlakyAfter - warmFlakyBefore;
  evidence.recordAssertionEvidence(
    "Warm capability searches are fast and do not re-probe either connection",
    JSON.stringify({ warmObservations, warmHealthyReprobes, warmFlakyReprobes }),
    allWarmFastAndCorrect && warmHealthyReprobes === 0 && warmFlakyReprobes === 0,
  );
  for (const observation of warmObservations) {
    expect(observation.durationMs).toBeLessThan(3_000);
    expect(observation.foundHealthy).toBe(true);
  }
  expect(warmHealthyReprobes).toBe(0);
  expect(warmFlakyReprobes).toBe(0);

  const hangfresh = await createOrgConnection(den.admin, {
    name: `Capability Search Hang Fresh ${Date.now()}`,
    url: `${proxy.ref.webUrl}/mcp`,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  await oauthConnect(browser, den.ref.webUrl, hangfresh, flakyMock);
  // Arm the hang only after hangfresh is connected: the timed search below is
  // then the first live probe of this connection, and it must not block results.
  proxy.faults.latency("/mcp", 20_000, { times: 50 });
  const hangingUpstreamBefore = await toolsListCount(flakyMock);
  const hangingSearchStartedAt = Date.now();
  const hangingResult = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: "mock echo",
    limit: 20,
  });
  const hangingDurationMs = Date.now() - hangingSearchStartedAt;
  const hangingMatches = searchMatches(hangingResult);
  const hangingFoundHealthy = hasCapability(hangingMatches, healthy.id);
  // The hung probe is aborted by the search deadline: no hangfresh capability
  // may appear, and no fresh tools/list may have reached the upstream mock.
  // A 20s hang against a <12s bound is the proof the search did not wait.
  const hangingFoundHangfresh = hasCapability(hangingMatches, hangfresh.id);
  const hangingUpstreamAfter = await toolsListCount(flakyMock);
  const hangingUpstreamProbes = hangingUpstreamAfter - hangingUpstreamBefore;
  evidence.recordAssertionEvidence(
    "A hanging provider cannot block healthy cached capability results",
    JSON.stringify({ hangingDurationMs, hangingFoundHealthy, hangingFoundHangfresh, hangingUpstreamProbes }),
    hangingDurationMs < 12_000 && hangingFoundHealthy && !hangingFoundHangfresh && hangingUpstreamProbes === 0,
  );
  expect(hangingDurationMs).toBeLessThan(12_000);
  expect(hangingFoundHealthy).toBe(true);
  expect(hangingFoundHangfresh).toBe(false);
  expect(hangingUpstreamProbes).toBe(0);

  await deleteConnection(den.admin, healthy.id);
  const replacement = await createOrgConnection(den.admin, {
    name: `Capability Search Replacement ${Date.now()}`,
    url: `${den.mocks.healthy.url}/mcp`,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  await oauthConnect(browser, den.ref.webUrl, replacement, den.mocks.healthy);
  const replacementCountBefore = await toolsListCount(den.mocks.healthy);
  const replacementStartedAt = Date.now();
  const replacementResult = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: "mock echo",
    limit: 20,
  });
  const replacementDurationMs = Date.now() - replacementStartedAt;
  const replacementMatches = searchMatches(replacementResult);
  const replacementCountAfter = await toolsListCount(den.mocks.healthy);
  const foundReplacement = hasCapability(replacementMatches, replacement.id);
  const foundDeleted = replacementMatches.some(
    (entry) => typeof entry.name === "string" && entry.name.includes(healthy.id),
  );
  const replacementProbeCount = replacementCountAfter - replacementCountBefore;
  evidence.recordAssertionEvidence(
    "Replacing a connection probes its fresh identity and never serves the deleted identity",
    JSON.stringify({ replacementDurationMs, replacementMatches, replacementProbeCount }),
    foundReplacement && !foundDeleted && replacementProbeCount >= 1,
  );
  expect(foundReplacement).toBe(true);
  expect(foundDeleted).toBe(false);
  expect(replacementProbeCount).toBeGreaterThanOrEqual(1);
});
