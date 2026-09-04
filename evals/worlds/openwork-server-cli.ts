import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { SkipError } from "@openwork/env";

const repoRoot = resolve(import.meta.dirname, "../..");
const serverRoot = join(repoRoot, "apps", "server");

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => resolveBody(body));
    request.on("error", reject);
  });
}

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export function sendStream(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

export async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
}

export function engineBinary(): string | null {
  const fromEnv = process.env.OPENWORK_OPENCODE_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const platform = process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : "unknown-linux-gnu";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const sidecar = join(repoRoot, "apps", "desktop", "resources", "sidecars", `opencode-${arch}-${platform}${process.platform === "win32" ? ".exe" : ""}`);
  if (existsSync(sidecar)) return sidecar;
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" });
  const found = onPath.status === 0 ? onPath.stdout.split(/\r?\n/).find((line) => line.trim()) : undefined;
  return found ? found.trim() : null;
}

export function stopChild(child: ChildProcess): Promise<void> {
  return new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}

/**
 * Spawns the openwork-server CLI with a managed engine. Every stdout/stderr
 * chunk goes to `sink`; `listening` resolves with the base URL once the server
 * reports its port, or rejects when the process exits first.
 */
export function bootServer(env: NodeJS.ProcessEnv, token: string, workspace: string, sink: (chunk: string) => void): { child: ChildProcess; listening: Promise<string> } {
  const child = spawn("bun", [
    "--conditions=development",
    "src/cli.ts",
    "--host", "127.0.0.1",
    "--port", "0",
    "--token", token,
    "--host-token", `${token}-host`,
    "--approval", "auto",
    "--cors", "*",
    "--workspace", workspace,
  ], { cwd: serverRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let seen = "";
  const listening = new Promise<string>((resolveBase, reject) => {
    const timer = setTimeout(() => reject(new Error(`openwork-server did not report a port within 60s:\n${seen.slice(-2_000)}`)), 60_000);
    const onChunk = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      seen += text;
      sink(text);
      const match = seen.match(/OpenWork server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match?.[1]) {
        clearTimeout(timer);
        resolveBase(match[1]);
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`openwork-server exited early (code ${code}):\n${seen.slice(-2_000)}`));
    });
    child.on("error", reject);
  });
  return { child, listening };
}

export interface ManagedOpenworkServer {
  child: ChildProcess;
  base: string;
  binary: string;
  workspaceId: string;
  engine(method: string, path: string, body?: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

function firstWorkspaceId(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const first = value.items[0];
  return isRecord(first) && typeof first.id === "string" ? first.id : null;
}

export async function bootManagedOpenworkServer(options: {
  scratch: string;
  workspace: string;
  token: string;
  sink: (chunk: string) => void;
  binary?: string;
}): Promise<ManagedOpenworkServer> {
  const binary = options.binary ?? engineBinary();
  if (!binary) throw new SkipError("set OPENWORK_OPENCODE_BIN or install opencode");

  const home = join(options.scratch, "home");
  await mkdir(home, { recursive: true });
  // The spec may itself run under an OpenWork or OpenCode session. The parent's
  // OPENCODE_* and OPENWORK_* variables (config path, models URL, credentials,
  // workspaces) must not reach the isolated server and engine under test.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE") && !key.startsWith("OPENWORK_")));
  const env = {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENWORK_MANAGE_OPENCODE: "1",
    OPENWORK_OPENCODE_BIN: binary,
  };

  let output = "";
  const sink = (chunk: string) => {
    output += chunk;
    options.sink(chunk);
  };
  let child: ChildProcess | null = null;

  try {
    // The server spawns the managed engine with a fixed 15 s start budget; a slow
    // moment on a fresh profile (plugin runtime install, cold transpile) can
    // exceed it once and exit the server. Boot at most twice; the first attempt's
    // output stays in the diagnostics.
    let base = "";
    for (let attempt = 1; ; attempt += 1) {
      const booted = bootServer(env, options.token, options.workspace, sink);
      child = booted.child;
      try {
        base = await booted.listening;
        break;
      } catch (error) {
        await stopChild(booted.child);
        child = null;
        sink(`\n[world] boot attempt ${attempt} failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}\n`);
        if (attempt >= 2 || !(error instanceof Error && error.message.startsWith("openwork-server exited early"))) throw error;
      }
    }

    const headers = { authorization: `Bearer ${options.token}`, "content-type": "application/json" };
    const workspaces: unknown = await (await fetch(`${base}/workspaces`, { headers })).json();
    const workspaceId = firstWorkspaceId(workspaces);
    if (!workspaceId) throw new Error(`openwork-server reported no workspace: ${JSON.stringify(workspaces)}`);

    const engine = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`${base}/workspace/${encodeURIComponent(workspaceId)}/opencode${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
      return text ? JSON.parse(text) : null;
    };

    // The managed engine starts after the HTTP server binds; on a fresh profile it
    // first installs its plugin runtime, so give the first proxied call time.
    const deadline = Date.now() + 150_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/workspace/${encodeURIComponent(workspaceId)}/opencode/session`, { headers, signal: AbortSignal.timeout(5_000) });
        ready = response.ok;
      } catch {
        // keep polling
      }
      if (!ready) await new Promise((wait) => setTimeout(wait, 500));
    }
    if (!ready) throw new Error(`The managed engine never answered through openwork-server:\n${output.slice(-3_000)}`);

    const runningChild = child;
    return {
      child: runningChild,
      base,
      binary,
      workspaceId,
      engine,
      stop: () => stopChild(runningChild),
    };
  } catch (error) {
    if (child) await stopChild(child);
    throw error;
  }
}
