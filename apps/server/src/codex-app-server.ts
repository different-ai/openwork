import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { runtimeStorageDir } from "./runtime-db.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

export type CodexRpcId = number | string;

export type CodexRpcMessage = {
  id?: CodexRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type CodexAppServerMetadata = {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type MessageListener = (message: CodexRpcMessage) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRpcMessage(line: string): CodexRpcMessage | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) return null;
    const id = typeof parsed.id === "number" || typeof parsed.id === "string" ? parsed.id : undefined;
    const method = typeof parsed.method === "string" ? parsed.method : undefined;
    return {
      ...(id !== undefined ? { id } : {}),
      ...(method ? { method } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, "params") ? { params: parsed.params } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, "result") ? { result: parsed.result } : {}),
      ...(Object.prototype.hasOwnProperty.call(parsed, "error") ? { error: parsed.error } : {}),
    };
  } catch {
    return null;
  }
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return "Unknown Codex app-server error";
  }
}

function metadataFromInitialize(value: unknown): CodexAppServerMetadata {
  if (!isRecord(value)) {
    throw new Error("Codex app-server returned an invalid initialize response");
  }
  const userAgent = typeof value.userAgent === "string" ? value.userAgent : "codex";
  const codexHome = typeof value.codexHome === "string" ? value.codexHome : "";
  const platformFamily = typeof value.platformFamily === "string" ? value.platformFamily : "unknown";
  const platformOs = typeof value.platformOs === "string" ? value.platformOs : "unknown";
  return { userAgent, codexHome, platformFamily, platformOs };
}

function safeWorkspaceSegment(workspaceId: string): string {
  return workspaceId.replace(/[^A-Za-z0-9._-]/g, "_") || "workspace";
}

export class CodexAppServerClient {
  private static readonly REQUEST_TIMEOUT_MS = 30_000;

  private process: ChildProcessWithoutNullStreams | null = null;
  private lines: ReadlineInterface | null = null;
  private startPromise: Promise<void> | null = null;
  private requestId = 0;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<MessageListener>();
  private stderrTail: string[] = [];
  private initializedMetadata: CodexAppServerMetadata | null = null;
  private stopped = false;

  constructor(
    private readonly input: {
      binary: string;
      cwd: string;
      codexHome: string;
      clientVersion: string;
    },
  ) {}

  get running(): boolean {
    return this.process !== null && this.process.exitCode === null && !this.process.killed;
  }

  get metadata(): CodexAppServerMetadata | null {
    return this.initializedMetadata;
  }

  get recentStderr(): string[] {
    return [...this.stderrTail];
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.running && this.initializedMetadata) return;
    if (this.startPromise) return this.startPromise;
    this.stopped = false;
    this.startPromise = this.startProcess().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async startProcess(): Promise<void> {
    await mkdir(this.input.codexHome, { recursive: true, mode: 0o700 });
    const child = spawn(this.input.binary, ["app-server", "--listen", "stdio://"], {
      cwd: this.input.cwd,
      env: {
        ...process.env,
        CODEX_HOME: this.input.codexHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      this.stderrTail.push(...lines);
      if (this.stderrTail.length > 40) this.stderrTail.splice(0, this.stderrTail.length - 40);
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.handleExit(new Error(`Codex app-server exited with ${detail}`));
    });

    try {
      const initialized = await this.request("initialize", {
        clientInfo: {
          name: "openwork",
          title: "OpenWork",
          version: this.input.clientVersion,
        },
        capabilities: null,
      });
      this.initializedMetadata = metadataFromInitialize(initialized);
      this.notify("initialized", {});
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private handleLine(line: string): void {
    const message = parseRpcMessage(line);
    if (!message) return;
    if (message.id !== undefined && !message.method) {
      const key = String(message.id);
      const pending = this.pending.get(key);
      if (!pending) return;
      this.pending.delete(key);
      clearTimeout(pending.timeout);
      if (message.error !== undefined) {
        pending.reject(new Error(errorMessage(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    for (const listener of this.listeners) listener(message);
  }

  private handleExit(error: Error): void {
    if (!this.process) return;
    this.lines?.close();
    this.lines = null;
    this.process = null;
    this.initializedMetadata = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopped) {
      for (const listener of this.listeners) {
        listener({ method: "openwork/processExited", params: { message: error.message } });
      }
    }
  }

  private write(message: CodexRpcMessage): void {
    const child = this.process;
    if (!child || child.stdin.destroyed) {
      throw new Error("Codex app-server is not running");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (method !== "initialize") await this.start();
    const id = ++this.requestId;
    const key = String(id);
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(key)) return;
        reject(new Error(`Codex app-server timed out waiting for ${method}`));
      }, CodexAppServerClient.REQUEST_TIMEOUT_MS);
      this.pending.set(key, { resolve, reject, timeout });
    });
    try {
      this.write({ id, method, params });
    } catch (error) {
      const pending = this.pending.get(key);
      if (pending) clearTimeout(pending.timeout);
      this.pending.delete(key);
      throw error;
    }
    return result;
  }

  respond(id: CodexRpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: CodexRpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.process;
    this.lines?.close();
    this.lines = null;
    this.process = null;
    this.initializedMetadata = null;
    const error = new Error("Codex app-server stopped");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    if (!child) return;
    child.stdin.end();
    child.kill("SIGTERM");
  }
}

export class CodexAppServerManager {
  private clients = new Map<string, CodexAppServerClient>();

  constructor(
    private readonly config: ServerConfig,
    private readonly clientVersion: string,
  ) {}

  clientFor(workspace: WorkspaceInfo): CodexAppServerClient {
    const existing = this.clients.get(workspace.id);
    if (existing) return existing;
    if (workspace.workspaceType !== "local" || !workspace.path.trim()) {
      throw new Error("Codex Server requires a local workspace on the remote worker");
    }
    const codexHome = join(
      runtimeStorageDir(this.config),
      "codex",
      safeWorkspaceSegment(workspace.id),
    );
    const client = new CodexAppServerClient({
      binary: process.env.OPENWORK_CODEX_BIN?.trim() || "codex",
      cwd: workspace.path,
      codexHome,
      clientVersion: this.clientVersion,
    });
    this.clients.set(workspace.id, client);
    return client;
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    const client = this.clients.get(workspaceId);
    if (!client) return;
    this.clients.delete(workspaceId);
    await client.stop();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.stop()));
    this.clients.clear();
  }
}

export async function probeCodexBinary(binary = process.env.OPENWORK_CODEX_BIN?.trim() || "codex"): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Timed out while checking the Codex CLI"));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim() || "codex");
      } else {
        reject(new Error(stderr.trim() || `Codex CLI exited with code ${code ?? "unknown"}`));
      }
    });
  });
}
