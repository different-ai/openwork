import { expect } from "vitest";
import {
  createOrgConnection,
  denFetch,
  evalIn,
  waitFor,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { closeTarget, listTargets, navigate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import type { MockMcpHandle } from "@openwork/labs";
import {
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
  ? `capability search scale skipped — needs: ${missingRequirements.join(", ")}`
  : "capability search stays fast and accurate against a 400-tool connection";

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

function hasCapability(matches: Record<string, unknown>[], connectionId: string, toolName: string): boolean {
  return matches.some((entry) => entry.name === `mcp:${connectionId}:${toolName}`);
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
    mocks: { scale: mcpMock({ extraToolCount: 400 }) },
  });
  const scale = await createOrgConnection(den.admin, {
    name: `Capability Search Scale ${Date.now()}`,
    url: den.mocks.scale.mcpUrl,
    authType: "oauth",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  await using browser = await chrome({
    name: "capability-search-scale",
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
  await oauthConnect(browser, den.ref.webUrl, scale, den.mocks.scale);

  const baselineToolsListCount = await toolsListCount(den.mocks.scale);
  const orgId = await organizationId(den.admin);
  const mcpToken = await mintMcpToken(den.admin, orgId);

  const coldStartedAt = Date.now();
  const coldResult = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: "mock_tool_237",
    limit: 20,
  });
  const coldDurationMs = Date.now() - coldStartedAt;
  const coldMatches = searchMatches(coldResult);
  const coldToolsListCount = await toolsListCount(den.mocks.scale);
  const coldToolsListIncrease = coldToolsListCount - baselineToolsListCount;
  const coldFoundExact = hasCapability(coldMatches, scale.id, "mock_tool_237");
  evidence.recordAssertionEvidence(
    "Cold scale search is fast, bounded, accurate, and probes the provider",
    JSON.stringify({ coldDurationMs, matchCount: coldMatches.length, coldFoundExact, coldToolsListIncrease }),
    coldDurationMs < 15_000 && coldFoundExact && coldMatches.length <= 20 && coldToolsListIncrease >= 1,
  );
  expect(coldDurationMs).toBeLessThan(15_000);
  expect(coldFoundExact).toBe(true);
  expect(coldMatches.length).toBeLessThanOrEqual(20);
  expect(coldToolsListIncrease).toBeGreaterThanOrEqual(1);

  const warmStartedAt = Date.now();
  const warmResult = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: "mock_tool_351",
    limit: 20,
  });
  const warmDurationMs = Date.now() - warmStartedAt;
  const warmMatches = searchMatches(warmResult);
  const warmToolsListCount = await toolsListCount(den.mocks.scale);
  const warmToolsListIncrease = warmToolsListCount - coldToolsListCount;
  const warmFoundExact = hasCapability(warmMatches, scale.id, "mock_tool_351");
  evidence.recordAssertionEvidence(
    "Warm scale search is fast, bounded, accurate, and served without a re-probe",
    JSON.stringify({ warmDurationMs, matchCount: warmMatches.length, warmFoundExact, warmToolsListIncrease }),
    warmDurationMs < 3_000 && warmFoundExact && warmMatches.length <= 20 && warmToolsListIncrease === 0,
  );
  expect(warmDurationMs).toBeLessThan(3_000);
  expect(warmFoundExact).toBe(true);
  expect(warmMatches.length).toBeLessThanOrEqual(20);
  expect(warmToolsListIncrease).toBe(0);

  const keywordResult = await callTool(den.ref.apiUrl, mcpToken, "search_capabilities", {
    query: "kw42",
    limit: 20,
  });
  const keywordMatches = searchMatches(keywordResult);
  const keywordToolsListCount = await toolsListCount(den.mocks.scale);
  const keywordToolsListIncrease = keywordToolsListCount - warmToolsListCount;
  const keywordFoundExact = hasCapability(keywordMatches, scale.id, "mock_tool_42");
  evidence.recordAssertionEvidence(
    "Warm cached scale search finds a description token without a re-probe",
    JSON.stringify({ matchCount: keywordMatches.length, keywordFoundExact, keywordToolsListIncrease }),
    keywordFoundExact && keywordToolsListIncrease === 0,
  );
  expect(keywordFoundExact).toBe(true);
  expect(keywordToolsListIncrease).toBe(0);
});
