import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

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

export function sendMockError(response: ServerResponse, error: unknown): void {
  console.error("[mock] Request failed", error);
  if (response.headersSent) {
    response.destroy();
    return;
  }
  sendJson(response, 500, { error: "mock_request_failed" });
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

export function stopChild(child: ChildProcess): Promise<void> {
  return new Promise<void>((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  });
}

/**
 * Spawns the openwork-server CLI, which starts OpenCode v2. Every stdout/stderr
 * chunk goes to `sink`; `listening` resolves with the base URL once the server
 * reports its port, or rejects when the process exits first.
 */
export function bootServer(env: NodeJS.ProcessEnv, token: string, workspace: string, sink: (chunk: string) => void, options?: { configPath?: string; preload?: string; entrypoint?: string }): { child: ChildProcess; listening: Promise<string> } {
  const child = spawn("bun", [
    "--conditions=development",
    ...(options?.preload ? ["--preload", options.preload] : []),
    options?.entrypoint ?? "src/cli.ts",
    "--host", "127.0.0.1",
    "--port", "0",
    "--token", token,
    "--host-token", `${token}-host`,
    "--approval", "auto",
    "--cors", "*",
    "--workspace", workspace,
    ...(options?.configPath ? ["--config", options.configPath] : []),
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

export type EngineModel = { providerID: string; id: string; variant?: string };

export interface ManagedOpenworkServer {
  child: ChildProcess;
  base: string;
  workspaceId: string;
  /** OpenCode v2's native API through the workspace's `/opencode2` mount, e.g. `engine("GET", "/api/model")`. */
  engine(method: string, path: string, body?: unknown): Promise<unknown>;
  /** A new session located in the workspace folder. */
  createSession(title?: string): Promise<string>;
  /** Selects `model`, sends one prompt, and returns the native transcript (oldest first) once the session is idle again. */
  prompt(sessionId: string, model: EngineModel, text: string): Promise<Record<string, unknown>[]>;
  stop(): Promise<void>;
}

function firstWorkspaceId(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  const first = value.items[0];
  return isRecord(first) && typeof first.id === "string" ? first.id : null;
}

/**
 * An explicit engine binary for a server spawned with a filtered environment;
 * empty when unset, so the server resolves opencode2 itself.
 */
export function engineBinaryEnv(): Record<string, string> {
  const engineBin = process.env.OPENWORK_OPENCODE2_BIN?.trim();
  return engineBin ? { OPENWORK_OPENCODE2_BIN: engineBin } : {};
}

/** OpenCode v2 wraps every response body in `{ data }`. */
export function engineData(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

export async function bootManagedOpenworkServer(options: {
  scratch: string;
  workspace: string;
  token: string;
  sink: (chunk: string) => void;
  env?: Record<string, string>;
  configPath?: string;
  preload?: string;
}): Promise<ManagedOpenworkServer> {
  const home = join(options.scratch, "home");
  await mkdir(home, { recursive: true });
  // The spec may itself run under an OpenWork or OpenCode session. The parent's
  // OPENCODE_* and OPENWORK_* variables (config path, models URL, credentials,
  // workspaces) must not reach the isolated server and engine under test. Only
  // an explicit engine binary passes; otherwise the server resolves its own.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENCODE") && !key.startsWith("OPENWORK_")));
  const env = {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    ...engineBinaryEnv(),
    ...options.env,
  };

  let output = "";
  const sink = (chunk: string) => {
    output += chunk;
    options.sink(chunk);
  };
  const booted = bootServer(env, options.token, options.workspace, sink, options);
  const child = booted.child;

  try {
    const base = await booted.listening;
    const headers = { authorization: `Bearer ${options.token}`, "content-type": "application/json" };
    const workspaces: unknown = await (await fetch(`${base}/workspaces`, { headers })).json();
    const workspaceId = firstWorkspaceId(workspaces);
    if (!workspaceId) throw new Error(`openwork-server reported no workspace: ${JSON.stringify(workspaces)}`);
    const mount = `${base}/workspace/${encodeURIComponent(workspaceId)}/opencode2`;

    const engine = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(`${mount}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 400)}`);
      return text ? JSON.parse(text) : null;
    };

    // OpenCode v2 starts after the HTTP server binds and may first resolve or
    // download its pinned binary, so give the first proxied call time.
    const deadline = Date.now() + 180_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      try {
        const response = await fetch(`${mount}/api/session`, { headers, signal: AbortSignal.timeout(5_000) });
        ready = response.ok;
      } catch {
        // keep polling
      }
      if (!ready) await new Promise((wait) => setTimeout(wait, 500));
    }
    if (!ready) throw new Error(`OpenCode v2 never answered through openwork-server:\n${output.slice(-3_000)}`);

    // Native pages are newest first; only user and assistant rows are turns.
    const transcript = async (sessionId: string): Promise<Record<string, unknown>[]> => {
      const rows = engineData(await engine("GET", `/api/session/${encodeURIComponent(sessionId)}/message?limit=200`));
      return Array.isArray(rows) ? rows.filter(isRecord).filter((row) => row.type === "user" || row.type === "assistant").reverse() : [];
    };

    const createSession = async (title?: string): Promise<string> => {
      const created = engineData(await engine("POST", "/api/session", { location: { directory: options.workspace }, ...(title === undefined ? {} : { title }) }));
      if (!isRecord(created) || typeof created.id !== "string") throw new Error(`OpenCode v2 did not create a session: ${JSON.stringify(created)}`);
      return created.id;
    };

    const prompt = async (sessionId: string, model: EngineModel, text: string): Promise<Record<string, unknown>[]> => {
      const path = `/api/session/${encodeURIComponent(sessionId)}`;
      const before = (await transcript(sessionId)).length;
      // Workspace config providers reach the catalog asynchronously.
      const listedBy = Date.now() + 45_000;
      for (;;) {
        const models = engineData(await engine("GET", "/api/model"));
        if (Array.isArray(models) && models.some((entry) => isRecord(entry) && entry.providerID === model.providerID && entry.id === model.id)) break;
        if (Date.now() > listedBy) throw new Error(`OpenCode v2 never listed ${model.providerID}/${model.id}: ${JSON.stringify(models).slice(0, 800)}`);
        await new Promise((wait) => setTimeout(wait, 250));
      }
      await engine("POST", `${path}/model`, { model });
      await engine("POST", `${path}/prompt`, { text });
      // Settled: the session left the active list and an assistant turn follows the new prompt.
      const settleBy = Date.now() + 90_000;
      for (;;) {
        const active = engineData(await engine("GET", "/api/session/active"));
        const status = isRecord(active) ? active[sessionId] : undefined;
        const running = isRecord(status) && status.type === "running";
        const messages = await transcript(sessionId);
        if (!running && messages.length > before + 1 && messages.at(-1)?.type === "assistant") return messages;
        if (Date.now() > settleBy) throw new Error(`Session ${sessionId} did not settle: ${JSON.stringify(messages).slice(-800)}`);
        await new Promise((wait) => setTimeout(wait, 250));
      }
    };

    return {
      child,
      base,
      workspaceId,
      engine,
      createSession,
      prompt,
      stop: () => stopChild(child),
    };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}
