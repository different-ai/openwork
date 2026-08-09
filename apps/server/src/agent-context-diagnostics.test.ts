import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS,
  agentContextDiagnosticsReportSchema,
  type AgentContextDiagnosticsRequest,
} from "@openwork/types/agent-context-diagnostics";

import {
  classifyEngineMcpTransportCause,
  expectedConnectBranch,
  runAgentContextDiagnostics,
} from "./agent-context-diagnostics.js";
import type { InspectAgentDiagnosticsEngine } from "./agent-context-engine-inspection.js";
import type { ConnectSnapshot } from "./connect-state.js";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "./openwork-runtime-config.js";
import { runtimeDbPath } from "./runtime-db.js";
import {
  inspectEngineMcpRegistration,
  registerTrustedOpencodeProcess,
  startServer,
  syncAllWorkspacesRuntimeMcpToEngine,
} from "./server.js";
import {
  writeRuntimeOpencodeConfig,
  type RuntimeOpencodeConfig,
} from "./runtime-opencode-config-store.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

type CatalogFetchCall = {
  url: string;
  method: string | undefined;
  headers: Headers;
  body: Record<string, unknown>;
};

const CLIENT_TOKEN = "owt_agent_context_diagnostics_client";
const HOST_TOKEN = "owt_agent_context_diagnostics_host";
const CLOUD_BEARER = "Bearer CANARY_AUTH_TOKEN";
const CLOUD_ENDPOINT = "http://127.0.0.1:43123/private-prefix/mcp/agent";
const RAW_PROMPT_CANARY = "Hard rule: never copy private memory into repo files";
const DYNAMIC_BEARER_CANARY = "Bearer DYNAMIC_LABEL_TOKEN_CANARY";
const DYNAMIC_SECRET_ASSIGNMENT_CANARY = "client_secret=DYNAMIC_CLIENT_SECRET_CANARY";
const DYNAMIC_URL_CANARY = "https://labels.invalid/mcp?access_token=DYNAMIC_URL_TOKEN_CANARY";
const DYNAMIC_PATH_CANARY = "/Users/diagnostics/private/mcp.json";
const execFileAsync = promisify(execFile);
const nativeFetch = globalThis.fetch;
const roots: string[] = [];
const stops: Array<() => void | Promise<void>> = [];

const emptyObservedRequest: AgentContextDiagnosticsRequest = {
  organizationConnectionsProbe: { status: "observed", code: null, totalCount: 0, truncated: false },
  organizationConnections: [],
};

function cloudConfig(): Record<string, unknown> {
  return {
    type: "remote",
    url: CLOUD_ENDPOINT,
    enabled: true,
    headers: { Authorization: CLOUD_BEARER },
  };
}

function diagnosticRuntimeConfig(): RuntimeOpencodeConfig {
  return {
    default_agent: `openwork ${DYNAMIC_BEARER_CANARY}`,
    plugin: [`audit-label ${DYNAMIC_SECRET_ASSIGNMENT_CANARY}`],
    mcp: {
      "openwork-cloud": cloudConfig(),
      "non-cloud-canary": {
        type: "remote",
        url: "https://non-cloud.invalid/mcp?token=CANARY_QUERY_SECRET",
        enabled: true,
        headers: { "X-Canary-Key": "CANARY_HEADER_SECRET" },
      },
      [`unsafe\r\n\u202eidentifier ${DYNAMIC_BEARER_CANARY} ${DYNAMIC_URL_CANARY} ${DYNAMIC_PATH_CANARY}`]: {
        type: "local",
        command: ["CANARY_LOCAL_COMMAND_SECRET"],
        enabled: true,
      },
    },
  };
}

function openCodeNormalizedPluginSpecs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    const spec = typeof raw === "string"
      ? raw
      : Array.isArray(raw) && typeof raw[0] === "string"
        ? raw[0]
        : null;
    if (spec === null) return [];
    if (spec.startsWith("file://")) return [spec];
    if (isAbsolute(spec) || /^[A-Za-z]:[\\/]/u.test(spec)) return [pathToFileURL(spec).href];
    return [spec];
  });
}

function effectiveEngineInspection(
  runtime: RuntimeOpencodeConfig = diagnosticRuntimeConfig(),
  options?: {
    defaultAgent?: string | null;
    agentName?: string;
    agentMode?: "primary" | "subagent" | "all";
    hidden?: boolean;
    prompt?: string;
    pluginSpecs?: string[];
    decisions?: Partial<Record<"openwork-cloud_search_capabilities" | "openwork-cloud_execute_capability", "allow" | "ask" | "deny">>;
  },
): InspectAgentDiagnosticsEngine {
  const decisions = {
    "openwork-cloud_search_capabilities": "allow" as const,
    "openwork-cloud_execute_capability": "allow" as const,
    ...options?.decisions,
  };
  const canonicalConfig = buildOpenworkRuntimeConfigObjectFromSnapshot(runtime);
  const canonicalAgents = typeof canonicalConfig.agent === "object" && canonicalConfig.agent !== null
    && !Array.isArray(canonicalConfig.agent)
    ? canonicalConfig.agent as Record<string, unknown>
    : {};
  const canonicalAgent = typeof canonicalAgents.openwork === "object" && canonicalAgents.openwork !== null
    && !Array.isArray(canonicalAgents.openwork)
    ? canonicalAgents.openwork as Record<string, unknown>
    : {};
  return async () => ({
    config: {
      default_agent: options?.defaultAgent === null ? undefined : options?.defaultAgent ?? "openwork",
      plugin: options?.pluginSpecs ?? openCodeNormalizedPluginSpecs(canonicalConfig.plugin),
      mcp: canonicalConfig.mcp,
    },
    agents: [{
      name: options?.agentName ?? "openwork",
      mode: options?.agentMode ?? "primary",
      hidden: options?.hidden,
      prompt: options?.prompt ?? String(canonicalAgent.prompt ?? ""),
      permission: Object.entries(decisions).map(([permission, action]) => ({
        permission,
        pattern: "*",
        action,
      })),
      options: {},
    }],
  });
}

async function createRoot(prefix = "openwork-agent-context-diagnostics-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function closeTlsServer(server: tls.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function selfSignedCertificate(): Promise<{ key: string; cert: string }> {
  const root = await createRoot("openwork-agent-context-diagnostics-tls-");
  const keyPath = join(root, "key.pem");
  const certPath = join(root, "cert.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=localhost",
    "-days",
    "1",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ]);
  return {
    key: await readFile(keyPath, "utf8"),
    cert: await readFile(certPath, "utf8"),
  };
}

async function startSelfSignedTlsServer(): Promise<number> {
  const material = await selfSignedCertificate();
  const server = tls.createServer(material, (socket) => socket.end());
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("Expected a TLS test port"));
    });
  });
  stops.push(() => closeTlsServer(server));
  return port;
}

async function createFixture(options?: {
  workspace?: Partial<WorkspaceInfo>;
  withRuntime?: boolean;
  runtime?: RuntimeOpencodeConfig;
}): Promise<{ root: string; workspaceRoot: string; workspace: WorkspaceInfo; config: ServerConfig }> {
  const root = await createRoot();
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });
  const workspace: WorkspaceInfo = {
    id: "ws_agent_diagnostics",
    name: "Agent diagnostics workspace",
    path: workspaceRoot,
    preset: "starter",
    workspaceType: "local",
    baseUrl: "http://127.0.0.1:9",
    ...options?.workspace,
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "state", "server.json"),
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [workspace],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  if (options?.withRuntime !== false) {
    await writeRuntimeOpencodeConfig(config, workspace.id, () => options?.runtime ?? diagnosticRuntimeConfig());
  }
  return { root, workspaceRoot, workspace, config };
}

function catalogFetch(
  toolIds: string[],
  calls: CatalogFetchCall[],
  options?: { release?: Promise<void> },
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = input instanceof Request ? input.url : String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({
      url,
      method: init?.method,
      headers: new Headers(init?.headers),
      body,
    });
    await options?.release;
    if (body.method === "initialize") {
      return new Response(JSON.stringify({
        jsonrpc: "2.0",
        id: body.id,
        result: {
          capabilities: {},
          protocolVersion: "2025-06-18",
          serverInfo: { name: "diagnostics-test", version: "1.0.0" },
        },
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "diagnostics-test-session",
          "Mcp-Protocol-Version": "2025-06-18",
        },
      });
    }
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }
    const payload = {
      jsonrpc: "2.0",
      id: body.id,
      result: { tools: toolIds.map((name) => ({ name })) },
    };
    return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
}

function checkById(
  report: ReturnType<typeof agentContextDiagnosticsReportSchema.parse>,
  id: (typeof AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS)[number],
) {
  const check = report.checks.find((candidate) => candidate.id === id);
  if (!check) throw new Error(`Missing diagnostics check: ${id}`);
  return check;
}

