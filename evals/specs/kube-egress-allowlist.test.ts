import { spawn, spawnSync } from "node:child_process";
import { expect } from "vitest";
import {
  createOrgConnection,
  deleteConnection,
  deleteConnectionsNamed,
  denFetch,
  readUsableConnection,
  signIn,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { startMockMcp } from "@openwork/labs";
import type { MockMcpHandle, MockAuthorizeRequest } from "@openwork/labs";
import { eventually, sleep, test } from "@openwork/testkit";

const KUBE_CONTEXT = "kind-openwork-kube-lab";
const apiUrl = process.env.OPENWORK_EVAL_DEN_API_URL?.trim().replace(/\/+$/, "") ?? "";
const webUrl = process.env.OPENWORK_EVAL_DEN_WEB_URL?.trim().replace(/\/+$/, "") ?? "";
const allowedHostIp = process.env.OPENWORK_EVAL_KUBE_ALLOWED_HOST_IP?.trim() ?? "";

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

function envPort(name: string, defaultPort: number): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return defaultPort;
  if (!/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

const allowedPort = envPort("OPENWORK_EVAL_KUBE_ALLOWED_MOCK_PORT", 4791);
const deniedPort = envPort("OPENWORK_EVAL_KUBE_DENIED_MOCK_PORT", 4792);

function precondition(): string | null {
  if (!apiUrl) return "set OPENWORK_EVAL_DEN_API_URL";
  if (!webUrl) return "set OPENWORK_EVAL_DEN_WEB_URL";
  if (process.env.OPENWORK_EVAL_KUBE_EGRESS_TEST?.trim() !== "1") return "set OPENWORK_EVAL_KUBE_EGRESS_TEST=1";
  if (!allowedHostIp) return "set OPENWORK_EVAL_KUBE_ALLOWED_HOST_IP";
  if (allowedPort === null) return "OPENWORK_EVAL_KUBE_ALLOWED_MOCK_PORT must be a valid port";
  if (deniedPort === null) return "OPENWORK_EVAL_KUBE_DENIED_MOCK_PORT must be a valid port";
  const probe = spawnSync("kubectl", ["--context", KUBE_CONTEXT, "get", "nodes"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (probe.error) return `kubectl probe failed: ${probe.error.message}`;
  if (probe.status !== 0) {
    const detail = (probe.stderr || probe.stdout).trim();
    return `kubectl --context ${KUBE_CONTEXT} get nodes failed${detail ? `: ${detail}` : ""}`;
  }
  return null;
}

const skipReason = precondition();
const title = skipReason
  ? `kube egress allowlist skipped: ${skipReason}`
  : "kind Den reaches only its allowlisted host endpoint while core services stay healthy";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(command: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, code: timedOut ? 124 : code ?? 1 });
    });
  });
}

async function podFetch(hostIp: string, port: number): Promise<CommandResult> {
  const script = `fetch('http://${hostIp}:${port}/health',{signal:AbortSignal.timeout(5000)}).then(r=>{console.log(r.status);process.exit(r.ok?0:1)}).catch(e=>{console.error(e?.cause?.code??e?.name);process.exit(1)})`;
  return run("kubectl", [
    "--context",
    KUBE_CONTEXT,
    "exec",
    "deploy/openwork-ee-den-api",
    "--",
    "node",
    "-e",
    script,
  ], 15_000);
}

async function startUnauthenticatedMock(port: number): Promise<MockMcpHandle> {
  const previous = process.env.MOCK_ALLOW_UNAUTHENTICATED_MCP;
  process.env.MOCK_ALLOW_UNAUTHENTICATED_MCP = "1";
  try {
    return await startMockMcp({ port });
  } finally {
    if (previous === undefined) delete process.env.MOCK_ALLOW_UNAUTHENTICATED_MCP;
    else process.env.MOCK_ALLOW_UNAUTHENTICATED_MCP = previous;
  }
}

function requestsSince(requests: MockAuthorizeRequest[], sinceIso: string): MockAuthorizeRequest[] {
  return requests.filter((request) => request.at >= sinceIso && request.path !== "/requests");
}

