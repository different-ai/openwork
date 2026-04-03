import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { registerFauxProvider, fauxAssistantMessage } from "@mariozechner/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";

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

type SessionRecord = SessionSummary & {
  session: AgentSession;
  messages: Message[];
  activeAssistantMessageID: string | null;
};

type ServerEvent =
  | { type: "session.created"; session: SessionSummary }
  | { type: "session.updated"; session: SessionSummary }
  | { type: "message.created"; sessionID: string; message: Message }
  | { type: "message.delta"; sessionID: string; messageID: string; delta: string }
  | { type: "run.finished"; sessionID: string }
  | { type: "run.failed"; sessionID: string; error: string };

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const port = Number(process.env.PORT ?? "8787");
const workspaceDir = path.resolve(process.env.OPENWORK_HOST_WORKSPACE_DIR ?? process.env.WORKSPACE_DIR ?? process.cwd());
const sessions = new Map<string, SessionRecord>();
const sseClients = new Set<ServerResponse>();
let eventID = 0;

const authStorage = AuthStorage.create(path.join(workspaceDir, ".openwork-host-auth.json"));
authStorage.setRuntimeApiKey("faux" as Parameters<typeof authStorage.setRuntimeApiKey>[0], "local-faux-key");
for (const [provider, key] of [
  ["anthropic", process.env.ANTHROPIC_API_KEY],
  ["openai", process.env.OPENAI_API_KEY],
  ["google", process.env.GOOGLE_API_KEY],
  ["xai", process.env.XAI_API_KEY],
] as const) {
  if (key) authStorage.setRuntimeApiKey(provider as Parameters<typeof authStorage.setRuntimeApiKey>[0], key);
}
const modelRegistry = ModelRegistry.inMemory(authStorage);
const fauxProvider = registerFauxProvider({ tokensPerSecond: 60 });
const availableModels = modelRegistry.getAvailable();
const runtimeModel = availableModels[0] ?? fauxProvider.getModel();
const usingFaux = runtimeModel.provider === fauxProvider.models[0].provider && runtimeModel.id === fauxProvider.models[0].id;

function now(): string {
  return new Date().toISOString();
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, Json>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, Json>;
}

function emit(event: ServerEvent): void {
  const payload = `id: ${++eventID}\ndata: ${JSON.stringify(event)}\n\n`;
  for (const client of sseClients) client.write(payload);
}

function listSessions(): SessionSummary[] {
  return [...sessions.values()]
    .map(({ session, messages, activeAssistantMessageID, ...summary }) => summary)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getSession(sessionID: string): SessionRecord {
  const session = sessions.get(sessionID);
  if (!session) throw new Error(`Unknown session ${sessionID}`);
  return session;
}

function resolveWorkspacePath(input: Json): string {
  const relative = typeof input === "string" && input.length > 0 ? input : ".";
  const resolved = path.resolve(workspaceDir, relative);
  const normalizedRoot = `${workspaceDir}${path.sep}`;
  if (resolved !== workspaceDir && !resolved.startsWith(normalizedRoot)) {
    throw new Error("Path escapes workspace root");
  }
  return resolved;
}

function summarize(record: SessionRecord): SessionSummary {
  return {
    id: record.id,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    active: record.active,
  };
}

function createReply(prompt: string): string {
  const trimmed = prompt.trim();
  const preview = trimmed.length > 500 ? `${trimmed.slice(0, 500)}...` : trimmed;
  return [
    `Workspace: ${path.basename(workspaceDir)}`,
    "",
    "PI faux runtime is active in this branch, so this response is deterministic but still streamed through the real PI session runtime.",
    "",
    "You said:",
    preview || "(empty prompt)",
  ].join("\n");
}

function bindSession(record: SessionRecord): void {
  record.session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const message = record.activeAssistantMessageID
        ? record.messages.find((entry) => entry.id === record.activeAssistantMessageID)
        : undefined;
      if (!message) return;
      message.text += event.assistantMessageEvent.delta;
      record.updatedAt = now();
      emit({
        type: "message.delta",
        sessionID: record.id,
        messageID: message.id,
        delta: event.assistantMessageEvent.delta,
      });
      emit({ type: "session.updated", session: summarize(record) });
      return;
    }

    if (event.type === "agent_end") {
      record.active = false;
      record.activeAssistantMessageID = null;
      record.updatedAt = now();
      process.stdout.write(`[openwork-host] prompt finished ${record.id}\n`);
      emit({ type: "run.finished", sessionID: record.id });
      emit({ type: "session.updated", session: summarize(record) });
    }
  });
}

