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
  /** Streamable HTTP session that served the tool call. */
  sessionId: string | null;
  /** When the connector served it (the mock's clock). */
  at: string;
}

/** One MCP initialize request observed by the connector. */
export interface MockMcpHandshake {
  atIso: string;
  tokenId: string | null;
  sessionId: string | null;
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
  /** Initialize handshakes, with the same bounded polling and sinceIso contract as toolCalls(). */
  handshakes(opts?: { timeoutMs?: number; atLeast?: number; sinceIso?: string }): Promise<MockMcpHandshake[]>;
  /** Make every currently-issued Streamable HTTP session unknown to the mock. */
  invalidateSessions(): Promise<number>;
  stop(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface StartMockMcpOptions {
  port?: number;
  scriptPath?: string;
  publicUrl?: string;
}

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
      const response = await fetch(`${url}/health`);
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

export async function startMockMcp(options: StartMockMcpOptions = {}): Promise<MockMcpHandle> {
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
        ISSUER: url,
        AUTO_APPROVE: "1",
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

  const requests = async (): Promise<MockAuthorizeRequest[]> => {
    const response = await fetch(`${url}/requests`);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`Mock request log failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
    return parseRequests(body);
  };
  const stop = async (): Promise<void> => {
    const active = child;
    child = null;
    if (!active || active.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        active.kill("SIGKILL");
        resolve();
      }, 5_000);
      active.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      active.kill("SIGTERM");
    });
  };

  const rawEntries = async (): Promise<Record<string, unknown>[]> => {
    const response = await fetch(`${url}/requests`);
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
          sessionId: typeof call.sessionId === "string" ? call.sessionId : null,
          at,
        });
      }
    }
    return calls;
  };

  const readHandshakes = async (sinceIso?: string): Promise<MockMcpHandshake[]> => {
    const handshakes: MockMcpHandshake[] = [];
    for (const entry of await rawEntries()) {
      if (!Array.isArray(entry.handshakes)) continue;
      for (const handshake of entry.handshakes) {
        if (!isRecord(handshake) || typeof handshake.atIso !== "string") continue;
        if (sinceIso && handshake.atIso < sinceIso) continue;
        handshakes.push({
          atIso: handshake.atIso,
          tokenId: typeof handshake.tokenId === "string" ? handshake.tokenId : null,
          sessionId: typeof handshake.sessionId === "string" ? handshake.sessionId : null,
        });
      }
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
        calls = await readToolCalls(opts.name, opts.sinceIso);
      }
      return calls;
    },
    async handshakes(opts = {}) {
      const wanted = opts.atLeast ?? 0;
      if (wanted <= 0) return readHandshakes(opts.sinceIso);
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      let handshakes = await readHandshakes(opts.sinceIso);
      while (handshakes.length < wanted && Date.now() < deadline) {
        await sleep(1_000);
        handshakes = await readHandshakes(opts.sinceIso);
      }
      return handshakes;
    },
    async invalidateSessions() {
      const response = await fetch(`${url}/admin/invalidate-mcp-sessions`, { method: "POST" });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok || !isRecord(body) || typeof body.invalidated !== "number") {
        throw new Error(`Mock session invalidation failed: HTTP ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
      }
      return body.invalidated;
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
    stop,
    [Symbol.asyncDispose]: stop,
  };
}
