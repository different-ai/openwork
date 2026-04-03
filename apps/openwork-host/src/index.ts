import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createOpencode,
  createOpencodeClient,
  type Event as OpencodeEvent,
  type Message as OpencodeMessage,
  type Part as OpencodePart,
  type Session as OpencodeSession,
  type SessionStatus as OpencodeSessionStatus,
} from "@opencode-ai/sdk/v2";

type Role = "user" | "assistant" | "error";

type Message = {
  id: string;
  role: Role;
  text: string;
  createdAt: string;
};

type SessionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  active: boolean;
};

type ServerEvent =
  | { type: "ready" }
  | { type: "sessions.changed"; sessionID?: string }
  | { type: "messages.changed"; sessionID: string }
  | { type: "run.failed"; sessionID?: string; error: string };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type OpenworkHostHandle = {
  url: string;
  workspaceDir: string;
  opencodeUrl: string;
  close: () => Promise<void>;
};

export type StartOpenworkHostOptions = {
  port?: number;
  workspaceDir?: string;
};

function now(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  process.stdout.write(`[openwork-host] ${message}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function unwrapData<T>(result: { data?: T; error?: unknown }): T {
  if (result.error) {
    throw new Error(typeof result.error === "string" ? result.error : JSON.stringify(result.error));
  }
  if (result.data === undefined) {
    throw new Error("Missing response data");
  }
  return result.data;
}

async function readJson(req: IncomingMessage): Promise<Record<string, Json>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, Json>;
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function localServerHeaders(): Record<string, string> | undefined {
  const password = process.env.OPENCODE_SERVER_PASSWORD?.trim();
  if (!password) return undefined;
  const username = process.env.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
  return { Authorization: basicAuthHeader(username, password) };
}

function requestArgs<T extends Record<string, unknown>>(workspaceDir: string, input?: T): T & { directory: string } {
  return { ...(input ?? {}), directory: workspaceDir } as T & { directory: string };
}

function resolveWorkspacePath(workspaceDir: string, input: Json): string {
  const relative = typeof input === "string" && input.length > 0 ? input : ".";
  const resolved = path.resolve(workspaceDir, relative);
  const normalizedRoot = `${workspaceDir}${path.sep}`;
  if (resolved !== workspaceDir && !resolved.startsWith(normalizedRoot)) {
    throw new Error("Path escapes workspace root");
  }
  return resolved;
}

function isSessionActive(status: OpencodeSessionStatus | undefined): boolean {
  return status?.type === "busy" || status?.type === "retry";
}

function toSessionSummary(session: OpencodeSession, statuses: Record<string, OpencodeSessionStatus>): SessionSummary {
  return {
    id: session.id,
    title: session.title || "Untitled chat",
    createdAt: new Date(session.time.created).toISOString(),
    updatedAt: new Date(session.time.updated).toISOString(),
    active: isSessionActive(statuses[session.id]),
  };
}

function partText(part: OpencodePart): string {
  if (part.type === "text") return part.text;
  if (part.type === "tool" && part.state.status === "error") {
    return `Tool ${part.tool} failed: ${part.state.error}`;
  }
  return "";
}

function messageText(info: OpencodeMessage, parts: OpencodePart[]): string {
  const text = parts
    .map((part) => partText(part))
    .filter((value) => value.length > 0)
    .join("");
  if (text.trim()) return text;
  if (info.role === "assistant" && info.error) {
    if (typeof info.error === "string") return info.error;
    if (typeof info.error?.data?.message === "string") return info.error.data.message;
  }
  return "";
}

function toMessage(entry: { info: OpencodeMessage; parts: OpencodePart[] }): Message {
  return {
    id: entry.info.id,
    role: entry.info.role === "assistant" && entry.info.error ? "error" : entry.info.role,
    text: messageText(entry.info, entry.parts),
    createdAt: new Date(entry.info.time.created).toISOString(),
  };
}

export async function startOpenworkHost(options: StartOpenworkHostOptions = {}): Promise<OpenworkHostHandle> {
  const port = options.port ?? Number(process.env.PORT ?? "8787");
  const workspaceDir = path.resolve(options.workspaceDir ?? process.env.OPENWORK_HOST_WORKSPACE_DIR ?? process.env.WORKSPACE_DIR ?? process.cwd());
  const sseClients = new Set<ServerResponse>();
  let eventID = 0;
  let eventAbort: AbortController | null = null;
  let disposed = false;

  const opencode = await createOpencode({ hostname: "127.0.0.1", port: 0 });
  const client = createOpencodeClient({ baseUrl: opencode.server.url, headers: localServerHeaders() });
  const health = await client.global.health();
  if (health.error || health.data?.healthy !== true) {
    throw new Error(typeof health.error === "string" ? health.error : "Embedded opencode health check failed");
  }

  async function listSessionSummaries(): Promise<SessionSummary[]> {
    const [listResult, statusResult] = await Promise.all([
      client.session.list(requestArgs(workspaceDir, { roots: true, limit: 100 })),
      client.session.status(requestArgs(workspaceDir)),
    ]);
    const sessions = unwrapData(listResult as { data?: OpencodeSession[]; error?: unknown });
    const statuses = unwrapData(statusResult as { data?: Record<string, OpencodeSessionStatus>; error?: unknown });
    return sessions.map((session) => toSessionSummary(session, statuses));
  }

  async function listSessionMessages(sessionID: string): Promise<Message[]> {
    const result = await client.session.messages(requestArgs(workspaceDir, { sessionID, limit: 200 }));
    const messages = unwrapData(result as { data?: Array<{ info: OpencodeMessage; parts: OpencodePart[] }>; error?: unknown });
    return messages.map((entry) => toMessage(entry));
  }

  function emit(event: ServerEvent): void {
    const payload = `id: ${++eventID}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const sseClient of sseClients) sseClient.write(payload);
  }

  function relayOpencodeEvent(event: OpencodeEvent): void {
    if (event.type === "session.created" || event.type === "session.updated" || event.type === "session.deleted") {
      emit({ type: "sessions.changed", sessionID: event.properties.info.id });
      return;
    }

    if (event.type === "session.status" || event.type === "session.idle") {
      emit({ type: "sessions.changed", sessionID: event.properties.sessionID });
      return;
    }

    if (event.type === "message.updated") {
      emit({ type: "messages.changed", sessionID: event.properties.info.sessionID });
      return;
    }

    if (event.type === "message.part.updated") {
      emit({ type: "messages.changed", sessionID: event.properties.part.sessionID });
      return;
    }

    if (event.type === "message.part.removed") {
      emit({ type: "messages.changed", sessionID: event.properties.sessionID });
      return;
    }

    if (event.type === "message.removed") {
      emit({ type: "messages.changed", sessionID: event.properties.sessionID });
      return;
    }

    if (event.type === "session.error") {
      const error = typeof event.properties.error === "string"
        ? event.properties.error
        : typeof event.properties.error?.data?.message === "string"
          ? event.properties.error.data.message
          : event.properties.error?.name || "Unknown error";
      emit({ type: "run.failed", sessionID: event.properties.sessionID, error });
    }
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
    const segments = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/global/health") {
      return sendJson(res, 200, {
        ok: true,
        workspaceDir,
        opencodeUrl: opencode.server.url,
        version: health.data?.version,
      });
    }

    if (req.method === "GET" && url.pathname === "/workspace") {
      return sendJson(res, 200, { id: "single-workspace", path: workspaceDir, mode: "single" });
    }

    if (req.method === "GET" && url.pathname === "/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      res.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/session") {
      return sendJson(res, 200, { sessions: await listSessionSummaries() });
    }

    if (req.method === "POST" && url.pathname === "/session") {
      const body = await readJson(req);
      const result = await client.session.create(
        requestArgs(workspaceDir, {
          title: typeof body.title === "string" ? body.title : undefined,
        }),
      );
      const session = unwrapData(result as { data?: OpencodeSession; error?: unknown });
      const summary: SessionSummary = {
        id: session.id,
        title: session.title || "Untitled chat",
        createdAt: new Date(session.time.created).toISOString(),
        updatedAt: new Date(session.time.updated).toISOString(),
        active: false,
      };
      emit({ type: "sessions.changed", sessionID: session.id });
      return sendJson(res, 200, { session: summary });
    }

    if (segments[0] === "session" && segments[2] === "message" && req.method === "GET") {
      return sendJson(res, 200, { messages: await listSessionMessages(segments[1] ?? "") });
    }

    if (segments[0] === "session" && segments[2] === "prompt_async" && req.method === "POST") {
      const sessionID = segments[1] ?? "";
      const body = await readJson(req);
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      const result = await client.session.promptAsync(
        requestArgs(workspaceDir, {
          sessionID,
          parts: [{ type: "text", text: prompt }],
        }),
      );
      unwrapData(result as { data?: unknown; error?: unknown });
      emit({ type: "sessions.changed", sessionID });
      emit({ type: "messages.changed", sessionID });
      return sendJson(res, 200, { ok: true });
    }

    if (segments[0] === "session" && segments[2] === "abort" && req.method === "POST") {
      const sessionID = segments[1] ?? "";
      const result = await client.session.abort(requestArgs(workspaceDir, { sessionID }));
      unwrapData(result as { data?: unknown; error?: unknown });
      emit({ type: "sessions.changed", sessionID });
      emit({ type: "messages.changed", sessionID });
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/fs/read") {
      const body = await readJson(req);
      const filePath = resolveWorkspacePath(workspaceDir, body.path);
      const content = await readFile(filePath, "utf8");
      return sendJson(res, 200, { path: path.relative(workspaceDir, filePath), content });
    }

    if (req.method === "POST" && url.pathname === "/fs/list") {
      const body = await readJson(req);
      const dirPath = resolveWorkspacePath(workspaceDir, body.path);
      const entries = await readdir(dirPath, { withFileTypes: true });
      const items = await Promise.all(
        entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async (entry) => {
            const entryPath = path.join(dirPath, entry.name);
            const entryStat = await stat(entryPath);
            return {
              name: entry.name,
              path: path.relative(workspaceDir, entryPath),
              type: entry.isDirectory() ? "directory" : "file",
              size: entryStat.size,
            };
          }),
      );
      return sendJson(res, 200, { items });
    }

    if (req.method === "POST" && url.pathname === "/fs/write") {
      const body = await readJson(req);
      const filePath = resolveWorkspacePath(workspaceDir, body.path);
      const content = typeof body.content === "string" ? body.content : "";
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, content, "utf8");
      return sendJson(res, 200, { ok: true, path: path.relative(workspaceDir, filePath) });
    }

    if (req.method === "POST" && url.pathname === "/fs/mkdir") {
      const body = await readJson(req);
      const dirPath = resolveWorkspacePath(workspaceDir, body.path);
      await mkdir(dirPath, { recursive: body.recursive !== false });
      return sendJson(res, 200, { ok: true, path: path.relative(workspaceDir, dirPath) });
    }

    sendJson(res, 404, { error: `Unknown route ${req.method} ${url.pathname}` });
  }

  const server = createServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(res, 500, { error: message });
    });
  });

  eventAbort = new AbortController();
  const stream = await client.event.subscribe(requestArgs(workspaceDir), { signal: eventAbort.signal });
  void (async () => {
    for await (const event of stream.stream as AsyncIterable<OpencodeEvent>) {
      relayOpencodeEvent(event);
      if (eventAbort?.signal.aborted) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  })().catch((error: unknown) => {
    if (!eventAbort?.signal.aborted) {
      log(`event stream failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => resolve());
  });

  log(`embedded opencode ready at ${opencode.server.url}`);
  log(`listening on http://127.0.0.1:${port} for ${workspaceDir}`);

  return {
    url: `http://127.0.0.1:${port}`,
    workspaceDir,
    opencodeUrl: opencode.server.url,
    close: async () => {
      if (disposed) return;
      disposed = true;
      eventAbort?.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      opencode.server.close();
    },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  let handle: OpenworkHostHandle | null = null;

  startOpenworkHost()
    .then((next) => {
      handle = next;
    })
    .catch((error: unknown) => {
      log(`failed to start: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      process.exitCode = 1;
    });

  const shutdown = () => {
    void handle?.close().finally(() => process.exit());
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