function startRecordingServer() {
  const requests: Array<{ method: string; pathname: string; body: unknown }> = [];
  const canonicalConfig = buildOpenworkRuntimeConfigObjectFromSnapshot({
    ...diagnosticRuntimeConfig(),
    default_agent: "openwork",
  });
  const canonicalAgents = canonicalConfig.agent as Record<string, Record<string, unknown>>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.json().catch(() => null) : null;
      requests.push({
        method: request.method,
        pathname: url.pathname,
        body,
      });
      if (request.method === "GET" && url.pathname === "/config") {
        return Response.json({
          default_agent: "openwork",
          plugin: openCodeNormalizedPluginSpecs(canonicalConfig.plugin),
          mcp: canonicalConfig.mcp,
        });
      }
      if (request.method === "GET" && url.pathname === "/agent") {
        return Response.json([{
          name: "openwork",
          mode: "primary",
          prompt: canonicalAgents.openwork?.prompt,
          permission: [
            { permission: "openwork-cloud_search_capabilities", pattern: "*", action: "allow" },
            { permission: "openwork-cloud_execute_capability", pattern: "*", action: "allow" },
          ],
          options: {},
        }]);
      }
      if (request.method === "POST" && url.pathname === "/mcp") {
        const name = typeof body === "object" && body !== null && !Array.isArray(body)
          && typeof (body as { name?: unknown }).name === "string"
          ? (body as { name: string }).name
          : "";
        return Response.json(name ? { [name]: { status: "connected" } } : {});
      }
      return Response.json({});
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { requests, baseUrl: `http://127.0.0.1:${server.port}` };
}

async function startOpenwork(config: ServerConfig) {
  const baseUrl = config.workspaces[0]?.baseUrl ?? config.opencodeBaseUrl;
  if (baseUrl) {
    registerTrustedOpencodeProcess(config, {
      baseUrl,
      identity: `diagnostics-test-managed-process:${baseUrl}`,
      isAlive: () => true,
    });
  }
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

async function openSlowDiagnosticsRequest(base: string, workspaceId: string): Promise<Socket> {
  const url = new URL(base);
  const socket = createConnection({ host: url.hostname, port: Number(url.port) });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write([
    `POST /workspace/${encodeURIComponent(workspaceId)}/diagnostics/agent-context HTTP/1.1`,
    `Host: ${url.host}`,
    `Authorization: Bearer ${CLIENT_TOKEN}`,
    "Content-Type: application/json",
    "Content-Length: 1024",
    "Connection: keep-alive",
    "",
    "{",
  ].join("\r\n"));
  return socket;
}

async function readRawSocketUntilServerResponse(
  socket: Socket,
  timeoutMs: number,
): Promise<{ raw: string; elapsedMs: number; socketClosed: boolean }> {
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(
        `Server did not answer the incomplete diagnostics request within ${timeoutMs}ms; received ${JSON.stringify(raw)}`,
      ));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("data", onData);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      raw += chunk.toString("utf8");
      if (raw.includes("\r\n0\r\n\r\n")) finish(false);
    };
    const onClose = () => {
      finish(true);
    };
    const finish = (socketClosed: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ raw, elapsedMs: performance.now() - startedAt, socketClosed });
    };
    const onError = () => {
      // Cancellation may surface as ECONNRESET before close. The close event
      // remains the proof that the server terminated the socket.
    };
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.on("error", onError);
  });
}

function clientHeaders(token = CLIENT_TOKEN) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function hostHeaders() {
  return { "x-openwork-host-token": HOST_TOKEN, "Content-Type": "application/json" };
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const key = relative(root, path);
      const metadata = await lstat(path);
      if (entry.isDirectory()) {
        snapshot[key] = `directory:${metadata.mode}:${metadata.mtimeMs}`;
        await walk(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        snapshot[key] = `file:${metadata.mode}:${metadata.size}:${metadata.mtimeMs}:${bytes.toString("base64")}`;
      } else if (entry.isSymbolicLink()) {
        snapshot[key] = `symlink:${metadata.mode}:${metadata.mtimeMs}`;
      } else {
        snapshot[key] = `other:${metadata.mode}:${metadata.size}:${metadata.mtimeMs}`;
      }
    }
  };
  await walk(root);
  return snapshot;
}

beforeEach(() => {
  globalThis.fetch = nativeFetch;
});

