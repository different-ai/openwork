import { mkdir } from "node:fs/promises";
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
import { expect } from "vitest";
import { createDesktopAutomationRunner } from "../../apps/desktop/electron/automation-runner.mjs";
import { bootCloudModelInfra } from "../../worlds/cloud-model-infra.ts";
import { bootRemoteSession } from "../../worlds/remote-session.ts";

const WORLD_WORKSPACE = "/tmp/openwork-remote-session-world";
const REQUEST_TIMEOUT_MS = 30_000;
const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
  placement: "local",
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `remote desktop runner delivery skipped — needs: ${missingRequirements.join(", ")}`
  : "a capable real desktop runner delivers an MCP command into a native local session";

interface McpToolResult {
  isError: boolean;
  payload: Record<string, unknown>;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function orgHeaders(session: DenSession, orgId: string): Record<string, string> {
  return { ...auth(session), "x-openwork-org-id": orgId };
}

function parseMcpToolResult(result: unknown): McpToolResult {
  if (!isRecord(result)) throw new Error(`MCP tools/call returned a non-object result: ${JSON.stringify(result)}`);
  const content = Array.isArray(result.content) ? result.content.filter(isRecord) : [];
  const text = content
    .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
    .filter((entry) => entry.length > 0)
    .join("\n");
  const parsed: unknown = JSON.parse(text || "{}");
  return { isError: result.isError === true, payload: isRecord(parsed) ? parsed : {}, text };
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 15 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using stack = new AsyncDisposableStack();
  const world = await bootCloudModelInfra(stack, place, {
    daytonaApiUrl: "http://127.0.0.1:9/daytona-guard",
  });
  const admin = world.admin;
  const orgId = world.org.id;
  const databaseUrl = world.den.database?.url;
  if (!databaseUrl) throw new Error("The remote-session runner world did not expose its database.");

  await mkdir(WORLD_WORKSPACE, { recursive: true });
  const workerWorldName = `remote-session-runner-worker-${process.pid}`;
  const worker = await bootRemoteSession(stack, {
    name: workerWorldName,
    workspace: WORLD_WORKSPACE,
    replace: true,
  });
  expect(worker.reused).toBe(false);
  const manifest = worker.manifest;
  const localHeaders = {
    Accept: "application/json",
    Authorization: `Bearer ${manifest.token}`,
  };
  await eventually(
    async () => (await fetch(manifest.healthUrl).catch(() => null))?.ok === true,
    { within: 90_000, intervalMs: 1_000, label: "desktop openwork-server healthy" },
  );
  await eventually(
    async () => (await fetch(`${manifest.openworkUrl}/opencode/config`, {
      headers: localHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null))?.ok === true,
    { within: 180_000, intervalMs: 2_000, label: "desktop managed OpenCode engine attached" },
  );

  const runnerId = `eval-runner-${process.pid}-${Date.now().toString(36)}`;
  const registration = await denFetch(admin, "/v1/automation-runners/token", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({
      runnerId,
      protocolVersion: 1,
      supportedExecutionTargets: ["desktop"],
      capabilities: ["remote_session_v1"],
      appVersion: "0.0.0-eval",
      platform: "darwin",
      concurrency: 1,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const runnerToken = isRecord(registration.body) && typeof registration.body.token === "string"
    ? registration.body.token
    : "";
  expect(registration.response.ok, registration.text.slice(0, 500)).toBe(true);
  expect(runnerToken.length).toBeGreaterThan(0);
  const runnerRows = await queryDenDatabase(
    databaseUrl,
    "SELECT capabilities FROM automation_runner WHERE id = ?",
    [runnerId],
  );
  expect(JSON.stringify(runnerRows)).toContain("remote_session_v1");

  const runnerLogs: string[] = [];
  const runner = createDesktopAutomationRunner({
    getLocalRuntime: async () => ({ baseUrl: manifest.openworkUrl, token: manifest.token }),
    fetchImpl: fetch,
    log: (message: string) => runnerLogs.push(message),
  });
  stack.defer(() => runner.stop());
  runner.configure({ baseUrl: world.den.ref.apiUrl, token: runnerToken, runnerId });

  const mcpTokenResult = await denFetch(admin, "/v1/mcp/token", {
    method: "POST",
    headers: orgHeaders(admin, orgId),
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const mcpToken = isRecord(mcpTokenResult.body) && typeof mcpTokenResult.body.token === "string"
    ? mcpTokenResult.body.token
    : "";
  expect(mcpTokenResult.response.ok, mcpTokenResult.text.slice(0, 500)).toBe(true);
  expect(mcpToken.length).toBeGreaterThan(0);
  let requestId = 0;
  const callCapability = async (name: "remote-session:create" | "remote-session:read", body: Record<string, unknown>) => {
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
        params: { name: "execute_capability", arguments: { name, body } },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`MCP tools/call failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
    const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`MCP tools/call returned no SSE data frame: ${raw.slice(0, 500)}`);
    const frame: unknown = JSON.parse(dataLine.slice(5));
    if (!isRecord(frame) || frame.error) throw new Error(`MCP tools/call failed: ${raw.slice(0, 500)}`);
    return parseMcpToolResult(frame.result);
  };

  const sessionTitle = `Desktop delivery ${Date.now().toString(36)}`;
  const queued = await callCapability("remote-session:create", { target: "desktop", title: sessionTitle });
  const commandId = typeof queued.payload.commandId === "string" ? queued.payload.commandId : "";
  expect(queued.isError, queued.text).toBe(false);
  expect(queued.payload.state).toBe("queued");
  expect(commandId).toMatch(/^rsc_/);
  expect(runner.wake()).toEqual({ polled: true });
  evidence.recordAssertionEvidence(
    "Capability-aware desktop presence accepts the command",
    `Runner ${runnerId} persisted remote_session_v1 and remote-session:create queued ${commandId}.`,
    runnerToken.length > 0 && queued.payload.state === "queued" && commandId.startsWith("rsc_"),
  );

  const delivered = await eventually(
    () => callCapability("remote-session:read", { commandId }),
    {
      within: 120_000,
      intervalMs: 500,
      label: `desktop runner delivers command; logs=${runnerLogs.join(" | ")}`,
      until: (result) => result.isError === false && result.payload.state === "delivered",
    },
  );
  const sessionId = typeof delivered.payload.sessionId === "string" ? delivered.payload.sessionId : "";
  const workspaceId = typeof delivered.payload.workspaceId === "string" ? delivered.payload.workspaceId : "";
  expect(sessionId.length).toBeGreaterThan(0);
  expect(workspaceId.length).toBeGreaterThan(0);
  expect(delivered.payload.state).not.toBe("failed");
  expect(delivered.payload.state).not.toBe("expired");
  const commandRows = await queryDenDatabase(
    databaseUrl,
    "SELECT status, claimed_by_runner_id, session_id, workspace_id FROM remote_session_command WHERE id = ?",
    [commandId],
  );
  expect(commandRows.find(isRecord)).toMatchObject({
    status: "delivered",
    claimed_by_runner_id: runnerId,
    session_id: sessionId,
    workspace_id: workspaceId,
  });
  evidence.recordAssertionEvidence(
    "The actual desktop runner claims and completes the command",
    `The command row names ${runnerId} as claimant and remote-session:read returned delivered with session ${sessionId} in workspace ${workspaceId}.`,
    commandRows.find(isRecord)?.claimed_by_runner_id === runnerId
      && delivered.payload.state === "delivered" && sessionId.length > 0 && workspaceId.length > 0,
  );

  const sessionsResponse = await fetch(
    `${manifest.openworkUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode/session`,
    { headers: localHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  expect(sessionsResponse.ok).toBe(true);
  const sessionsBody: unknown = await sessionsResponse.json();
  const sessions = Array.isArray(sessionsBody)
    ? sessionsBody.filter(isRecord)
    : [];
  const localSession = sessions.find((item) => item.id === sessionId);
  expect(localSession).toMatchObject({ id: sessionId, title: sessionTitle });
  const sessionBase = `${manifest.openworkUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode/session`;
  const encodedSessionId = encodeURIComponent(sessionId);
  const snapshotResponses = await Promise.all([
    fetch(`${sessionBase}/${encodedSessionId}`, { headers: localHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    fetch(`${sessionBase}/${encodedSessionId}/message`, { headers: localHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    fetch(`${sessionBase}/${encodedSessionId}/todo`, { headers: localHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    fetch(`${sessionBase}/status`, { headers: localHeaders, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  ]);
  expect(snapshotResponses.every((response) => response.ok)).toBe(true);
  const [snapshotSession, snapshotMessages, snapshotTodos, snapshotStatuses]: unknown[] = await Promise.all(
    snapshotResponses.map((response) => response.json()),
  );
  const status = isRecord(snapshotStatuses) && isRecord(snapshotStatuses[sessionId])
    ? snapshotStatuses[sessionId]
    : { type: "idle" };
  const snapshot = { session: snapshotSession, messages: snapshotMessages, todos: snapshotTodos, status };
  expect(status.type).toBe("idle");
  expect(Array.isArray(snapshot.messages) ? snapshot.messages : []).toEqual([]);
  evidence.recordAssertionEvidence(
    "The delivery receipt names a genuine web-visible native session",
    `The real source-first server returned receipt session ${sessionId} with title ${sessionTitle}; its snapshot was idle with no messages, proving omission of prompt/model created but did not start execution.`,
    localSession?.id === sessionId && localSession.title === sessionTitle
      && status.type === "idle" && Array.isArray(snapshot.messages) && snapshot.messages.length === 0,
  );
});
