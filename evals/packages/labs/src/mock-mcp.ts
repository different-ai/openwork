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

export interface MockMcpHandle {
  url: string;
  mcpUrl: string;
  authorizeRequestSince(iso: string, opts?: { timeoutMs?: number }): Promise<MockAuthorizeRequest & { params: URLSearchParams }>;
  requests(): Promise<MockAuthorizeRequest[]>;
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
    if (child?.exitCode !== null) {
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

  return {
    url,
    mcpUrl: `${url}/mcp`,
    requests,
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