afterEach(async () => {
  globalThis.fetch = nativeFetch;
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("classifyEngineMcpTransportCause", () => {
  const cases: Array<[string | null, ReturnType<typeof classifyEngineMcpTransportCause>]> = [
    [null, null],
    ["unable to verify the first certificate", "tls_incomplete_chain"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls_incomplete_chain"],
    ["unable to get local issuer certificate", "tls_untrusted_ca"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls_untrusted_ca"],
    ["Hostname/IP does not match certificate altname", "tls_hostname_mismatch"],
    ["CERT_HAS_EXPIRED", "tls_expired"],
    ["TLS handshake failed", "tls_error"],
    ["getaddrinfo ENOTFOUND den.internal", "dns_error"],
    ["connect ECONNREFUSED 127.0.0.1:443", "connection_refused"],
    ["ConnectionRefused", "connection_refused"],
    ["socket hang up", "connection_reset"],
    ["connection reset by peer", "connection_reset"],
    ["request timed out", "timeout"],
    ["HTTP status 502", "http_error"],
    ["403 forbidden", "auth_error"],
    ["something else", "unknown"],
  ];

  test.each(cases)("classifies %p", (message, expected) => {
    expect(classifyEngineMcpTransportCause(message)).toBe(expected);
  });
});

describe("agent context diagnostics analyzer", () => {
  test("mirrors Connect's health-first steering priority", () => {
    const snapshot = {
      status: "available",
      connectEnabled: false,
      connectCatalogEnabled: false,
      cloudMcpPresent: false,
      cloudHealth: {
        usable: true,
        usableByCurrentModel: true,
      } as ConnectSnapshot["cloudHealth"],
      workspace: { resolution: "resolved", id: "ws_test", directory: "/tmp/ws_test" },
      googleWorkspace: { legacyConfigured: true },
    } satisfies ConnectSnapshot;

    expect(expectedConnectBranch(snapshot)).toBe("cloud-active");
    expect(expectedConnectBranch({ ...snapshot, cloudHealth: null })).toBe("extensions-only");
    expect(expectedConnectBranch({
      ...snapshot,
      workspace: { ...snapshot.workspace, resolution: "unknown" },
    })).toBe("cloud-disconnected");
  });

  test("reduces URL plugin specs to safe path labels and fails closed for malformed or opaque URLs", async () => {
    const signedUrl = "https://URL_USER_CANARY:URL_PASSWORD_CANARY@plugins.example.test/releases/signed-plugin.js?X-Amz-Signature=SIGNED_QUERY_CANARY#SIGNED_FRAGMENT_CANARY";
    const malformedUrl = "https://[malformed.example.test/plugin.js?token=MALFORMED_QUERY_CANARY";
    const opaqueUrl = "data:text/javascript,OPAQUE_PLUGIN_CANARY";
    const opaqueUrlWithoutSlash = "mailto:OPAQUE_NO_SLASH_CANARY";
    const fixture = await createFixture({
      runtime: {
        default_agent: "openwork",
        plugin: [signedUrl, malformedUrl, opaqueUrl, opaqueUrlWithoutSlash],
        mcp: {},
      },
    });

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "not-recorded",
    }));

    expect(report.agent.pluginLabels).toContain("signed-plugin");
    expect(report.agent.pluginLabels).toContain("[redacted-sensitive-label]");
    const serialized = JSON.stringify(report);
    for (const canary of [
      "URL_USER_CANARY",
      "URL_PASSWORD_CANARY",
      "SIGNED_QUERY_CANARY",
      "SIGNED_FRAGMENT_CANARY",
      "MALFORMED_QUERY_CANARY",
      "OPAQUE_PLUGIN_CANARY",
      "OPAQUE_NO_SLASH_CANARY",
    ]) {
      expect(serialized).not.toContain(canary);
    }
  });

  test("returns effective engine evidence, exact cloud tools, and no non-cloud egress", async () => {
    const engine = startRecordingServer();
    const fixture = await createFixture({
      workspace: {
        baseUrl: engine.baseUrl,
        name: `Agent diagnostics redaction-label ${DYNAMIC_BEARER_CANARY} ${DYNAMIC_URL_CANARY} ${DYNAMIC_PATH_CANARY}`,
      },
    });
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    }));

    expect(report.checks.map((check) => check.id)).toEqual([...AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS]);
    expect(report.overall).toBe("warning");
    expect(report.firstFailedCheck).toBeNull();
    expect(report.observedCloudToolIds).toEqual(["search_capabilities", "execute_capability"]);
    expect(report.mcps.find((mcp) => mcp.name === "openwork-cloud")?.path).toBe("/private-prefix/mcp/agent");
    expect(report.workspace.name).toBe("[redacted-sensitive-label]");
    expect(report.agent.evidenceSource).toBe("effective-engine");
    expect(report.agent.defaultAgent).toBe("openwork");
    expect(report.agent.pluginLabels).toContain("[redacted-sensitive-label]");
    expect(report.agent.configuredOpenworkAgent.connectToolPermissions).toEqual({
      searchCapabilities: "allowed",
      executeCapability: "allowed",
      deniedRelevantToolCount: 0,
    });
    expect(checkById(report, "agent-connect-tool-permissions")).toMatchObject({
      status: "passed",
      code: "required_connect_tool_ids_not_denied_by_effective_policy",
      details: {
        effectivePolicyStatus: "available",
        effectivePolicySnapshotApplied: true,
      },
    });
    expect(report.mcps).toContainEqual(expect.objectContaining({
      name: "[redacted-sensitive-label]",
    }));
    expect(report.mcps).toContainEqual(expect.objectContaining({
      name: "openwork-cloud",
      source: "config.remote",
      origin: "http://127.0.0.1:43123",
      path: "/private-prefix/mcp/agent",
      syncStatus: "connected",
    }));
    expect(report.mcps).toContainEqual(expect.objectContaining({
      name: "openwork-cloud",
      source: "engine.config",
      syncStatus: "not-applicable",
    }));
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      evidenceKind: "observed",
      code: "cloud_catalog_exact_match",
    });
    expect(checkById(report, "engine-plugin-tools")).toMatchObject({
      status: "warning",
      code: "per_request_connect_context_not_observed",
    });
    expect(checkById(report, "cloud-endpoint-differential")).toMatchObject({
      status: "passed",
      evidenceKind: "derived",
      code: "runtime_and_engine_connected",
    });
    expect(checkById(report, "cloud-endpoint-transport")).toMatchObject({
      status: "skipped",
      code: "transport_probe_not_required",
      details: {
        endpointOrigin: "http://127.0.0.1:43123",
        skipReason: "perform_probe_false",
        verifiedHandshake: "not-performed",
      },
    });
    expect(report.safety).toMatchObject({
      diagnosticsWorkspaceRuntimeConfigurationReadOnly: true,
      cloudCatalogToolsListPerformed: true,
      credentialFreeTransportProbePerformed: false,
      cloudSessionCleanupRequested: true,
      directNonCloudMcpFetchPerformed: false,
      directMcpToolCallPerformed: false,
      directProviderOperationPerformed: false,
      directConfigurationMutationPerformed: false,
      directEphemeralCredentialMintPerformed: false,
      engineApiReadPerformed: true,
      engineBootstrapMayHaveRun: true,
      engineBootstrapSideEffectsInspected: false,
    });
    expect(agentContextDiagnosticsReportSchema.safeParse({
      ...report,
      mcps: report.mcps.filter((mcp) =>
        !(mcp.source === "config.remote" && mcp.name === "openwork-cloud"),
      ),
    }).success).toBe(false);
    expect(fetchCalls).toHaveLength(4);
    expect(fetchCalls.map((call) => call.url)).toEqual([CLOUD_ENDPOINT, CLOUD_ENDPOINT, CLOUD_ENDPOINT, CLOUD_ENDPOINT]);
    expect(fetchCalls.map((call) => call.method)).toEqual(["POST", "POST", "POST", "DELETE"]);
    expect(fetchCalls.slice(0, 3).map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(fetchCalls[2]?.body).toMatchObject({ jsonrpc: "2.0", method: "tools/list", params: {} });
    expect(fetchCalls[0]?.headers.get("accept")).toBe("application/json, text/event-stream");
    expect(fetchCalls[0]?.headers.has("mcp-session-id")).toBe(false);
    expect(fetchCalls[2]?.headers.get("mcp-session-id")).toBe("diagnostics-test-session");
    expect(fetchCalls[3]?.headers.get("mcp-session-id")).toBe("diagnostics-test-session");
    expect(engine.requests).toEqual([]);

    const serialized = JSON.stringify(report);
    for (const canary of [
      "CANARY_AUTH_TOKEN",
      "CANARY_QUERY_SECRET",
      "CANARY_HEADER_SECRET",
      "CANARY_LOCAL_COMMAND_SECRET",
      "DYNAMIC_LABEL_TOKEN_CANARY",
      "DYNAMIC_CLIENT_SECRET_CANARY",
      "DYNAMIC_URL_TOKEN_CANARY",
      DYNAMIC_PATH_CANARY,
      fixture.workspaceRoot,
      RAW_PROMPT_CANARY,
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u);
  });

  test("probes the endpoint without an effective engine inspection while tool policy stays its own dimension", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];

    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: { fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls) },
    });

    expect(report.agent.configuredOpenworkAgent.connectToolPermissions).toEqual({
      searchCapabilities: "unspecified",
      executeCapability: "unspecified",
      deniedRelevantToolCount: null,
    });
    expect(checkById(report, "agent-connect-tool-permissions")).toMatchObject({
      status: "warning",
      evidenceKind: "unavailable",
      code: "effective_connect_tool_policy_unavailable",
      owner: "opencode-engine",
      details: {
        effectivePolicySnapshotApplied: false,
        policyUnavailableReasons: expect.arrayContaining([
          "effective_engine_snapshot_unavailable",
        ]),
      },
    });
    // An unavailable tool policy is a separate diagnostic dimension; it must
    // never be reported as endpoint unavailability.
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      evidenceKind: "observed",
      code: "cloud_catalog_exact_match",
      details: { requestPerformed: true },
    });
    expect(report.safety.cloudCatalogToolsListPerformed).toBe(true);
    expect(fetchCalls).toHaveLength(4);
  });

  test("retains the probed runtime cloud MCP when the combined inventory is truncated", async () => {
    const runtime = diagnosticRuntimeConfig();
    const manyMcps: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < 205; index += 1) {
      manyMcps[`bounded-${String(index).padStart(3, "0")}`] = {
        type: "remote",
        url: `https://bounded-${index}.invalid/mcp`,
      };
    }
    manyMcps["openwork-cloud"] = cloudConfig();
    runtime.mcp = manyMcps;
    const fixture = await createFixture({ runtime });
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    }));

    expect(report.mcps).toHaveLength(200);
    expect(report.mcps).toContainEqual(expect.objectContaining({
      name: "openwork-cloud",
      source: "config.remote",
      path: "/private-prefix/mcp/agent",
      syncStatus: "connected",
    }));
    expect(checkById(report, "mcp-inventory")).toMatchObject({
      status: "warning",
      code: "mcp_inventory_truncated",
      details: { reportedMcpEntryCount: 200 },
    });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
    });
    expect(fetchCalls).toHaveLength(4);
  });

  test("keeps a whole-resource deny in the policy dimension while the endpoint probe still runs", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];

    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(diagnosticRuntimeConfig(), {
          decisions: { "openwork-cloud_search_capabilities": "deny" },
        }),
      },
    });

    expect(report.agent.evidenceSource).toBe("effective-engine");
    expect(report.agent.configuredOpenworkAgent.connectToolPermissions).toEqual({
      searchCapabilities: "denied",
      executeCapability: "allowed",
      deniedRelevantToolCount: 1,
    });
    expect(checkById(report, "agent-connect-tool-permissions")).toMatchObject({
      status: "failed",
      evidenceKind: "observed",
      code: "required_connect_tools_denied_by_effective_policy",
    });
    // The policy deny stays a policy failure; the endpoint itself is probed
    // and reported on its own dimension.
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
      details: { requestPerformed: true },
    });
    expect(report.mcps.find(
      (mcp) => mcp.name === "openwork-cloud" && mcp.source === "engine.config",
    )).toMatchObject({
      source: "engine.config",
      disabledByTools: true,
    });
    expect(fetchCalls).toHaveLength(4);
  });

  test("reports an effective ask rule as approval required while keeping the visible tool probe eligible", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(diagnosticRuntimeConfig(), {
          decisions: { "openwork-cloud_search_capabilities": "ask" },
        }),
      },
    }));

    expect(report.agent.configuredOpenworkAgent.connectToolPermissions).toEqual({
      searchCapabilities: "approval-required",
      executeCapability: "allowed",
      deniedRelevantToolCount: 0,
    });
    expect(checkById(report, "agent-connect-tool-permissions")).toMatchObject({
      status: "passed",
      evidenceKind: "observed",
      code: "required_connect_tool_ids_not_denied_by_effective_policy",
      details: {
        searchCapabilities: "approval-required",
        executeCapability: "allowed",
      },
    });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
      details: { requestPerformed: true },
    });
    expect(fetchCalls).toHaveLength(4);
  });

  test("distinguishes a missing Connect state default from a corrupt state file", async () => {
    const fixture = await createFixture();
    const run = () => runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected" as const,
    });

    const firstRun = await run();
    expect(firstRun.connect).toMatchObject({ stateStatus: "missing", connectEnabled: false });
    expect(checkById(firstRun, "connect-steering-scope")).toMatchObject({
      status: "passed",
      details: { connectStateStatus: "missing", connectEnabled: false },
    });

    await writeFile(join(fixture.root, "state", "connect-state.json"), "{not valid json", "utf8");
    const corrupt = await run();
    expect(corrupt.connect).toMatchObject({ stateStatus: "invalid", connectEnabled: false });
    expect(checkById(corrupt, "connect-steering-scope")).toMatchObject({
      status: "warning",
      evidenceKind: "unavailable",
      code: "connect_state_unavailable",
      owner: "openwork-server",
      details: { connectStateStatus: "invalid" },
    });
  });

  test("assigns missing and disabled client runtime cloud entries to the OpenWork client", async () => {
    const missing = await createFixture({ runtime: {} });
    const missingReport = await runAgentContextDiagnostics({
      config: missing.config,
      workspace: missing.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "not-recorded",
    });
    expect(checkById(missingReport, "cloud-tool-catalog")).toMatchObject({
      code: "cloud_mcp_missing",
      owner: "openwork-client",
    });

    const disabled = await createFixture({
      runtime: {
        mcp: { "openwork-cloud": { ...cloudConfig(), enabled: false } },
      },
    });
    const disabledReport = await runAgentContextDiagnostics({
      config: disabled.config,
      workspace: disabled.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
    });
    expect(checkById(disabledReport, "cloud-tool-catalog")).toMatchObject({
      code: "cloud_mcp_disabled",
      owner: "openwork-client",
    });
  });

  test("names the trusted-origins environment variable for untrusted cloud endpoints", async () => {
    const runtime = diagnosticRuntimeConfig();
    if (!runtime.mcp) throw new Error("Expected the diagnostics MCP fixture.");
    runtime.mcp["openwork-cloud"] = {
      ...cloudConfig(),
      url: "https://den.customer.example/custom/mcp/agent",
    };
    const fixture = await createFixture({ runtime });
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(runtime),
      },
    }));

    const check = checkById(report, "cloud-tool-catalog");
    expect(check).toMatchObject({
      status: "warning",
      evidenceKind: "unavailable",
      code: "untrusted_endpoint",
      owner: "openwork-server",
      details: { requestPerformed: false, handshakePerformed: false, stage: "eligibility" },
    });
    // An untrusted origin means no request occurred; the report must describe
    // a trust-configuration state, never a network, TLS, or MCP failure.
    expect(check.message).toContain("not performed");
    expect(check.message).toContain("trust");
    expect(check.action).toContain("OPENWORK_AGENT_DIAGNOSTICS_TRUSTED_ORIGINS");
    expect(checkById(report, "cloud-endpoint-differential")).toMatchObject({
      status: "skipped",
      code: "runtime_probe_not_performed",
    });
    expect(check.details.trustSource).toBe("untrusted");
    expect(check.details.enterpriseActivationPresent).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  test("probes an on-prem endpoint this installation is activated against", async () => {
    const runtime = diagnosticRuntimeConfig();
    if (!runtime.mcp) throw new Error("Expected the diagnostics MCP fixture.");
    runtime.mcp["openwork-cloud"] = {
      ...cloudConfig(),
      url: "https://den.customer.example/custom/mcp/agent",
    };
    const fixture = await createFixture({ runtime });
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      // The engine reports this managed entry as failed; the independent
      // probe must still run and separate endpoint from engine.
      inspectRegistration: () => ({ status: "failed", source: "engine_status", recordAgeMs: 16_000, errorSummary: null }),
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(runtime),
        readActivatedEnterpriseOrigin: async () => "https://den.customer.example",
      },
    }));

    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
      details: {
        requestPerformed: true,
        trustSource: "enterprise-activation",
        enterpriseActivationPresent: true,
      },
    });
    expect(checkById(report, "cloud-endpoint-differential")).toMatchObject({
      status: "failed",
      code: "runtime_connected_engine_failed",
      owner: "opencode-engine",
    });
    expect(fetchCalls).toHaveLength(4);
    // The handshake must reach the operator's own Den deployment. Trusting an
    // origin never redirects the probe to OpenWork-hosted Cloud.
    expect(fetchCalls.map((call) => call.url)).toEqual([
      "https://den.customer.example/custom/mcp/agent",
      "https://den.customer.example/custom/mcp/agent",
      "https://den.customer.example/custom/mcp/agent",
      "https://den.customer.example/custom/mcp/agent",
    ]);
    expect(fetchCalls.some((call) => call.url.includes("openworklabs.com"))).toBe(false);
    expect(report.mcps).toContainEqual(expect.objectContaining({
      name: "openwork-cloud",
      source: "config.remote",
      origin: "https://den.customer.example",
      path: "/custom/mcp/agent",
    }));
  });

  test("distinguishes an activation origin that does not match the configured cloud MCP", async () => {
    const runtime = diagnosticRuntimeConfig();
    if (!runtime.mcp) throw new Error("Expected the diagnostics MCP fixture.");
    runtime.mcp["openwork-cloud"] = {
      ...cloudConfig(),
      url: "https://den.customer.example/custom/mcp/agent",
    };
    const fixture = await createFixture({ runtime });
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(runtime),
        readActivatedEnterpriseOrigin: async () => "https://den.other.example",
      },
    }));

    const check = checkById(report, "cloud-tool-catalog");
    expect(check).toMatchObject({
      status: "warning",
      code: "untrusted_endpoint",
      details: { requestPerformed: false, trustSource: "untrusted", enterpriseActivationPresent: true },
    });
    expect(check.message).toContain("mismatch");
    expect(fetchCalls).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("den.other.example");
  });

  test("fails closed when the effective engine response is invalid or unavailable", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];
    const inspectors: InspectAgentDiagnosticsEngine[] = [
      async () => ({ config: { default_agent: "openwork" }, agents: "not-an-array" }),
      async () => {
        throw new Error("RAW_ENGINE_ERROR_CANARY");
      },
    ];

    for (const inspectEffectiveEngine of inspectors) {
      const report = await runAgentContextDiagnostics({
        config: fixture.config,
        workspace: fixture.workspace,
        request: emptyObservedRequest,
        inspectRegistration: () => "connected",
        dependencies: {
          fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
          inspectEffectiveEngine,
        },
      });

      expect(checkById(report, "agent-connect-tool-permissions")).toMatchObject({
        status: "warning",
        code: "effective_connect_tool_policy_unavailable",
        details: { policyUnavailableReasons: expect.arrayContaining(["effective_engine_snapshot_unavailable"]) },
      });
      expect(checkById(report, "engine-config")).toMatchObject({
        status: "warning",
        evidenceKind: "unavailable",
      });
      expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
        status: "passed",
        code: "cloud_catalog_exact_match",
        details: { requestPerformed: true },
      });
      expect(report.safety.engineApiReadPerformed).toBe(true);
      expect(JSON.stringify(report)).not.toContain("RAW_ENGINE_ERROR_CANARY");
    }

    expect(fetchCalls).toHaveLength(8);
  });

  test("fails closed when the effective engine does not resolve the OpenWork agent", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];
    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(diagnosticRuntimeConfig(), { agentName: "other" }),
      },
    });

    expect(checkById(report, "engine-config")).toMatchObject({ status: "passed", evidenceKind: "observed" });
    expect(checkById(report, "engine-agent")).toMatchObject({ status: "failed", code: "effective_openwork_agent_missing" });
    expect(checkById(report, "agent-connect-tool-permissions")).toMatchObject({
      status: "warning",
      details: { policyUnavailableReasons: ["effective_openwork_agent_missing"] },
    });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
      details: { requestPerformed: true },
    });
    expect(fetchCalls).toHaveLength(4);
  });

  test("rejects hidden and subagent-only OpenWork defaults before cloud egress", async () => {
    const fixture = await createFixture();
    const cases = [
      {
        options: { hidden: true, agentMode: "primary" as const },
        code: "effective_openwork_agent_hidden",
      },
      {
        options: { hidden: false, agentMode: "subagent" as const },
        code: "effective_openwork_agent_not_primary",
      },
    ];

    for (const entry of cases) {
      const fetchCalls: CatalogFetchCall[] = [];
      const report = await runAgentContextDiagnostics({
        config: fixture.config,
        workspace: fixture.workspace,
        request: emptyObservedRequest,
        inspectRegistration: () => "connected",
        dependencies: {
          fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
          inspectEffectiveEngine: effectiveEngineInspection(diagnosticRuntimeConfig(), entry.options),
        },
      });

      expect(checkById(report, "agent-resolution")).toMatchObject({ status: "failed", code: entry.code });
      expect(checkById(report, "agent-connect-tool-permissions")).toMatchObject({
        status: "warning",
        code: "effective_connect_tool_policy_unavailable",
      });
      expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
        status: "passed",
        code: "cloud_catalog_exact_match",
        details: { requestPerformed: true },
      });
      expect(fetchCalls).toHaveLength(4);
    }
  });

  test("fails a marker-only prompt override whose digest is not canonical", async () => {
    const fixture = await createFixture();
    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], []),
        inspectEffectiveEngine: effectiveEngineInspection(diagnosticRuntimeConfig(), {
          prompt: "search_capabilities execute_capability Memory Bank",
        }),
      },
    });

    expect(checkById(report, "agent-prompt-markers")).toMatchObject({
      status: "failed",
      code: "effective_prompt_digest_mismatch",
      details: {
        searchCapabilities: true,
        executeCapability: true,
        memoryBank: true,
        canonicalPromptDigestMatch: false,
      },
    });
  });

  test("requires the exact canonical Connect plugin spec instead of a matching basename", async () => {
    const fixture = await createFixture();
    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], []),
        inspectEffectiveEngine: effectiveEngineInspection(diagnosticRuntimeConfig(), {
          pluginSpecs: ["https://plugins.invalid/spoof/openwork-extensions-preview.ts"],
        }),
      },
    });

    expect(report.agent.pluginLabels).toContain("openwork-extensions-preview");
    expect(checkById(report, "plugin-registration")).toMatchObject({
      status: "failed",
      code: "connect_steering_plugin_missing",
      details: { canonicalPluginSpecMatched: false },
    });
    expect(JSON.stringify(report)).not.toContain("plugins.invalid");
  });

  test("matches the canonical Connect plugin after OpenCode normalizes its absolute path to a file URL", async () => {
    const fixture = await createFixture();
    const canonicalConfig = buildOpenworkRuntimeConfigObjectFromSnapshot(diagnosticRuntimeConfig());
    const normalizedPlugins = openCodeNormalizedPluginSpecs(canonicalConfig.plugin);
    const canonicalConnectPlugin = normalizedPlugins.find((spec) => spec.includes("openwork-extensions-preview"));
    if (!canonicalConnectPlugin) throw new Error("Expected the canonical Connect plugin fixture.");
    expect(canonicalConnectPlugin.startsWith("file://")).toBe(true);

    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], []),
        inspectEffectiveEngine: effectiveEngineInspection(diagnosticRuntimeConfig(), {
          pluginSpecs: [canonicalConnectPlugin],
        }),
      },
    });

    expect(report.agent.pluginLabels).toContain("openwork-extensions-preview");
    expect(checkById(report, "plugin-registration")).toMatchObject({
      status: "passed",
      code: "connect_steering_plugin_effective",
      details: { canonicalPluginSpecMatched: true },
    });
  });

  test("preserves the overall abort before an authenticated catalog request can start", async () => {
    const fixture = await createFixture();
    const controller = new AbortController();
    const fetchCalls: CatalogFetchCall[] = [];
    const inspect = effectiveEngineInspection();

    const run = runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        signal: controller.signal,
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: async (signal) => {
          const payload = await inspect(signal);
          controller.abort();
          return payload;
        },
      },
    });

    await expect(run).rejects.toThrow();
    expect(fetchCalls).toEqual([]);
  });

  test("fails when the observed cloud catalog is missing one required tool", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];

    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    });

    expect(report.overall).toBe("failed");
    expect(report.firstFailedCheck).toBe("cloud-tool-catalog");
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "failed",
      code: "required_tools_missing",
      details: {
        expectedToolIds: ["search_capabilities", "execute_capability"],
        observedToolIds: [],
        requestPerformed: true,
        stage: "catalog_validation",
        totalToolCount: 1,
        requiredToolsPresent: false,
        retryable: false,
      },
    });
    expect(checkById(report, "cloud-endpoint-differential")).toMatchObject({
      status: "warning",
      code: "runtime_failed_engine_connected",
    });
    expect(fetchCalls).toHaveLength(4);
  });

  test("reports a corrupt runtime database as failed and unavailable without egress", async () => {
    const fixture = await createFixture({ withRuntime: false });
    await mkdir(join(fixture.root, "state"), { recursive: true });
    await writeFile(runtimeDbPath(fixture.config), Buffer.from("not-a-sqlite-database\u0000CANARY_DB_SECRET"));
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    }));

    expect(report.overall).toBe("failed");
    expect(report.firstFailedCheck).toBe("workspace-runtime");
    expect(checkById(report, "workspace-runtime")).toMatchObject({
      status: "failed",
      evidenceKind: "unavailable",
      code: "runtime_config_unreadable",
      details: { runtimeInspectionStatus: "unreadable" },
    });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "warning",
      code: "runtime_config_unavailable",
      details: { requestPerformed: false },
    });
    expect(fetchCalls).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("CANARY_DB_SECRET");
  });

  test("probes despite an unrecorded registration and reports stale-or-missing engine evidence", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];

    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "not-recorded",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    });

    expect(report.overall).toBe("warning");
    expect(report.firstFailedCheck).toBeNull();
    expect(checkById(report, "engine-mcp-sync")).toMatchObject({ status: "warning", code: "mcp_registration_not_recorded" });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
      details: { requestPerformed: true },
    });
    expect(checkById(report, "cloud-endpoint-differential")).toMatchObject({
      status: "warning",
      code: "engine_evidence_stale_or_unavailable",
      details: { engineRegistrationStatus: "not-recorded" },
    });
    expect(report.safety.cloudCatalogToolsListPerformed).toBe(true);
    expect(fetchCalls).toHaveLength(4);
  });

  test("separates a reachable endpoint from an engine needs-auth registration", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];
    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "needs-auth",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    });

    expect(checkById(report, "engine-mcp-sync")).toMatchObject({
      status: "failed",
      code: "mcp_registration_not_connected",
      details: { needsAuthCount: 3, connectedCount: 0 },
    });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
      details: { requestPerformed: true },
    });
    expect(checkById(report, "cloud-endpoint-differential")).toMatchObject({
      status: "failed",
      code: "runtime_connected_engine_failed",
      owner: "opencode-engine",
      details: { engineRegistrationStatus: "needs-auth" },
    });
    expect(checkById(report, "cloud-endpoint-transport")).toMatchObject({
      status: "skipped",
      code: "transport_probe_not_applicable",
      details: {
        endpointOrigin: "http://127.0.0.1:43123",
        skipReason: "http_loopback_no_tls",
        verifiedHandshake: "not-performed",
      },
    });
    expect(fetchCalls).toHaveLength(4);
  });

  test("scrubs endpoint-bearing registration errors without losing TLS transport cause", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];
    const endpointError = "failed to connect to https://openwork-poc.blueyonder.com/api/den/mcp/agent: unable to verify the first certificate";
    const pathError = "request to /api/den/mcp/agent failed: self signed certificate in certificate chain";
    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: (name) => {
        if (name === "openwork-cloud") {
          return { status: "failed", source: "engine_status", recordAgeMs: 1_000, errorSummary: endpointError };
        }
        if (name === "non-cloud-canary") {
          return { status: "failed", source: "engine_status", recordAgeMs: 1_000, errorSummary: pathError };
        }
        return "connected";
      },
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    }));

    const failedRegistrations = checkById(report, "engine-mcp-sync").details.failedRegistrations;
    expect(failedRegistrations).toEqual([
      expect.objectContaining({
        name: "openwork-cloud",
        errorSummary: "failed to connect to [url] unable to verify the first certificate",
        transportCause: "tls_incomplete_chain",
      }),
      expect.objectContaining({
        name: "non-cloud-canary",
        errorSummary: "request to [path] failed: self signed certificate in certificate chain",
        transportCause: "tls_untrusted_ca",
      }),
    ]);
    expect(JSON.stringify(failedRegistrations)).not.toContain("[redacted-sensitive-label]");
    expect(fetchCalls).toHaveLength(4);
  });

  test("adds TLS-layer served-chain evidence when certificate verification fails", async () => {
    const port = await startSelfSignedTlsServer();
    const runtime = diagnosticRuntimeConfig();
    if (!runtime.mcp) throw new Error("Expected the diagnostics MCP fixture.");
    runtime.mcp["openwork-cloud"] = {
      ...cloudConfig(),
      url: `https://127.0.0.1:${port}/mcp/agent`,
    };
    const fixture = await createFixture({ runtime });

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => ({
        status: "failed",
        source: "engine_status",
        recordAgeMs: 1_000,
        errorSummary: "self signed certificate in certificate chain",
      }),
      dependencies: {
        inspectEffectiveEngine: effectiveEngineInspection(runtime),
      },
    }));

    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "failed",
      details: {
        requestPerformed: false,
        runtimeFamily: expect.any(String),
        transport: expect.any(String),
      },
    });
    expect(checkById(report, "cloud-endpoint-differential")).toMatchObject({
      status: "failed",
      code: "runtime_and_engine_failed",
    });
    expect(checkById(report, "cloud-endpoint-transport")).toMatchObject({
      status: "failed",
      code: "endpoint_tls_untrusted",
      details: {
        endpointOrigin: `https://127.0.0.1:${port}`,
        endpointProtocol: "https:",
        handshakePerformed: true,
        verifiedHandshake: "failed",
        dnsResolved: true,
        tcpConnected: true,
        servedChainLength: 1,
        servedChain: [expect.objectContaining({
          subjectCN: "localhost",
          issuerCN: "localhost",
          selfIssued: true,
        })],
        nodeExtraCaCertsSet: expect.any(Boolean),
      },
    });
    expect(report.safety.credentialFreeTransportProbePerformed).toBe(true);
    expect(report.safety.sanitizedEngineErrorSummariesIncluded).toBe(true);
  });

  test("downgrades stale failed registration evidence when the engine is reachable", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];
    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: (name) => ({
        status: "failed",
        source: "transport_failure",
        recordAgeMs: 61_000,
        errorSummary: name === "openwork-cloud" ? "unable to verify the first certificate" : null,
      }),
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    });

    const check = checkById(report, "engine-mcp-sync");
    expect(check).toMatchObject({
      status: "warning",
      code: "mcp_registration_stale_failure",
      details: { engineReachableNow: true, failedCount: 3 },
    });
    expect(check.details.failedRegistrations).toEqual([
      {
        name: "openwork-cloud",
        status: "failed",
        source: "transport_failure",
        recordAgeMs: 61_000,
        errorSummary: "unable to verify the first certificate",
        transportCause: "tls_incomplete_chain",
        engineReachableNow: true,
      },
      {
        name: "non-cloud-canary",
        status: "failed",
        source: "transport_failure",
        recordAgeMs: 61_000,
        errorSummary: null,
        transportCause: null,
        engineReachableNow: true,
      },
      {
        name: "[redacted-sensitive-label]",
        status: "failed",
        source: "transport_failure",
        recordAgeMs: 61_000,
        errorSummary: null,
        transportCause: null,
        engineReachableNow: true,
      },
    ]);
    expect(checkById(report, "cloud-endpoint-differential")).toMatchObject({
      status: "warning",
      code: "engine_evidence_stale_or_unavailable",
      details: { engineEvidenceAgeMs: 61_000 },
    });
    expect(fetchCalls).toHaveLength(4);
  });

  test("keeps fresh failed registration evidence as a failed check", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];
    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => ({
        status: "failed",
        source: "engine_status",
        recordAgeMs: 1_000,
        errorSummary: null,
      }),
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    });

    expect(checkById(report, "engine-mcp-sync")).toMatchObject({
      status: "failed",
      code: "mcp_registration_not_connected",
      details: { engineReachableNow: true, failedCount: 3 },
    });
    expect(checkById(report, "cloud-endpoint-differential")).toMatchObject({
      status: "failed",
      code: "runtime_connected_engine_failed",
      details: { engineRegistrationStatus: "failed", engineEvidenceSource: "engine_status", engineEvidenceAgeMs: 1_000 },
    });
    expect(fetchCalls).toHaveLength(4);
  });

  test("reports a missing credential without putting authorization-shaped text in the report", async () => {
    const runtime = diagnosticRuntimeConfig();
    if (!runtime.mcp) throw new Error("Expected the diagnostics MCP fixture.");
    runtime.mcp["openwork-cloud"] = { ...cloudConfig(), headers: {} };
    const fixture = await createFixture({ runtime });
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls),
        inspectEffectiveEngine: effectiveEngineInspection(runtime),
      },
    }));

    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "failed",
      code: "credential_missing",
      message: "The managed OpenWork Cloud entry does not contain one unambiguous authentication value.",
    });
    expect(fetchCalls).toEqual([]);
  });

  test("honors current OpenCode permission rules for flat MCP tool IDs before egress", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspaceRoot, "opencode.jsonc"), JSON.stringify({
      permission: {
        "openwork-cloud_*": "allow",
      },
      agent: {
        openwork: {
          permission: {
            "openwork-cloud_search_capabilities": "deny",
          },
        },
      },
    }), "utf8");
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: { fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls) },
    }));

    expect(report.overall).toBe("failed");
    expect(report.firstFailedCheck).toBe("agent-connect-tool-permissions");
    expect(report.agent.configuredOpenworkAgent.connectToolPermissions).toEqual({
      searchCapabilities: "denied",
      executeCapability: "unspecified",
      deniedRelevantToolCount: 1,
    });
    expect(checkById(report, "agent-connect-tool-permissions")).toMatchObject({
      status: "failed",
      evidenceKind: "derived",
      code: "required_connect_tools_denied_by_static_policy",
      owner: "member",
      details: {
        searchCapabilities: "denied",
        executeCapability: "unspecified",
        deniedRelevantToolCount: 1,
      },
    });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
      details: { requestPerformed: true },
    });
    expect(report.mcps.find((mcp) => (
      mcp.name === "openwork-cloud" && mcp.source === "config.remote"
    ))?.disabledByTools).toBe(true);
    expect(report.safety.cloudCatalogToolsListPerformed).toBe(true);
    expect(fetchCalls).toHaveLength(4);
  });

  test("fails closed when a static OpenCode tool policy layer is invalid", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.workspaceRoot, "opencode.jsonc"), JSON.stringify({
      permission: {
        "openwork-cloud_*": ["deny"],
      },
    }), "utf8");
    const fetchCalls: CatalogFetchCall[] = [];

    const report = agentContextDiagnosticsReportSchema.parse(await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: { fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls) },
    }));

    expect(report.agent.configuredOpenworkAgent.connectToolPermissions).toEqual({
      searchCapabilities: "unspecified",
      executeCapability: "unspecified",
      deniedRelevantToolCount: null,
    });
    expect(checkById(report, "agent-connect-tool-permissions")).toMatchObject({
      status: "warning",
      evidenceKind: "unavailable",
      code: "effective_connect_tool_policy_unavailable",
      owner: "opencode-engine",
    });
    expect(checkById(report, "mcp-inventory")).toMatchObject({
      status: "warning",
      evidenceKind: "unavailable",
      code: "mcp_config_layer_unreadable",
      details: { projectLayerStatus: "invalid" },
    });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
      details: { requestPerformed: true },
    });
    expect(report.safety.cloudCatalogToolsListPerformed).toBe(true);
    expect(fetchCalls).toHaveLength(4);
  });

  test("never reads a same-id local runtime row or performs egress for a remote workspace shell", async () => {
    const fixture = await createFixture({
      workspace: {
        path: "",
        workspaceType: "remote",
        remoteType: "openwork",
        baseUrl: "https://remote-openwork.invalid",
        openworkHostUrl: "https://remote-openwork.invalid",
      },
    });
    const fetchCalls: CatalogFetchCall[] = [];

    const report = await runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: emptyObservedRequest,
      inspectRegistration: () => "connected",
      dependencies: { fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls) },
    });

    expect(report.workspace.type).toBe("remote");
    expect(report.mcps).toEqual([]);
    expect(report.connect.selectedWorkspaceCloudMcpPresent).toBe(false);
    expect(checkById(report, "workspace-runtime")).toMatchObject({
      status: "warning",
      code: "remote_workspace_runtime_not_inspected",
    });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "warning",
      code: "remote_workspace_unavailable",
      details: { requestPerformed: false },
    });
    expect(report.safety.cloudCatalogToolsListPerformed).toBe(false);
    expect(fetchCalls).toEqual([]);
  });

  test("keeps concurrent cloud probes cancellation-scoped and organization evidence isolated", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];
    let releaseProbe!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const fetchImpl = catalogFetch(["search_capabilities", "execute_capability"], fetchCalls, { release });
    const requestFor = (id: string, name: string): AgentContextDiagnosticsRequest => ({
      organizationConnectionsProbe: { status: "observed", code: null, totalCount: 1, truncated: false },
      organizationConnections: [{
        id,
        name,
        credentialMode: "shared",
        connected: true,
        connectedForMe: true,
        needsReconnect: false,
        missingFeatureCount: 0,
      }],
    });

    const first = runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: requestFor("org.first", "First organization"),
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl,
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    });
    const second = runAgentContextDiagnostics({
      config: fixture.config,
      workspace: fixture.workspace,
      request: requestFor("org.second", "Second organization"),
      inspectRegistration: () => "connected",
      dependencies: {
        fetchImpl,
        inspectEffectiveEngine: effectiveEngineInspection(),
      },
    });
    while (fetchCalls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    releaseProbe();
    const [firstReport, secondReport] = await Promise.all([first, second]);

    expect(fetchCalls).toHaveLength(8);
    expect(firstReport.organizationConnections.map((connection) => connection.id)).toEqual(["org.first"]);
    expect(secondReport.organizationConnections.map((connection) => connection.id)).toEqual(["org.second"]);
    expect(firstReport.organizationConnections[0]?.name).toBe("First organization");
    expect(secondReport.organizationConnections[0]?.name).toBe("Second organization");
    expect(firstReport).not.toBe(secondReport);
  });

  test("assigns per-member remediation to the member and shared remediation to an organization administrator", async () => {
    const fixture = await createFixture();
    const fetchCalls: CatalogFetchCall[] = [];
    const connection = (overrides: Partial<AgentContextDiagnosticsRequest["organizationConnections"][number]>) => ({
      id: "connection.base",
      name: "Connection",
      credentialMode: "per_member" as const,
      connected: true,
      connectedForMe: true,
      needsReconnect: false,
      missingFeatureCount: 0,
      ...overrides,
    });
    const run = (organizationConnections: AgentContextDiagnosticsRequest["organizationConnections"]) => (
      runAgentContextDiagnostics({
        config: fixture.config,
        workspace: fixture.workspace,
        request: {
          organizationConnectionsProbe: {
            status: "observed",
            code: null,
            totalCount: organizationConnections.length,
            truncated: false,
          },
          organizationConnections,
        },
        inspectRegistration: () => "connected",
        dependencies: { fetchImpl: catalogFetch(["search_capabilities", "execute_capability"], fetchCalls) },
      })
    );

    const memberReport = await run([connection({
      id: "connection.member",
      connectedForMe: false,
    })]);
    expect(checkById(memberReport, "organization-connections")).toMatchObject({
      code: "organization_member_action_required",
      owner: "member",
      action: "Connect or reconnect your account for the listed per-member connections in Settings > Connect.",
      details: { notReadyCount: 1, memberActionCount: 1, organizationAdminActionCount: 0 },
    });

    const adminReport = await run([connection({
      id: "connection.shared",
      credentialMode: "shared",
      connected: false,
    })]);
    expect(checkById(adminReport, "organization-connections")).toMatchObject({
      code: "organization_admin_action_required",
      owner: "organization-admin",
      action: "Ask an organization administrator to repair the listed shared connections in Den, then rerun diagnostics.",
      details: { notReadyCount: 1, memberActionCount: 0, organizationAdminActionCount: 1 },
    });

    const mixedReport = await run([
      connection({ id: "connection.member-reconnect", needsReconnect: true, missingFeatureCount: 2 }),
      connection({ id: "connection.shared-repair", credentialMode: "shared", connected: false }),
    ]);
    expect(checkById(mixedReport, "organization-connections")).toMatchObject({
      code: "organization_member_and_admin_action_required",
      owner: "member-and-organization-admin",
      details: { notReadyCount: 2, memberActionCount: 1, organizationAdminActionCount: 1 },
    });
  });

  test("registration inspection accepts only the latest matching stable fingerprint", async () => {
    const engine = startRecordingServer();
    const fixture = await createFixture({ workspace: { baseUrl: engine.baseUrl } });
    const exact = cloudConfig();

    await startOpenwork(fixture.config);
    await syncAllWorkspacesRuntimeMcpToEngine(fixture.config);

    expect(inspectEngineMcpRegistration(fixture.config, fixture.workspace, "openwork-cloud", exact)).toBe("connected");
    expect(inspectEngineMcpRegistration(fixture.config, fixture.workspace, "openwork-cloud", {
      headers: { Authorization: CLOUD_BEARER },
      enabled: true,
      url: CLOUD_ENDPOINT,
      type: "remote",
    })).toBe("connected");
    expect(inspectEngineMcpRegistration(fixture.config, fixture.workspace, "openwork-cloud", {
      ...exact,
      headers: { Authorization: "Bearer CHANGED_TOKEN" },
    })).toBe("not-recorded");
    expect(inspectEngineMcpRegistration(fixture.config, fixture.workspace, "never-registered", exact)).toBe("not-recorded");
    expect(engine.requests.filter((request) => request.method === "POST" && request.pathname === "/mcp")).toHaveLength(3);
  });
});

