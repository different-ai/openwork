import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { denFetch } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import {
  eventually,
  needs,
  queryDenDatabase,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";
import { bootCloudModelInfra } from "../../worlds/cloud-model-infra.ts";

const REQUEST_TIMEOUT_MS = 30_000;
const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
  placement: "local",
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `remote desktop session command verification skipped — needs: ${missingRequirements.join(", ")}`
  : "a web remote-session command is owner-scoped and delivered through a capable desktop runner";

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

interface McpToolResult {
  isError: boolean;
  payload: Record<string, unknown>;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function denId(prefix: string): string {
  const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
  const bytes = randomBytes(26);
  let suffix = "";
  for (let index = 0; index < 26; index += 1) {
    const byte = bytes[index] ?? 0;
    suffix += index === 0 ? String(byte % 8) : alphabet[byte % 32];
  }
  return `${prefix}_${suffix}`;
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { ...auth(session), "x-openwork-org-id": orgId };
}

async function mintMcpToken(session: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST",
    headers: orgHeaders(session, orgId),
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
  if (!result.response.ok || !token) {
    throw new Error(`Minting the MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return token;
}

function parseMcpToolResult(result: unknown): McpToolResult {
  if (!isRecord(result)) throw new Error(`MCP tools/call returned a non-object result: ${JSON.stringify(result)}`);
  const content = Array.isArray(result.content) ? result.content.filter(isRecord) : [];
  const text = content
    .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
    .filter((entry) => entry.length > 0)
    .join("\n");
  const parsed: unknown = JSON.parse(text || "{}");
  return {
    isError: result.isError === true,
    payload: isRecord(parsed) ? parsed : {},
    text,
  };
}

async function parseResponse(response: Response): Promise<HttpResult> {
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body, text };
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 15 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using stack = new AsyncDisposableStack();
  const world = await bootCloudModelInfra(stack, place, {
    daytonaApiUrl: "http://127.0.0.1:9/daytona-guard",
  });
  const admin = world.admin;
  const orgId = world.org.id;
  const mcpToken = await mintMcpToken(admin, orgId);
  const databaseUrl = world.den.database?.url;
  if (!databaseUrl) throw new Error("The remote-session desktop world did not expose its database.");

  let requestId = 0;
  const callTool = async (name: "execute_capability", args: Record<string, unknown>): Promise<McpToolResult> => {
    const response = await fetch(`${world.den.ref.apiUrl}/mcp/agent`, {
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MCP tools/call failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
    const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`MCP tools/call returned no SSE data frame: ${raw.slice(0, 500)}`);
    const frame: unknown = JSON.parse(dataLine.slice(5));
    if (!isRecord(frame)) throw new Error(`MCP tools/call returned a non-object frame: ${raw.slice(0, 500)}`);
    if (frame.error) throw new Error(`MCP tools/call returned JSON-RPC error: ${JSON.stringify(frame.error)}`);
    return parseMcpToolResult(frame.result);
  };

  const registerRunner = async (runnerId: string, capabilities: string[]): Promise<string> => {
    const result = await denFetch(admin, "/v1/automation-runners/token", {
      method: "POST",
      headers: orgHeaders(admin, orgId),
      body: JSON.stringify({
        runnerId,
        protocolVersion: 1,
        supportedExecutionTargets: ["desktop"],
        capabilities,
        appVersion: "0.0.0-eval",
        platform: "darwin",
        concurrency: 1,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token : "";
    if (!result.response.ok || !token) {
      throw new Error(`Registering runner ${runnerId} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
    }
    return token;
  };

  const runnerRequest = async (
    token: string,
    path: string,
    init: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<HttpResult> => parseResponse(await fetch(`${world.den.ref.apiUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }));

  const presence = async (): Promise<HttpResult> => {
    const result = await denFetch(admin, "/v1/automation-runners/presence", {
      headers: orgHeaders(admin, orgId),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: result.response.status, body: result.body, text: result.text };
  };

  // Phase A: without runner presence the desktop target fails before touching Daytona.
  const offline = await callTool("execute_capability", {
    name: "remote-session:create",
    body: { target: "desktop", title: "Desktop command", prompt: "Open the repo" },
  });
  expect(offline.isError).toBe(true);
  expect(offline.payload.error).toBe("desktop_offline");
  evidence.recordAssertionEvidence(
    "Desktop remote-session creation is presence-gated",
    `Before runner registration, remote-session:create returned ${offline.text}.`,
    offline.isError && offline.payload.error === "desktop_offline",
  );

  // Phase B: ordinary Automation presence from an old runner must not open the
  // remote-session capability gate.
  const oldRunnerId = `eval-old-runner-${process.pid}-${Date.now().toString(36)}`;
  const oldRunnerToken = await registerRunner(oldRunnerId, []);
  const oldRunnerPresence = await eventually(
    presence,
    {
      within: 30_000,
      intervalMs: 500,
      label: "old desktop runner presence becomes connected for Automations",
      until: (result) => result.status === 200 && isRecord(result.body) && result.body.connected === true,
    },
  );
  expect(isRecord(oldRunnerPresence.body) && oldRunnerPresence.body.connected).toBe(true);
  const oldRunnerOffline = await callTool("execute_capability", {
    name: "remote-session:create",
    body: { target: "desktop", title: "Old runner must stay offline" },
  });
  expect(oldRunnerOffline.isError).toBe(true);
  expect(oldRunnerOffline.payload.error).toBe("desktop_offline");
  evidence.recordAssertionEvidence(
    "Old runners do not open the remote-session dispatch gate",
    `Runner ${oldRunnerId} registered without remote_session_v1 and counted as connected for Automations, while remote-session:create still returned ${oldRunnerOffline.text}.`,
    isRecord(oldRunnerPresence.body) && oldRunnerPresence.body.connected === true
      && oldRunnerOffline.isError && oldRunnerOffline.payload.error === "desktop_offline",
  );

  // Phase C: capability-aware registration is the durable presence signal used by the remote-session gate.
  const runnerId = `eval-runner-${process.pid}-${Date.now().toString(36)}`;
  const runnerToken = await registerRunner(runnerId, ["remote_session_v1"]);
  let firstPresence = await presence();
  if (!isRecord(firstPresence.body) || firstPresence.body.connected !== true) {
    await runnerRequest(runnerToken, "/v1/automation-runner/work");
    firstPresence = await presence();
  }
  const connectedPresence = await eventually(
    presence,
    {
      within: 30_000,
      intervalMs: 500,
      label: "desktop runner presence becomes connected",
      until: (result) => result.status === 200 && isRecord(result.body) && result.body.connected === true,
    },
  );
  expect(isRecord(connectedPresence.body) && connectedPresence.body.connected).toBe(true);
  evidence.recordAssertionEvidence(
    "A capable registered runner opens the desktop dispatch gate",
    `Runner ${runnerId} registered and the shared presence endpoint returned ${connectedPresence.text}.`,
    connectedPresence.status === 200 && isRecord(connectedPresence.body) && connectedPresence.body.connected === true,
  );

  // Phase D: create persists a queued command, while an old runner never sees its work item.
  const queued = await callTool("execute_capability", {
    name: "remote-session:create",
    body: { target: "desktop", title: "Desktop command", prompt: "Open the repo" },
  });
  const commandId = typeof queued.payload.commandId === "string" ? queued.payload.commandId : "";
  expect(queued.isError).toBe(false);
  expect(queued.payload).toMatchObject({ target: "desktop", state: "queued" });
  expect(commandId).toMatch(/^rsc_/);
  const pendingRows = await queryDenDatabase(
    databaseUrl,
    "SELECT status, title, prompt FROM remote_session_command WHERE id = ?",
    [commandId],
  );
  const pending = pendingRows.find(isRecord);
  expect(pending).toMatchObject({ status: "pending", title: "Desktop command", prompt: "Open the repo" });

  const oldWork = await runnerRequest(oldRunnerToken, "/v1/automation-runner/work");
  const oldItems = isRecord(oldWork.body) && Array.isArray(oldWork.body.items)
    ? oldWork.body.items.filter(isRecord)
    : [];
  expect(oldWork.status).toBe(200);
  expect(oldItems.some((item) => item.kind === "remote_session_create")).toBe(false);
  evidence.recordAssertionEvidence(
    "Queued commands are durable and hidden from old desktop runners",
    `Command ${commandId} persisted pending with its title and prompt; a runner token without remote_session_v1 received ${JSON.stringify(oldItems)}.`,
    pending?.status === "pending" && !oldItems.some((item) => item.kind === "remote_session_create"),
  );

  // Phase E: only one runner claim wins, and its assignment contains the requested input.
  const capableWork = await eventually(
    async () => runnerRequest(runnerToken, "/v1/automation-runner/work"),
    {
      within: 30_000,
      intervalMs: 500,
      label: "capable runner discovers remote session command",
      until: (result) => isRecord(result.body)
        && Array.isArray(result.body.items)
        && result.body.items.filter(isRecord).some((item) => (
          item.kind === "remote_session_create" && item.commandId === commandId
        )),
    },
  );
  const capableItems = isRecord(capableWork.body) && Array.isArray(capableWork.body.items)
    ? capableWork.body.items.filter(isRecord)
    : [];
  expect(capableItems).toContainEqual({ kind: "remote_session_create", commandId });

  const claim = await runnerRequest(runnerToken, `/v1/remote-session-commands/${commandId}/claim`, { method: "POST" });
  const assignment = isRecord(claim.body) && isRecord(claim.body.assignment) ? claim.body.assignment : {};
  expect(claim.status).toBe(200);
  expect(assignment).toMatchObject({
    commandId,
    kind: "remote_session_create",
    title: "Desktop command",
    prompt: "Open the repo",
    model: null,
  });
  const incompleteDelivery = await runnerRequest(
    runnerToken,
    `/v1/remote-session-commands/${commandId}/complete`,
    { method: "POST", body: { status: "delivered" } },
  );
  expect(incompleteDelivery.status).toBe(400);
  const contradictoryFailure = await runnerRequest(
    runnerToken,
    `/v1/remote-session-commands/${commandId}/complete`,
    {
      method: "POST",
      body: {
        status: "failed",
        sessionId: "ses_must_not_exist",
        workspaceId: "ws_must_not_exist",
        error: { code: "execution_failed", message: "contradictory receipt" },
      },
    },
  );
  expect(contradictoryFailure.status).toBe(400);
  const duplicateClaim = await runnerRequest(
    runnerToken,
    `/v1/remote-session-commands/${commandId}/claim`,
    { method: "POST" },
  );
  expect(duplicateClaim.status).toBe(409);
  expect(duplicateClaim.body).toEqual({ error: "command_claim_conflict" });
  evidence.recordAssertionEvidence(
    "Desktop command claiming is compare-and-set",
    `The first claim returned the requested assignment; incomplete/contradictory completions returned HTTP ${incompleteDelivery.status}/${contradictoryFailure.status}; the second claim returned HTTP ${duplicateClaim.status} ${duplicateClaim.text}.`,
    claim.status === 200 && incompleteDelivery.status === 400
      && contradictoryFailure.status === 400 && duplicateClaim.status === 409,
  );

  // Phase F: completion becomes owner-readable through the command id.
  const complete = await runnerRequest(
    runnerToken,
    `/v1/remote-session-commands/${commandId}/complete`,
    {
      method: "POST",
      body: {
        status: "delivered",
        sessionId: "ses_eval_fake",
        workspaceId: "ws_eval_fake",
        resultSummary: "created",
      },
    },
  );
  expect(complete.status).toBe(200);
  expect(complete.body).toEqual({
    command: {
      id: commandId,
      status: "delivered",
      sessionId: "ses_eval_fake",
      workspaceId: "ws_eval_fake",
    },
  });
  const delivered = await callTool("execute_capability", {
    name: "remote-session:read",
    body: { commandId },
  });
  expect(delivered.isError).toBe(false);
  expect(delivered.payload).toMatchObject({
    commandId,
    target: "desktop",
    state: "delivered",
    sessionId: "ses_eval_fake",
    workspaceId: "ws_eval_fake",
    resultSummary: "created",
    error: null,
  });
  const deliveredRows = await queryDenDatabase(
    databaseUrl,
    "SELECT status, session_id, workspace_id, result_summary FROM remote_session_command WHERE id = ?",
    [commandId],
  );
  expect(deliveredRows.find(isRecord)).toMatchObject({
    status: "delivered",
    session_id: "ses_eval_fake",
    workspace_id: "ws_eval_fake",
    result_summary: "created",
  });
  evidence.recordAssertionEvidence(
    "Runner completion is durable and readable through the gateway",
    `Completion persisted delivered for ${commandId}; remote-session:read returned session ses_eval_fake and workspace ws_eval_fake.`,
    delivered.payload.state === "delivered" && delivered.payload.sessionId === "ses_eval_fake",
  );

  const unknown = await callTool("execute_capability", {
    name: "remote-session:read",
    body: { commandId: denId("rsc") },
  });
  expect(unknown.isError).toBe(true);
  expect(unknown.payload).toEqual({ error: "unknown_command" });
  const malformed = await callTool("execute_capability", {
    name: "remote-session:read",
    body: { commandId: "not-a-command-id" },
  });
  expect(malformed.isError).toBe(true);
  expect(malformed.payload).toEqual({ error: "unknown_command" });
  evidence.recordAssertionEvidence(
    "Unknown and malformed command ids do not disclose another result",
    `Reading a different valid rsc id returned ${unknown.text}; a malformed id returned ${malformed.text} instead of an internal error.`,
    unknown.isError && unknown.payload.error === "unknown_command"
      && malformed.isError && malformed.payload.error === "unknown_command",
  );
});