async function createSession(titleInput?: string): Promise<SessionRecord> {
  const { session } = await createAgentSession({
    cwd: workspaceDir,
    model: runtimeModel,
    authStorage,
    modelRegistry,
    sessionManager: SessionManager.inMemory(),
  });
  const createdAt = now();
  const title = typeof titleInput === "string" && titleInput.trim() ? titleInput.trim() : `Chat ${sessions.size + 1}`;
  await session.setSessionName(title);
  const record: SessionRecord = {
    id: session.sessionId,
    title,
    createdAt,
    updatedAt: createdAt,
    active: false,
    session,
    messages: [],
    activeAssistantMessageID: null,
  };
  bindSession(record);
  sessions.set(record.id, record);
  process.stdout.write(`[openwork-host] created session ${record.id} (${record.title})\n`);
  emit({ type: "session.created", session: summarize(record) });
  return record;
}

async function handlePrompt(record: SessionRecord, prompt: string): Promise<void> {
  if (record.active) throw new Error("Session is already running");
  process.stdout.write(`[openwork-host] prompt start ${record.id}\n`);
  const createdAt = now();
  const userMessage: Message = { id: randomUUID(), role: "user", text: prompt, createdAt };
  const assistantMessage: Message = { id: randomUUID(), role: "assistant", text: "", createdAt };
  record.messages.push(userMessage, assistantMessage);
  record.active = true;
  record.activeAssistantMessageID = assistantMessage.id;
  record.updatedAt = createdAt;
  emit({ type: "message.created", sessionID: record.id, message: userMessage });
  emit({ type: "message.created", sessionID: record.id, message: assistantMessage });
  emit({ type: "session.updated", session: summarize(record) });

  if (usingFaux) {
    fauxProvider.appendResponses([() => fauxAssistantMessage(createReply(prompt))]);
  }

  void record.session.prompt(prompt).catch((error: unknown) => {
    record.active = false;
    record.activeAssistantMessageID = null;
    record.updatedAt = now();
    const text = error instanceof Error ? error.message : String(error);
    const message: Message = { id: randomUUID(), role: "error", text, createdAt: now() };
    record.messages.push(message);
    emit({ type: "message.created", sessionID: record.id, message });
    emit({ type: "run.failed", sessionID: record.id, error: text });
    emit({ type: "session.updated", session: summarize(record) });
    process.stdout.write(`[openwork-host] prompt failed ${record.id}: ${text}\n`);
  });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
  const segments = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/global/health") {
    return sendJson(res, 200, { ok: true, workspaceDir });
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
    return sendJson(res, 200, { sessions: listSessions() });
  }

  if (req.method === "POST" && url.pathname === "/session") {
    const body = await readJson(req);
    const session = await createSession(typeof body.title === "string" ? body.title : undefined);
    return sendJson(res, 200, { session: summarize(session) });
  }

  if (segments[0] === "session" && segments[2] === "message" && req.method === "GET") {
    const session = getSession(segments[1] ?? "");
    return sendJson(res, 200, { messages: session.messages });
  }

  if (segments[0] === "session" && segments[2] === "prompt_async" && req.method === "POST") {
    const session = getSession(segments[1] ?? "");
    const body = await readJson(req);
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    await handlePrompt(session, prompt);
    return sendJson(res, 200, { ok: true });
  }

  if (segments[0] === "session" && segments[2] === "abort" && req.method === "POST") {
    const session = getSession(segments[1] ?? "");
    session.active = false;
    session.activeAssistantMessageID = null;
    session.updatedAt = now();
    await session.session.abort();
    emit({ type: "session.updated", session: summarize(session) });
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/fs/read") {
    const body = await readJson(req);
    const filePath = resolveWorkspacePath(body.path);
    const content = await readFile(filePath, "utf8");
    return sendJson(res, 200, { path: path.relative(workspaceDir, filePath), content });
  }

  if (req.method === "POST" && url.pathname === "/fs/list") {
    const body = await readJson(req);
    const dirPath = resolveWorkspacePath(body.path);
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
    const filePath = resolveWorkspacePath(body.path);
    const content = typeof body.content === "string" ? body.content : "";
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return sendJson(res, 200, { ok: true, path: path.relative(workspaceDir, filePath) });
  }

  if (req.method === "POST" && url.pathname === "/fs/mkdir") {
    const body = await readJson(req);
    const dirPath = resolveWorkspacePath(body.path);
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

server.listen(port, () => {
  process.stdout.write(`openwork-host listening on http://127.0.0.1:${port} for ${workspaceDir}\n`);
});