describe("agent context diagnostics route", () => {
  test("reads production effective engine state and performs the bounded cloud catalog probe", async () => {
    const engine = startRecordingServer();
    const fixture = await createFixture({
      workspace: {
        id: "ws_agent_diagnostics_no_policy_authority",
        baseUrl: engine.baseUrl,
      },
    });
    const downstreamFetches: string[] = [];
    const catalogCalls: CatalogFetchCall[] = [];
    const runCatalogFetch = catalogFetch(["search_capabilities", "execute_capability"], catalogCalls);
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = input instanceof Request ? input.url : String(input);
      downstreamFetches.push(url);
      if (new URL(url).origin === new URL(engine.baseUrl).origin) return nativeFetch(input, init);
      if (url === CLOUD_ENDPOINT) return runCatalogFetch(input, init);
      throw new Error("Diagnostics attempted an unexpected downstream endpoint");
    }) as unknown as typeof fetch;
    const base = await startOpenwork(fixture.config);
    await syncAllWorkspacesRuntimeMcpToEngine(fixture.config);
    expect(inspectEngineMcpRegistration(
      fixture.config,
      fixture.workspace,
      "openwork-cloud",
      cloudConfig(),
    )).toBe("connected");
    const engineRequestCountBeforeDiagnostics = engine.requests.length;

    const response = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify(emptyObservedRequest),
    });

    expect(response.status).toBe(200);
    const report = agentContextDiagnosticsReportSchema.parse(await response.json());
    expect(checkById(report, "engine-mcp-sync")).toMatchObject({
      status: "passed",
      code: "managed_mcp_registration_states_healthy",
    });
    expect(checkById(report, "engine-config")).toMatchObject({ status: "passed", evidenceKind: "observed" });
    expect(checkById(report, "engine-agent")).toMatchObject({ status: "passed", evidenceKind: "observed" });
    expect(checkById(report, "cloud-tool-catalog")).toMatchObject({
      status: "passed",
      code: "cloud_catalog_exact_match",
      details: { requestPerformed: true },
    });
    expect(report.safety.engineApiReadPerformed).toBe(true);
    expect(report.safety.cloudCatalogToolsListPerformed).toBe(true);
    expect(catalogCalls).toHaveLength(4);
    expect(catalogCalls.slice(0, 3).map((call) => call.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(catalogCalls[3]?.method).toBe("DELETE");
    expect(downstreamFetches.filter((url) => url === CLOUD_ENDPOINT)).toHaveLength(4);
    expect(engine.requests
      .slice(engineRequestCountBeforeDiagnostics)
      .filter((request) => request.method === "GET")
      .map((request) => request.pathname)
      .sort())
      .toEqual(["/agent", "/config"]);
  });

  test("returns a no-store collaborator report on fresh state without creating or changing configuration", async () => {
    const fixture = await createFixture({ withRuntime: false });
    const downstreamFetches: Array<{ input: string }> = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      downstreamFetches.push({ input: input instanceof Request ? input.url : String(input) });
      throw new Error("Selected engine is unavailable");
    }) as unknown as typeof fetch;
    const base = await startOpenwork(fixture.config);
    const before = await snapshotTree(fixture.root);

    const response = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify(emptyObservedRequest),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = agentContextDiagnosticsReportSchema.parse(await response.json());
    expect(report.workspace.id).toBe(fixture.workspace.id);
    expect(report.safety).toMatchObject({
      diagnosticsWorkspaceRuntimeConfigurationReadOnly: true,
      directConfigurationMutationPerformed: false,
      engineApiReadPerformed: true,
      engineBootstrapMayHaveRun: true,
      engineBootstrapSideEffectsInspected: false,
      directNonCloudMcpFetchPerformed: false,
    });
    expect(downstreamFetches.map((entry) => new URL(entry.input).pathname).sort()).toEqual(["/agent", "/config"]);
    expect(checkById(report, "engine-config")).toMatchObject({
      status: "warning",
      code: "engine_diagnostics_request_failed",
    });
    expect(await snapshotTree(fixture.root)).toEqual(before);
  });

  test("rejects a viewer before diagnostics or any downstream fetch", async () => {
    const fixture = await createFixture({ withRuntime: false });
    const downstreamFetches: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      downstreamFetches.push(String(input));
      throw new Error("Viewer request unexpectedly performed downstream fetch");
    }) as unknown as typeof fetch;
    const base = await startOpenwork(fixture.config);
    const issued = await nativeFetch(`${base}/tokens`, {
      method: "POST",
      headers: hostHeaders(),
      body: JSON.stringify({ scope: "viewer", label: "diagnostics viewer" }),
    });
    expect(issued.status).toBe(201);
    const viewerToken = ((await issued.json()) as { token: string }).token;

    const response = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(viewerToken),
      body: JSON.stringify(emptyObservedRequest),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden" });
    expect(downstreamFetches).toEqual([]);
  });

  test("rejects non-strict diagnostics input with a stable 400 error and no downstream fetch", async () => {
    const fixture = await createFixture({ withRuntime: false });
    const downstreamFetches: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      downstreamFetches.push(String(input));
      throw new Error("Invalid request unexpectedly performed downstream fetch");
    }) as unknown as typeof fetch;
    const base = await startOpenwork(fixture.config);

    const response = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify({ ...emptyObservedRequest, unexpected: true }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_agent_diagnostics_request" });
    expect(downstreamFetches).toEqual([]);
  });

  test("charges the collaborator cooldown before parsing invalid JSON", async () => {
    const fixture = await createFixture({
      withRuntime: false,
      workspace: { id: "ws_agent_diagnostics_invalid_body_cooldown" },
    });
    const base = await startOpenwork(fixture.config);

    const invalid = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: "{",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "invalid_json" });

    const repeated = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify(emptyObservedRequest),
    });
    expect(repeated.status).toBe(429);
    expect(await repeated.json()).toMatchObject({ code: "agent_diagnostics_rate_limited" });
  });

  test("bounds diagnostics JSON bodies and charges oversized attempts to the cooldown", async () => {
    const fixture = await createFixture({
      withRuntime: false,
      workspace: { id: "ws_agent_diagnostics_oversized_body_cooldown" },
    });
    const base = await startOpenwork(fixture.config);
    const oversizedBody = JSON.stringify({
      ...emptyObservedRequest,
      padding: "x".repeat(300 * 1024),
    });

    const oversized = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: oversizedBody,
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("connection")).toBe("close");
    expect(await oversized.json()).toMatchObject({ code: "agent_diagnostics_request_too_large" });

    const repeated = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify(emptyObservedRequest),
    });
    expect(repeated.status).toBe(429);
    expect(await repeated.json()).toMatchObject({ code: "agent_diagnostics_rate_limited" });
  });

  test("enforces the body cap when a chunked request omits content-length", async () => {
    const fixture = await createFixture({
      withRuntime: false,
      workspace: { id: "ws_agent_diagnostics_chunked_body_cap" },
    });
    const base = await startOpenwork(fixture.config);
    const bodyBytes = new TextEncoder().encode(JSON.stringify({
      ...emptyObservedRequest,
      padding: "x".repeat(300 * 1024),
    }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bodyBytes);
        controller.close();
      },
    });

    const oversized = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body,
      // @ts-expect-error Node-compatible fetch requires duplex for a streamed request body.
      duplex: "half",
    });
    expect(oversized.status).toBe(413);
    expect(oversized.headers.get("connection")).toBe("close");
    expect(await oversized.json()).toMatchObject({ code: "agent_diagnostics_request_too_large" });
  });

  test("charges a slow in-progress body before waiting for its bytes", async () => {
    const fixture = await createFixture({
      withRuntime: false,
      workspace: { id: "ws_agent_diagnostics_slow_body_cooldown" },
    });
    const base = await startOpenwork(fixture.config);
    const slowSocket = await openSlowDiagnosticsRequest(base, fixture.workspace.id);
    try {
      // Let Bun dispatch the header-complete request while its declared body
      // remains incomplete. The route must charge the cooldown before its
      // bounded reader waits for the remaining bytes.
      await new Promise((resolve) => setTimeout(resolve, 75));
      const repeated = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
        method: "POST",
        headers: clientHeaders(),
        body: JSON.stringify(emptyObservedRequest),
      });
      expect(repeated.status).toBe(429);
      expect(await repeated.json()).toMatchObject({ code: "agent_diagnostics_rate_limited" });
    } finally {
      slowSocket.destroy();
    }
  });

  test("terminates an incomplete dripping body at the server's absolute deadline", async () => {
    const previousDeadline = process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS;
    process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS = "120";
    const fixture = await createFixture({
      withRuntime: false,
      workspace: { id: "ws_agent_diagnostics_body_deadline" },
    });
    const base = await startOpenwork(fixture.config);
    const socket = await openSlowDiagnosticsRequest(base, fixture.workspace.id);
    const drip = setInterval(() => {
      if (!socket.destroyed && socket.writable) socket.write(" ");
    }, 20);
    try {
      const result = await readRawSocketUntilServerResponse(socket, 1_000);
      expect(result.elapsedMs).toBeGreaterThanOrEqual(80);
      expect(result.elapsedMs).toBeLessThan(800);
      expect(result.raw).toContain(" 408 ");
      expect(result.raw).toContain("agent_diagnostics_request_timeout");
      expect(result.raw.toLowerCase()).toContain("connection: close");
      // Keep the client side open beyond the server's delayed stream abort.
      // The passing result was therefore produced by the server deadline, not
      // by a client close or AbortController.
      await new Promise((resolve) => setTimeout(resolve, 60));
    } finally {
      clearInterval(drip);
      socket.destroy();
      if (previousDeadline === undefined) delete process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS;
      else process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS = previousDeadline;
    }
  });

  test("rejects a concurrent incomplete request and releases its reservation after timeout", async () => {
    const previousCooldown = process.env.OPENWORK_AGENT_DIAGNOSTICS_COOLDOWN_MS;
    const previousDeadline = process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS;
    process.env.OPENWORK_AGENT_DIAGNOSTICS_COOLDOWN_MS = "0";
    process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS = "150";
    const fixture = await createFixture({
      withRuntime: false,
      workspace: { id: "ws_agent_diagnostics_in_flight_reservation" },
    });
    const base = await startOpenwork(fixture.config);
    const incomplete = await openSlowDiagnosticsRequest(base, fixture.workspace.id);
    let concurrentIncomplete: Socket | undefined;
    try {
      // Allow the header-complete first request to acquire its reservation.
      await new Promise((resolve) => setTimeout(resolve, 40));
      concurrentIncomplete = await openSlowDiagnosticsRequest(base, fixture.workspace.id);
      const rejectedConcurrent = await readRawSocketUntilServerResponse(concurrentIncomplete, 1_000);
      expect(rejectedConcurrent.raw).toContain(" 429 ");
      expect(rejectedConcurrent.raw).toContain("agent_diagnostics_in_progress");
      expect(rejectedConcurrent.raw.toLowerCase()).toContain("connection: close");

      const timedOut = await readRawSocketUntilServerResponse(incomplete, 1_000);
      expect(timedOut.elapsedMs).toBeLessThan(800);
      expect(timedOut.raw).toContain("agent_diagnostics_request_timeout");

      const afterRelease = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
        method: "POST",
        headers: clientHeaders(),
        body: JSON.stringify(emptyObservedRequest),
      });
      expect(afterRelease.status).toBe(200);
    } finally {
      incomplete.destroy();
      concurrentIncomplete?.destroy();
      if (previousCooldown === undefined) delete process.env.OPENWORK_AGENT_DIAGNOSTICS_COOLDOWN_MS;
      else process.env.OPENWORK_AGENT_DIAGNOSTICS_COOLDOWN_MS = previousCooldown;
      if (previousDeadline === undefined) delete process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS;
      else process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS = previousDeadline;
    }
  });

  test("caps incomplete diagnostics bodies across workspaces for one server", async () => {
    const previousCooldown = process.env.OPENWORK_AGENT_DIAGNOSTICS_COOLDOWN_MS;
    const previousDeadline = process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS;
    process.env.OPENWORK_AGENT_DIAGNOSTICS_COOLDOWN_MS = "0";
    process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS = "10000";
    const fixture = await createFixture({
      withRuntime: false,
      workspace: { id: "ws_agent_diagnostics_capacity_0" },
    });
    fixture.config.workspaces = Array.from({ length: 17 }, (_, index) => ({
      ...fixture.workspace,
      id: `ws_agent_diagnostics_capacity_${index}`,
      name: `Diagnostics capacity ${index}`,
    }));
    const base = await startOpenwork(fixture.config);
    const held: Socket[] = [];
    let rejected: Socket | undefined;
    try {
      for (const workspace of fixture.config.workspaces.slice(0, 16)) {
        held.push(await openSlowDiagnosticsRequest(base, workspace.id));
      }
      await new Promise((resolve) => setTimeout(resolve, 75));
      rejected = await openSlowDiagnosticsRequest(base, fixture.config.workspaces[16]!.id);
      const result = await readRawSocketUntilServerResponse(rejected, 1_000);
      expect(result.raw).toContain(" 429 ");
      expect(result.raw).toContain("agent_diagnostics_busy");
      expect(result.raw.toLowerCase()).toContain("connection: close");
    } finally {
      for (const socket of held) socket.destroy();
      rejected?.destroy();
      if (previousCooldown === undefined) delete process.env.OPENWORK_AGENT_DIAGNOSTICS_COOLDOWN_MS;
      else process.env.OPENWORK_AGENT_DIAGNOSTICS_COOLDOWN_MS = previousCooldown;
      if (previousDeadline === undefined) delete process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS;
      else process.env.OPENWORK_AGENT_DIAGNOSTICS_BODY_TIMEOUT_MS = previousDeadline;
    }
  });

  test("rate-limits repeated collaborator runs for the same workspace", async () => {
    const fixture = await createFixture({
      withRuntime: false,
      workspace: { id: "ws_agent_diagnostics_rate_limit" },
    });
    const base = await startOpenwork(fixture.config);
    const request = () => nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify(emptyObservedRequest),
    });

    expect((await request()).status).toBe(200);
    const limited = await request();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "agent_diagnostics_rate_limited" });
  });

  test("rejects direct remote OpenCode shells before inspection or egress", async () => {
    const fixture = await createFixture({
      withRuntime: false,
      workspace: {
        id: "ws_agent_diagnostics_remote_opencode",
        path: "",
        workspaceType: "remote",
        remoteType: "opencode",
        baseUrl: "https://remote-opencode.invalid",
      },
    });
    const downstreamFetches: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      downstreamFetches.push(String(input));
      throw new Error("Remote OpenCode diagnostics unexpectedly performed downstream fetch");
    }) as unknown as typeof fetch;
    const base = await startOpenwork(fixture.config);

    const response = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify(emptyObservedRequest),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "agent_diagnostics_workspace_unsupported" });
    expect(downstreamFetches).toEqual([]);
  });

  test("rejects remote OpenWork shells so diagnostics run on the owning server", async () => {
    const fixture = await createFixture({
      withRuntime: false,
      workspace: {
        id: "ws_agent_diagnostics_remote_openwork",
        path: "",
        workspaceType: "remote",
        remoteType: "openwork",
        baseUrl: "https://remote-openwork.invalid",
        openworkHostUrl: "https://remote-openwork.invalid",
      },
    });
    const downstreamFetches: string[] = [];
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
      downstreamFetches.push(String(input));
      throw new Error("Remote OpenWork shell unexpectedly performed downstream fetch");
    }) as unknown as typeof fetch;
    const base = await startOpenwork(fixture.config);

    const response = await nativeFetch(`${base}/workspace/${fixture.workspace.id}/diagnostics/agent-context`, {
      method: "POST",
      headers: clientHeaders(),
      body: JSON.stringify(emptyObservedRequest),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "agent_diagnostics_workspace_unsupported" });
    expect(downstreamFetches).toEqual([]);
  });
});
