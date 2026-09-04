import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

import { trimTrailingSlashes } from "./strings.ts";

export interface MockAuthorizeRequest {
  method: string;
  path: string;
  url: string;
  at: string;
}

/** A tool invocation the connector actually served, and which credential served it. */
export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
  /** sha256 prefix of the caller's bearer token — distinct per member credential. */
  tokenId: string | null;
  /** When the connector served it (the mock's clock). */
  at: string;
}

export interface MockAgentToolStep {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface MockAgentWorkload {
  promptMarker: string;
  finalReply: string;
  /** Stream the final reply as consecutive content deltas of this many characters instead of one. */
  finalReplyChunkSize?: number;
  /** Tool calls the agent makes before its final reply; empty answers directly. */
  steps: MockAgentToolStep[];
  /**
   * Declared fault: the first N main completions stream their opening chunk
   * and then go quiet without ending (a half-open socket after the client
   * slept). Recorded as kind "quiet"; later completions proceed normally.
   */
  quietCompletions?: number;
}

export interface MockAgentRequest {
  model: string;
  promptMarker: string | null;
  matchedMarkers: string[];
  completedTools: number;
  kind: "utility" | "tool" | "final" | "error" | "quiet";
  toolName: string | null;
  arguments: Record<string, unknown>;
  at: string;
}

export interface MockMcpHandle {
  url: string;
  mcpUrl: string;
  authorizeRequestSince(iso: string, opts?: { timeoutMs?: number }): Promise<MockAuthorizeRequest & { params: URLSearchParams }>;
  requests(): Promise<MockAuthorizeRequest[]>;
  /**
   * Tool calls the connector served. This is the AUTHORITY for "did a person
   * really use it" — the app's own UI can look connected while nothing was
   * invoked, and per-member isolation is only provable by distinct tokenIds.
   *
   * Pass sinceIso when the mock is long-lived (publicUrl): its request log
   * spans runs, so an unfiltered atLeast is satisfied by a PREVIOUS run's
   * calls and returns before this run's calls ever arrive.
   */
  toolCalls(opts?: { name?: string; timeoutMs?: number; atLeast?: number; sinceIso?: string }): Promise<MockToolCall[]>;
  agentRequests(opts?: { promptMarker?: string; timeoutMs?: number; atLeast?: number; sinceIso?: string }): Promise<MockAgentRequest[]>;
  handshakes(opts?: { timeoutMs?: number; atLeast?: number; sinceIso?: string }): Promise<MockAuthorizeRequest[]>;
  configureOAuthRedirectUris(redirectUris: readonly string[]): Promise<void>;
  resetOAuth(): Promise<void>;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface MockMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  result: { content: { type: "text"; text: string }[] };
}

export interface StartMockMcpOptions {
  /** Replace the catalog with deterministic tools; served calls remain observable through toolCalls(). */
  tools?: MockMcpTool[];
  port?: number;
  scriptPath?: string;
  publicUrl?: string;
  /** Advertised OAuth/resource origin when the mock sits behind a proxy; defaults to the mock's own URL. */
  issuer?: string;
  profileId?: EnterpriseMcpProfileId;
  fault?: string;
  oauthClientSecret?: string;
  allowUnauthenticatedMcp?: boolean;
  /** Serve this many additional synthetic mock_tool_<i> tools for scale specs. */
  extraToolCount?: number;
  /** Serve one app-visible MCP App launch tool (`_meta.ui.resourceUri`) under this name. */
  appToolName?: string;
  /** Script deterministic OpenAI-compatible agent turns through this mock. */
  agentWorkloads?: MockAgentWorkload[];
}

export type EnterpriseMcpProfileId =
  | "synthetic-enterprise-oauth-mcp"
  | "servicenow-inbound-quickstart"
  | "microsoft-work-iq"
  | "microsoft-enterprise"
  | "agent-365-mail-v1-2026-07"
  | "slack-user-mcp";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRequest(value: unknown): MockAuthorizeRequest | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.method !== "string"
    || typeof value.path !== "string"
    || typeof value.url !== "string"
    || typeof value.at !== "string"
  ) return null;
  return { method: value.method, path: value.path, url: value.url, at: value.at };
}