async function manageableConnectionId(admin: DenSession, name: string): Promise<string | null> {
  const result = await denFetch(admin, "/v1/mcp-connections?scope=manageable", {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  if (!result.response.ok || !isRecord(result.body) || !Array.isArray(result.body.connections)) return null;
  const connection = result.body.connections.find((entry) => isRecord(entry) && entry.name === name);
  return isRecord(connection) && typeof connection.id === "string" ? connection.id : null;
}

async function neverConnected(admin: DenSession, connectionId: string, withinMs: number) {
  const deadline = Date.now() + withinMs;
  let current = await readUsableConnection(admin, connectionId);
  while (Date.now() < deadline) {
    expect(current?.connectedForMe).not.toBe(true);
    await sleep(Math.min(1_000, deadline - Date.now()));
    current = await readUsableConnection(admin, connectionId);
  }
  return current;
}

test.skipIf(skipReason !== null)(title, async ({ evidence }) => {
  if (allowedPort === null || deniedPort === null) throw new Error("Mock ports were invalid after the precondition passed.");
  const allowedMock = await startUnauthenticatedMock(allowedPort);
  let deniedMock: MockMcpHandle | null = null;
  let admin: DenSession | null = null;
  let allowedConnectionId: string | null = null;
  let deniedConnectionId: string | null = null;
  const deniedName = `Kube denied MCP ${Date.now()}`;

  try {
    deniedMock = await startUnauthenticatedMock(deniedPort);
    const den = { apiUrl, webUrl };
    const activeAdmin = await signIn(den, {
      email: process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test",
      password: process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!",
    });
    admin = activeAdmin;
    await deleteConnectionsNamed(activeAdmin, "Kube allowed MCP ");
    await deleteConnectionsNamed(activeAdmin, "Kube denied MCP ");

    const allowedSinceIso = new Date().toISOString();
    const allowedConnection = await createOrgConnection(activeAdmin, {
      name: `Kube allowed MCP ${Date.now()}`,
      url: `http://${allowedHostIp}:${allowedPort}/mcp`,
      authType: "none",
      credentialMode: "shared",
      access: { orgWide: true },
    });
    allowedConnectionId = allowedConnection.id;
    const allowedState = await eventually(
      () => readUsableConnection(activeAdmin, allowedConnection.id),
      {
        within: 60_000,
        intervalMs: 1_000,
        label: "allowlisted MCP connection to become usable",
        until: (connection) => connection?.connectedForMe === true,
      },
    );
    expect(allowedState?.connectedForMe).toBe(true);
    const allowedDiscoveryRequests = requestsSince(await allowedMock.requests(), allowedSinceIso);
    expect(allowedDiscoveryRequests.length).toBeGreaterThan(0);
    expect(allowedDiscoveryRequests.some((request) => request.path === "/mcp")).toBe(true);
    evidence.recordAssertionEvidence(
      "Den reached the allowlisted MCP server",
      `The host mock recorded ${allowedDiscoveryRequests.length} discovery requests from the in-cluster connection validation.`,
      allowedDiscoveryRequests.length > 0,
    );

    const hostLiveness = await fetch(`${deniedMock.url}/health`, { signal: AbortSignal.timeout(5_000) });
    expect(hostLiveness.status).toBe(200);
    await sleep(10);
    const deniedSinceIso = new Date().toISOString();
    const allowedPodFetch = await podFetch(allowedHostIp, allowedPort);
    const deniedPodFetch = await podFetch(allowedHostIp, deniedPort);
    expect(allowedPodFetch.code, `${allowedPodFetch.stderr}\n${allowedPodFetch.stdout}`).toBe(0);
    expect(allowedPodFetch.stdout).toContain("200");
    expect(deniedPodFetch.code, `${deniedPodFetch.stderr}\n${deniedPodFetch.stdout}`).not.toBe(0);
    evidence.recordAssertionEvidence(
      "The pod-level policy allows one host port and denies the other",
      `Allowed pod fetch exit=${allowedPodFetch.code}; denied pod fetch exit=${deniedPodFetch.code}; the denied mock returned HTTP ${hostLiveness.status} to the driver first.`,
      allowedPodFetch.code === 0 && deniedPodFetch.code !== 0 && hostLiveness.status === 200,
    );

    let deniedCreateError = "";
    try {
      const deniedConnection = await createOrgConnection(activeAdmin, {
        name: deniedName,
        url: `http://${allowedHostIp}:${deniedPort}/mcp`,
        authType: "none",
        credentialMode: "shared",
        access: { orgWide: true },
      });
      deniedConnectionId = deniedConnection.id;
    } catch (error) {
      deniedCreateError = errorText(error);
    }
    expect(deniedCreateError).toMatch(/validation|validate|fetch|timeout|timed out|abort/i);
    const activeDeniedConnectionId = deniedConnectionId ?? await eventually(
      () => manageableConnectionId(activeAdmin, deniedName),
      { within: 15_000, intervalMs: 500, label: "failed denied connection record" },
    );
    if (!activeDeniedConnectionId) throw new Error("Denied connection record had no id.");
    deniedConnectionId = activeDeniedConnectionId;
    const deniedState = await neverConnected(activeAdmin, activeDeniedConnectionId, 60_000);
    expect(deniedState).not.toBeNull();
    expect(deniedState?.connectedForMe).toBe(false);
    expect(deniedState?.connectedAt).toBeNull();
    evidence.recordAssertionEvidence(
      "The denied product connection never became usable",
      `Create surfaced ${deniedCreateError}; after 60s the usable-connection API reported connectedForMe=${String(deniedState?.connectedForMe)} and connectedAt=${String(deniedState?.connectedAt)}.`,
      deniedState?.connectedForMe === false && deniedState.connectedAt === null,
    );

    const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    expect(health.status).toBe(200);
    const allowedAfterDeny = await readUsableConnection(activeAdmin, allowedConnection.id);
    expect(allowedAfterDeny?.connectedForMe).toBe(true);
    evidence.recordAssertionEvidence(
      "Core Den health and the allowed connection survive the denied attempt",
      `Den health returned HTTP ${health.status}, and the original connection remained usable.`,
      health.status === 200 && allowedAfterDeny?.connectedForMe === true,
    );

    const deniedLeaks = requestsSince(await deniedMock.requests(), deniedSinceIso);
    expect(deniedLeaks).toEqual([]);
    evidence.recordAssertionEvidence(
      "No denied request leaked out of the cluster",
      `The denied mock recorded ${deniedLeaks.length} non-log requests after the host-side liveness probe.`,
      deniedLeaks.length === 0,
    );
  } finally {
    try {
      if (admin && deniedConnectionId) await deleteConnection(admin, deniedConnectionId);
      if (admin && allowedConnectionId) await deleteConnection(admin, allowedConnectionId);
    } finally {
      if (deniedMock) await deniedMock.stop();
      await allowedMock.stop();
    }
  }
}, 180_000);