function parseRequests(value: unknown): MockAuthorizeRequest[] {
  if (!isRecord(value) || !Array.isArray(value.requests)) return [];
  return value.requests.flatMap((entry) => {
    const request = parseRequest(entry);
    return request ? [request] : [];
  });
}

async function waitForHealth(url: string, output: () => string, child: ChildProcess | null): Promise<void> {
  let last = "unreachable";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // With an externally-managed mock there is no child at all; only a spawned
    // child that has ALREADY exited (exitCode set) means startup failed.
    if (child && child.exitCode !== null) {
      throw new Error(`Mock OAuth+MCP server exited before becoming healthy. Output: ${output().slice(-1_000)}`);
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && body.ok === true) {
        if (Object.hasOwn(body, "autoApprove") && body.autoApprove === false) {
          throw new Error("Mock OAuth+MCP server must report autoApprove=true.");
        }
        return;
      }
      last = response.ok ? JSON.stringify(body) : `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Mock OAuth+MCP server not reachable at ${url}. Last: ${last}. Output: ${output().slice(-1_000)}`);
}

async function waitForEnterpriseHealth(url: string, output: () => string, child: ChildProcess): Promise<string> {
  let last = "unreachable";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Enterprise MCP mock exited before becoming healthy. Output: ${output().slice(-1_000)}`);
    }
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(10_000) });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && isRecord(body) && body.status === "ok" && typeof body.mcpUrl === "string") {
        return body.mcpUrl;
      }
      last = response.ok ? JSON.stringify(body) : `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`Enterprise MCP mock not reachable at ${url}. Last: ${last}. Output: ${output().slice(-1_000)}`);
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function stopProcessGroup(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || !child.pid) return;
  const pid = child.pid;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The process group already exited.
      }
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function startEnterpriseProfileMock(options: StartMockMcpOptions): Promise<MockMcpHandle> {
  if (options.publicUrl) throw new Error("Enterprise MCP provider profiles must be started in the local eval process.");
  if (!options.profileId) throw new Error("An enterprise MCP provider profile id is required.");
  const profileId = options.profileId;
  const port = options.port ?? 3979;
  const url = `http://127.0.0.1:${port}`;
  const runner = join(REPO_ROOT, "packages", "enterprise-mcp-mock-server", "src", "cli.ts");
  let child: ChildProcess | null = null;
  let output = "";
  let redirectUris: readonly string[] = [];
  let mcpUrl = `${url}/mcp`;
  const boot = async (): Promise<void> => {
    output = "";
    const active = spawn("pnpm", ["--filter", "@openwork/enterprise-mcp-mock-server", "exec", "tsx", runner], {
      cwd: REPO_ROOT,
      detached: true,
      env: {
        ...process.env,
        PORT: String(port),
        PROFILE_ID: profileId,
        ...(options.fault !== undefined ? { ACTIVE_FAULT_ID: options.fault } : {}),
        OAUTH_CLIENT_SECRET: options.oauthClientSecret ?? "enterprise-mcp-eval-client-secret",
        OAUTH_REDIRECT_URIS: redirectUris.join(","),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = active;
    active.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    active.stderr?.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    mcpUrl = await waitForEnterpriseHealth(url, () => output, active);
  };
  await boot();
  const stop = async (): Promise<void> => {
    const active = child;
    child = null;
    await stopProcessGroup(active);
  };
  return {
    url,
    mcpUrl,
    async requests() {
      return [];
    },
    async toolCalls(opts = {}) {
      if ((opts.atLeast ?? 0) > 0) await sleep(opts.timeoutMs ?? 120_000);
      return [];
    },
    async agentRequests(opts = {}) {
      if ((opts.atLeast ?? 0) > 0) await sleep(opts.timeoutMs ?? 120_000);
      return [];
    },
    async handshakes(opts = {}) {
      if ((opts.atLeast ?? 0) > 0) await sleep(opts.timeoutMs ?? 120_000);
      return [];
    },
    async authorizeRequestSince(iso) {
      throw new Error(`Enterprise profile request logs do not retain OAuth query parameters after ${iso}.`);
    },
    async configureOAuthRedirectUris(nextRedirectUris) {
      await stop();
      redirectUris = [...nextRedirectUris];
      await boot();
    },
    async resetOAuth() {
      await stop();
      await boot();
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

export async function startMockMcp(options: StartMockMcpOptions = {}): Promise<MockMcpHandle> {
  if (options.profileId) return startEnterpriseProfileMock(options);
  const port = options.port ?? 3979;
  const externalUrl = options.publicUrl ? trimTrailingSlashes(options.publicUrl.trim()) : undefined;
  const localUrl = `http://127.0.0.1:${port}`;
  const url = externalUrl || localUrl;
  let child: ChildProcess | null = null;
  let output = "";

  if (!externalUrl) {
    child = spawn(process.execPath, [options.scriptPath ?? join(REPO_ROOT, "scripts", "mock-oauth-mcp-server.mjs")], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOST: "0.0.0.0",
        PORT: String(port),
        ISSUER: options.issuer ?? url,
        AUTO_APPROVE: "1",
        ...(options.allowUnauthenticatedMcp ? { MOCK_ALLOW_UNAUTHENTICATED_MCP: "1" } : {}),
        ...(options.extraToolCount ? { MOCK_EXTRA_TOOL_COUNT: String(options.extraToolCount) } : {}),
        ...(options.appToolName ? { MOCK_APP_TOOL_NAME: options.appToolName } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += String(chunk);
    });
  }

  await waitForHealth(url, () => output, child);

  if (options.tools) {
    const response = await fetch(`${url}/admin/tools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tools: options.tools }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Mock tool configuration failed: HTTP ${response.status}`);
  }

  if (options.agentWorkloads) {
    const response = await fetch(`${url}/admin/agent-workloads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workloads: options.agentWorkloads }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Mock agent workload configuration failed: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
    }
  }

  const requests = async (): Promise<MockAuthorizeRequest[]> => {
    const response = await fetch(`${url}/requests`, { signal: AbortSignal.timeout(15_000) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Mock request log failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
    return parseRequests(body);
  };
  const stop = async (): Promise<void> => {
    const active = child;
    child = null;
    await stopChild(active);
  };

  const rawEntries = async (): Promise<Record<string, unknown>[]> => {
    const response = await fetch(`${url}/requests`, { signal: AbortSignal.timeout(15_000) });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Mock request log failed: HTTP ${response.status}`);
    return isRecord(body) && Array.isArray(body.requests) ? body.requests.filter(isRecord) : [];
  };

  const readToolCalls = async (name?: string, sinceIso?: string): Promise<MockToolCall[]> => {
    const calls: MockToolCall[] = [];
    for (const entry of await rawEntries()) {
      if (!Array.isArray(entry.toolCalls)) continue;
      const at = typeof entry.at === "string" ? entry.at : "";
      if (sinceIso && at < sinceIso) continue;
      for (const call of entry.toolCalls) {
        if (!isRecord(call) || typeof call.name !== "string") continue;
        if (name && call.name !== name) continue;
        calls.push({
          name: call.name,
          args: isRecord(call.args) ? call.args : {},
          tokenId: typeof call.tokenId === "string" ? call.tokenId : null,
          at,
        });
      }
    }
    return calls;
  };

  const readAgentRequests = async (promptMarker?: string, sinceIso?: string): Promise<MockAgentRequest[]> => {
    const completions: MockAgentRequest[] = [];
    for (const entry of await rawEntries()) {
      if (!isRecord(entry.agentCompletion)) continue;
      const completion = entry.agentCompletion;
      const at = typeof entry.at === "string" ? entry.at : "";
      if (sinceIso && at < sinceIso) continue;
      const kind = completion.kind;
      if (kind !== "utility" && kind !== "tool" && kind !== "final" && kind !== "error" && kind !== "quiet") continue;
      const marker = typeof completion.promptMarker === "string" ? completion.promptMarker : null;
      if (promptMarker && marker !== promptMarker) continue;
      if (typeof completion.model !== "string"
        || !Array.isArray(completion.matchedMarkers)
        || typeof completion.completedTools !== "number") continue;
      completions.push({
        model: completion.model,
        promptMarker: marker,
        matchedMarkers: completion.matchedMarkers.filter((value): value is string => typeof value === "string"),
        completedTools: completion.completedTools,
        kind,
        toolName: typeof completion.toolName === "string" ? completion.toolName : null,
        arguments: isRecord(completion.arguments) ? completion.arguments : {},
        at,
      });
    }
    return completions;
  };

  const readHandshakes = async (sinceIso?: string): Promise<MockAuthorizeRequest[]> => {
    const handshakes: MockAuthorizeRequest[] = [];
    for (const entry of await rawEntries()) {
      if (!Array.isArray(entry.rpcMethods) || !entry.rpcMethods.includes("initialize")) continue;
      const request = parseRequest(entry);
      if (!request || (sinceIso && request.at < sinceIso)) continue;
      handshakes.push(request);
    }
    return handshakes;
  };

  return {
    url,
    mcpUrl: `${url}/mcp`,
    requests,
    async toolCalls(opts = {}) {
      const wanted = opts.atLeast ?? 0;
      if (wanted <= 0) return readToolCalls(opts.name, opts.sinceIso);
      // The engine invokes tools asynchronously after the model decides to, so
      // poll rather than read once.
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      let calls = await readToolCalls(opts.name, opts.sinceIso);
      while (calls.length < wanted && Date.now() < deadline) {
        await sleep(1_000);
        // A slow or aborted log read is a retryable poll attempt, not the
        // verdict; only the deadline decides.
        calls = await readToolCalls(opts.name, opts.sinceIso).catch(() => calls);
      }
      return calls;
    },
    async agentRequests(opts = {}) {
      const wanted = opts.atLeast ?? 0;
      if (wanted <= 0) return readAgentRequests(opts.promptMarker, opts.sinceIso);
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      let completions = await readAgentRequests(opts.promptMarker, opts.sinceIso);
      while (completions.length < wanted && Date.now() < deadline) {
        await sleep(500);
        completions = await readAgentRequests(opts.promptMarker, opts.sinceIso).catch(() => completions);
      }
      return completions;
    },
    async handshakes(opts = {}) {
      const wanted = opts.atLeast ?? 0;
      if (wanted <= 0) return readHandshakes(opts.sinceIso);
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      let handshakes: MockAuthorizeRequest[] = [];
      while (handshakes.length < wanted && Date.now() < deadline) {
        try {
          handshakes = await readHandshakes(opts.sinceIso);
        } catch {
          // A bounded request-log read can fail transiently while a remote mock recovers.
        }
        if (handshakes.length < wanted) await sleep(1_000);
      }
      return handshakes;
    },
    async authorizeRequestSince(iso, opts = {}) {
      const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
      while (Date.now() < deadline) {
        const request = (await requests()).find((entry) => entry.method === "GET" && entry.path === "/authorize" && entry.at >= iso);
        if (request) return { ...request, params: new URL(request.url, url).searchParams };
        await sleep(500);
      }
      throw new Error(`No GET /authorize reached the mock IdP after ${iso}. Output: ${output.slice(-1_000)}`);
    },
    async configureOAuthRedirectUris() {
      throw new Error("The legacy mock must receive preregistered redirect URIs before startup.");
    },
    async resetOAuth() {
      const response = await fetch(`${url}/admin/expire-oauth-tokens`, { method: "POST" });
      if (!response.ok) throw new Error(`Mock OAuth reset failed: HTTP ${response.status}`);
    },
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
