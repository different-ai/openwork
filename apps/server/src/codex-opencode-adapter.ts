import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "./agent-runtime-store.js";
import {
  readAgentRuntimeState,
  workspaceUsesCodexRuntime,
  writeAgentRuntimeState,
} from "./agent-runtime-store.js";
import {
  CodexAppServerManager,
  probeCodexBinary,
  type CodexAppServerClient,
  type CodexRpcId,
  type CodexRpcMessage,
} from "./codex-app-server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type JsonRecord = Record<string, unknown>;

type OpenCodeEvent = {
  type: string;
  properties: unknown;
};

type PendingApproval = {
  id: string;
  rpcId: CodexRpcId;
  sessionId: string;
  action: string;
  resources: string[];
  metadata: JsonRecord;
  permissions: JsonRecord | null;
  source: { messageID: string; callID: string };
  method: string;
};

export type CodexRuntimeStatus = {
  runtime: AgentRuntime;
  available: boolean;
  experimental: true;
  version: string | null;
  error: string | null;
  process: {
    running: boolean;
    healthy: boolean;
    transport: "stdio";
    placement: "remote-worker";
    publicPort: false;
    platform: string | null;
  };
  account: {
    connected: boolean;
    type: "chatgpt" | "apiKey" | "amazonBedrock" | null;
    email: string | null;
    planType: string | null;
  };
  defaultModel: string | null;
};

export type CodexDeviceLogin = {
  loginId: string;
  verificationUrl: string;
  userCode: string;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectField(value: unknown, field: string): JsonRecord | null {
  if (!isRecord(value)) return null;
  return isRecord(value[field]) ? value[field] : null;
}

function stringField(value: unknown, field: string): string {
  if (!isRecord(value)) return "";
  return stringValue(value[field]);
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(error: unknown, status = 502): Response {
  const message = error instanceof Error ? error.message : stringValue(error) || "Codex runtime request failed";
  return jsonResponse({
    name: "UnknownError",
    data: { message },
  }, status);
}

function normalizeProxyPath(proxyPath: string): string {
  const withoutPrefix = proxyPath.startsWith("/opencode")
    ? proxyPath.slice("/opencode".length)
    : proxyPath;
  const normalized = (withoutPrefix || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function toMillis(seconds: unknown): number {
  const value = numberValue(seconds);
  return value === null ? Date.now() : Math.round(value * 1_000);
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() || "New task";
}

function fileChangePatchText(changes: unknown[]): string {
  return changes.flatMap((change) => {
    if (!isRecord(change)) return [];
    const path = stringField(change, "path");
    if (!path) return [];

    const kindValue = change.kind;
    const kind = stringValue(kindValue) || stringField(kindValue, "type");
    const header = kind === "add"
      ? `*** Add File: ${path}`
      : kind === "delete"
        ? `*** Delete File: ${path}`
        : `*** Update File: ${path}`;
    const movePath = objectField(change, "kind")
      ? stringField(kindValue, "move_path")
      : "";
    return [[header, ...(movePath ? [`*** Move to: ${movePath}`] : []), stringField(change, "diff")]
      .filter(Boolean)
      .join("\n")];
  }).join("\n");
}

function threadStatusBusy(thread: JsonRecord): boolean {
  const status = isRecord(thread.status) ? thread.status : null;
  return status?.type === "active";
}

function threadToSession(thread: JsonRecord, fallbackDirectory: string, version: string): JsonRecord {
  const id = stringField(thread, "id");
  const preview = stringField(thread, "preview");
  const name = stringField(thread, "name");
  const directory = stringField(thread, "cwd") || fallbackDirectory;
  const created = toMillis(thread.createdAt);
  const updated = toMillis(thread.updatedAt);
  return {
    id,
    slug: id,
    projectID: "codex",
    directory,
    title: name || firstLine(preview),
    version,
    time: { created, updated },
    metadata: {
      runtime: "codex",
      execution: "remote-worker",
      busy: threadStatusBusy(thread),
    },
  };
}

function messageInfo(input: {
  id: string;
  sessionId: string;
  role: "user" | "assistant";
  createdAt: number;
  completedAt?: number | null;
  parentId?: string;
  directory: string;
  model?: string;
}): JsonRecord {
  if (input.role === "user") {
    return {
      id: input.id,
      sessionID: input.sessionId,
      role: "user",
      time: { created: input.createdAt },
      agent: "openwork",
      model: { providerID: "codex", modelID: input.model || "default" },
    };
  }
  return {
    id: input.id,
    sessionID: input.sessionId,
    role: "assistant",
    time: {
      created: input.createdAt,
      ...(input.completedAt ? { completed: input.completedAt } : {}),
    },
    parentID: input.parentId || input.sessionId,
    modelID: input.model || "default",
    providerID: "codex",
    mode: "build",
    agent: "openwork",
    path: { cwd: input.directory, root: input.directory },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function userContentText(content: unknown): string {
  return arrayValue(content)
    .flatMap((entry) => isRecord(entry) && entry.type === "text" ? [stringField(entry, "text")] : [])
    .filter(Boolean)
    .join("\n");
}

function assistantMessageId(turnId: string): string {
  return `assistant:${turnId}`;
}

function itemToPart(input: {
  item: JsonRecord;
  sessionId: string;
  turnId: string;
  startedAt: number;
  completedAt?: number | null;
}): JsonRecord | null {
  const item = input.item;
  const itemId = stringField(item, "id") || randomUUID();
  const messageID = assistantMessageId(input.turnId);
  const base = { id: itemId, sessionID: input.sessionId, messageID };
  if (item.type === "agentMessage" || item.type === "plan") {
    return {
      ...base,
      type: "text",
      text: stringField(item, "text"),
      time: {
        start: input.startedAt,
        ...(input.completedAt ? { end: input.completedAt } : {}),
      },
    };
  }
  if (item.type === "reasoning") {
    const summary = arrayValue(item.summary).filter((entry): entry is string => typeof entry === "string");
    const content = arrayValue(item.content).filter((entry): entry is string => typeof entry === "string");
    return {
      ...base,
      type: "reasoning",
      text: [...summary, ...content].join("\n"),
      time: {
        start: input.startedAt,
        ...(input.completedAt ? { end: input.completedAt } : {}),
      },
    };
  }
  if (item.type === "commandExecution") {
    const status = stringField(item, "status");
    const completed = status === "completed";
    const failed = status === "failed" || status === "declined";
    const command = stringField(item, "command");
    return {
      ...base,
      type: "tool",
      callID: itemId,
      tool: "bash",
      state: failed
        ? {
            status: "error",
            input: { command, cwd: stringField(item, "cwd") },
            error: stringField(item, "aggregatedOutput") || `Command ${status}`,
            time: { start: input.startedAt, end: input.completedAt || Date.now() },
          }
        : completed
          ? {
              status: "completed",
              input: { command, cwd: stringField(item, "cwd") },
              output: stringField(item, "aggregatedOutput"),
              title: command || "Command",
              metadata: { exitCode: item.exitCode ?? null },
              time: { start: input.startedAt, end: input.completedAt || Date.now() },
            }
          : {
              status: "running",
              input: { command, cwd: stringField(item, "cwd") },
              title: command || "Command",
              time: { start: input.startedAt },
            },
    };
  }
  if (item.type === "fileChange") {
    const changes = arrayValue(item.changes);
    const patchText = fileChangePatchText(changes);
    const files = changes.flatMap((change) => {
      if (!isRecord(change)) return [];
      const path = stringField(change, "path");
      return path ? [path] : [];
    });
    const status = stringField(item, "status");
    const failed = status === "failed" || status === "declined";
    return {
      ...base,
      type: "tool",
      callID: itemId,
      tool: "apply_patch",
      state: failed
        ? {
            status: "error",
            input: { patchText },
            error: `File change ${status}`,
            time: { start: input.startedAt, end: input.completedAt || Date.now() },
          }
        : input.completedAt
          ? {
              status: "completed",
              input: { patchText },
              output: files.length ? `Updated ${files.join(", ")}` : "File changes applied",
              title: "File changes",
              metadata: { files },
              time: { start: input.startedAt, end: input.completedAt },
            }
          : {
              status: "running",
              input: { patchText },
              title: "File changes",
              time: { start: input.startedAt },
            },
    };
  }
  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const tool = stringField(item, "tool") || "tool";
    const status = stringField(item, "status");
    const failed = status === "failed";
    const complete = status === "completed" || input.completedAt;
    return {
      ...base,
      type: "tool",
      callID: itemId,
      tool,
      state: failed
        ? {
            status: "error",
            input: isRecord(item.arguments) ? item.arguments : {},
            error: stringField(item, "error") || `${tool} failed`,
            time: { start: input.startedAt, end: input.completedAt || Date.now() },
          }
        : complete
          ? {
              status: "completed",
              input: isRecord(item.arguments) ? item.arguments : {},
              output: JSON.stringify(item.result ?? item.contentItems ?? ""),
              title: tool,
              metadata: {},
              time: { start: input.startedAt, end: input.completedAt || Date.now() },
            }
          : {
              status: "running",
              input: isRecord(item.arguments) ? item.arguments : {},
              title: tool,
              time: { start: input.startedAt },
            },
    };
  }
  return null;
}

function threadMessages(thread: JsonRecord, directory: string, model: string): JsonRecord[] {
  const sessionId = stringField(thread, "id");
  const messages: JsonRecord[] = [];
  for (const rawTurn of arrayValue(thread.turns)) {
    if (!isRecord(rawTurn)) continue;
    const turnId = stringField(rawTurn, "id");
    if (!turnId) continue;
    const startedAt = toMillis(rawTurn.startedAt);
    const completedAt = numberValue(rawTurn.completedAt) === null ? null : toMillis(rawTurn.completedAt);
    let lastUserId = sessionId;
    const assistantParts: JsonRecord[] = [];
    for (const rawItem of arrayValue(rawTurn.items)) {
      if (!isRecord(rawItem)) continue;
      if (rawItem.type === "userMessage") {
        const id = stringField(rawItem, "id") || randomUUID();
        const text = userContentText(rawItem.content);
        messages.push({
          info: messageInfo({ id, sessionId, role: "user", createdAt: startedAt, directory, model }),
          parts: [{ id: `${id}:text`, sessionID: sessionId, messageID: id, type: "text", text }],
        });
        lastUserId = id;
        continue;
      }
      const part = itemToPart({ item: rawItem, sessionId, turnId, startedAt, completedAt });
      if (part) assistantParts.push(part);
    }
    if (assistantParts.length) {
      const id = assistantMessageId(turnId);
      messages.push({
        info: messageInfo({
          id,
          sessionId,
          role: "assistant",
          createdAt: startedAt,
          completedAt,
          parentId: lastUserId,
          directory,
          model,
        }),
        parts: assistantParts,
      });
    }
  }
  return messages;
}

function threadFromRpc(value: unknown): JsonRecord {
  const thread = objectField(value, "thread");
  if (!thread || !stringField(thread, "id")) {
    throw new Error("Codex app-server returned an invalid thread");
  }
  return thread;
}

function modelIdFromBody(body: JsonRecord): string | null {
  if (typeof body.model === "string") return body.model.trim() || null;
  if (!isRecord(body.model)) return null;
  return stringField(body.model, "modelID") || stringField(body.model, "id") || null;
}

function reasoningEffortFromBody(body: JsonRecord): string | null {
  const effort = (stringField(body, "reasoning_effort") || stringField(body, "variant")).trim();
  return effort || null;
}

function grantedPermissions(value: JsonRecord | null): JsonRecord {
  if (!value) return {};
  const network = objectField(value, "network");
  const fileSystem = objectField(value, "fileSystem");
  return {
    ...(network ? { network } : {}),
    ...(fileSystem ? { fileSystem } : {}),
  };
}

function inputFromOpenCodeParts(value: unknown): JsonRecord[] {
  const input: JsonRecord[] = [];
  for (const rawPart of arrayValue(value)) {
    if (!isRecord(rawPart)) continue;
    if (rawPart.type === "text") {
      const text = stringField(rawPart, "text");
      if (text) input.push({ type: "text", text, text_elements: [] });
      continue;
    }
    if (rawPart.type === "file") {
      const url = stringField(rawPart, "url");
      const mime = stringField(rawPart, "mime");
      if (url.startsWith("file://") && mime.startsWith("image/")) {
        input.push({ type: "localImage", path: decodeURIComponent(url.slice("file://".length)) });
      } else if (url) {
        input.push({ type: "text", text: `Attached file: ${url}`, text_elements: [] });
      }
    }
  }
  return input;
}

function codexModelToOpenCode(raw: JsonRecord): JsonRecord | null {
  const id = stringField(raw, "model") || stringField(raw, "id");
  if (!id) return null;
  const effortOptions = arrayValue(raw.supportedReasoningEfforts)
    .flatMap((entry) => isRecord(entry) ? [stringField(entry, "reasoningEffort")] : [])
    .filter(Boolean);
  return {
    id,
    providerID: "codex",
    api: { id, url: "codex-app-server", npm: "@openai/codex" },
    name: stringField(raw, "displayName") || id,
    family: "codex",
    capabilities: {
      temperature: false,
      reasoning: effortOptions.length > 0,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 200_000, output: 100_000 },
    status: "active",
    options: {},
    headers: {},
    release_date: "",
    variants: Object.fromEntries(effortOptions.map((effort) => [effort, {}])),
  };
}

export class CodexOpenCodeAdapter {
  private subscribers = new Set<(event: OpenCodeEvent) => void>();
  private activeTurnByThread = new Map<string, string>();
  private modelByThread = new Map<string, string>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private unsubscribe: () => void;

  constructor(
    readonly workspace: WorkspaceInfo,
    readonly client: CodexAppServerClient,
  ) {
    this.unsubscribe = client.onMessage((message) => this.handleCodexMessage(message));
  }

  dispose(): void {
    this.unsubscribe();
    this.subscribers.clear();
  }

  private emit(type: string, properties: unknown): void {
    const event = { type, properties } satisfies OpenCodeEvent;
    for (const subscriber of this.subscribers) subscriber(event);
  }

  private sessionVersion(): string {
    return this.client.metadata?.userAgent || "codex";
  }

  private handleCodexMessage(message: CodexRpcMessage): void {
    if (!message.method) return;
    if (message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }
    const params = isRecord(message.params) ? message.params : {};
    if (message.method === "thread/started") {
      const thread = objectField(params, "thread");
      if (thread) this.emit("session.created", { info: threadToSession(thread, this.workspace.path, this.sessionVersion()) });
      return;
    }
    if (message.method === "thread/name/updated") {
      const threadId = stringField(params, "threadId");
      if (threadId) this.emit("session.updated", { info: { id: threadId, title: stringField(params, "threadName") } });
      return;
    }
    if (message.method === "thread/status/changed") {
      const threadId = stringField(params, "threadId");
      const status = objectField(params, "status");
      if (!threadId || !status) return;
      const busy = status.type === "active";
      this.emit("session.status", { sessionID: threadId, status: { type: busy ? "busy" : "idle" } });
      if (!busy) this.emit("session.idle", { sessionID: threadId });
      return;
    }
    if (message.method === "turn/started") {
      const threadId = stringField(params, "threadId");
      const turn = objectField(params, "turn");
      const turnId = turn ? stringField(turn, "id") : "";
      if (!threadId || !turn || !turnId) return;
      this.activeTurnByThread.set(threadId, turnId);
      this.emit("session.status", { sessionID: threadId, status: { type: "busy" } });
      for (const item of arrayValue(turn.items)) {
        if (isRecord(item)) this.emitItem(threadId, turnId, item, false, toMillis(turn.startedAt));
      }
      return;
    }
    if (message.method === "item/started" || message.method === "item/completed") {
      const item = objectField(params, "item");
      const threadId = stringField(params, "threadId");
      const turnId = stringField(params, "turnId");
      if (!item || !threadId || !turnId) return;
      const completed = message.method === "item/completed";
      const at = numberValue(completed ? params.completedAtMs : params.startedAtMs) ?? Date.now();
      this.emitItem(threadId, turnId, item, completed, at);
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const threadId = stringField(params, "threadId");
      const turnId = stringField(params, "turnId");
      const itemId = stringField(params, "itemId");
      const delta = stringField(params, "delta");
      if (!threadId || !turnId || !itemId || !delta) return;
      this.emit("message.part.delta", {
        sessionID: threadId,
        messageID: assistantMessageId(turnId),
        partID: itemId,
        field: "text",
        delta,
      });
      return;
    }
    if (message.method === "turn/completed") {
      const threadId = stringField(params, "threadId");
      const turn = objectField(params, "turn");
      const turnId = turn ? stringField(turn, "id") : "";
      if (!threadId) return;
      if (turnId && this.activeTurnByThread.get(threadId) === turnId) this.activeTurnByThread.delete(threadId);
      if (turn && turn.status === "failed") {
        const turnError = objectField(turn, "error");
        this.emit("session.error", {
          sessionID: threadId,
          error: { name: "UnknownError", data: { message: stringField(turnError, "message") || "Codex turn failed" } },
        });
      }
      this.emit("session.status", { sessionID: threadId, status: { type: "idle" } });
      this.emit("session.idle", { sessionID: threadId });
      return;
    }
    if (message.method === "error") {
      const threadId = stringField(params, "threadId");
      const error = objectField(params, "error");
      if (threadId) {
        this.emit("session.error", {
          sessionID: threadId,
          error: { name: "UnknownError", data: { message: stringField(error, "message") || "Codex runtime error" } },
        });
      }
      return;
    }
    if (message.method === "openwork/processExited") {
      const detail = stringField(params, "message") || "Codex app-server stopped";
      for (const sessionId of this.activeTurnByThread.keys()) {
        this.emit("session.error", {
          sessionID: sessionId,
          error: { name: "UnknownError", data: { message: detail } },
        });
      }
      this.activeTurnByThread.clear();
    }
  }

  private emitItem(sessionId: string, turnId: string, item: JsonRecord, completed: boolean, at: number): void {
    if (item.type === "userMessage") {
      const id = stringField(item, "id") || randomUUID();
      const info = messageInfo({
        id,
        sessionId,
        role: "user",
        createdAt: at,
        directory: this.workspace.path,
        model: this.modelByThread.get(sessionId),
      });
      this.emit("message.updated", { info });
      this.emit("message.part.updated", {
        part: {
          id: `${id}:text`,
          sessionID: sessionId,
          messageID: id,
          type: "text",
          text: userContentText(item.content),
        },
      });
      return;
    }
    const messageID = assistantMessageId(turnId);
    this.emit("message.updated", {
      info: messageInfo({
        id: messageID,
        sessionId,
        role: "assistant",
        createdAt: at,
        completedAt: completed ? at : null,
        directory: this.workspace.path,
        model: this.modelByThread.get(sessionId),
      }),
    });
    const part = itemToPart({
      item,
      sessionId,
      turnId,
      startedAt: at,
      completedAt: completed ? at : null,
    });
    if (part) this.emit("message.part.updated", { part });
  }

  private handleServerRequest(message: CodexRpcMessage): void {
    if (message.id === undefined || !message.method) return;
    const params = isRecord(message.params) ? message.params : {};
    if (!["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"].includes(message.method)) {
      this.client.respondError(message.id, -32601, `OpenWork does not support ${message.method}`);
      return;
    }
    const sessionId = stringField(params, "threadId");
    const turnId = stringField(params, "turnId");
    const itemId = stringField(params, "itemId");
    if (!sessionId || !turnId || !itemId) {
      this.client.respondError(message.id, -32602, "Invalid approval request");
      return;
    }
    const id = `codex-${String(message.id)}`;
    const command = stringField(params, "command");
    const cwd = stringField(params, "cwd");
    const reason = stringField(params, "reason");
    const permissions = message.method === "item/permissions/requestApproval"
      ? objectField(params, "permissions")
      : null;
    const action = message.method.includes("commandExecution")
      ? "command.execute"
      : message.method.includes("fileChange")
        ? "file.write"
        : "permissions.request";
    const resources = [command, cwd, stringField(params, "grantRoot")].filter(Boolean);
    const approval: PendingApproval = {
      id,
      rpcId: message.id,
      sessionId,
      action,
      resources,
      metadata: {
        runtime: "codex",
        ...(command ? { command } : {}),
        ...(cwd ? { cwd } : {}),
        ...(reason ? { reason } : {}),
        ...(permissions ? { permissions } : {}),
      },
      permissions,
      source: { messageID: assistantMessageId(turnId), callID: itemId },
      method: message.method,
    };
    this.pendingApprovals.set(id, approval);
    this.emit("permission.v2.asked", this.openCodePermission(approval));
  }

  private openCodePermission(approval: PendingApproval): JsonRecord {
    return {
      id: approval.id,
      sessionID: approval.sessionId,
      action: approval.action,
      resources: approval.resources,
      save: [approval.action],
      metadata: approval.metadata,
      source: approval.source,
    };
  }

  private async readBody(request: Request): Promise<JsonRecord> {
    const text = await request.text();
    if (!text.trim()) return {};
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  }

  private async readThread(threadId: string, includeTurns: boolean): Promise<JsonRecord> {
    return threadFromRpc(await this.client.request("thread/read", { threadId, includeTurns }));
  }

  async listSessions(input: { limit?: number; search?: string }): Promise<JsonRecord[]> {
    const result = await this.client.request("thread/list", {
      limit: input.limit ?? 200,
      cwd: this.workspace.path,
      ...(input.search ? { searchTerm: input.search } : {}),
    });
    const data = isRecord(result) ? arrayValue(result.data) : [];
    return data.flatMap((thread) => isRecord(thread)
      ? [threadToSession(thread, this.workspace.path, this.sessionVersion())]
      : []);
  }

  async createSession(input: { title?: string; model?: string | null }): Promise<JsonRecord> {
    const params: JsonRecord = {
      cwd: this.workspace.path,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      serviceName: "openwork",
      developerInstructions: "You are running inside OpenWork on a remote worker. Keep all file work inside the current workspace unless the user explicitly approves otherwise.",
    };
    if (input.model) params.model = input.model;
    const thread = threadFromRpc(await this.client.request("thread/start", params));
    const threadId = stringField(thread, "id");
    if (input.model) this.modelByThread.set(threadId, input.model);
    if (input.title?.trim()) {
      await this.client.request("thread/name/set", { threadId, name: input.title.trim() });
      thread.name = input.title.trim();
    }
    return threadToSession(thread, this.workspace.path, this.sessionVersion());
  }

  async getSession(threadId: string): Promise<JsonRecord> {
    return threadToSession(
      await this.readThread(threadId, false),
      this.workspace.path,
      this.sessionVersion(),
    );
  }

  async getMessages(threadId: string): Promise<JsonRecord[]> {
    const thread = await this.readThread(threadId, true);
    return threadMessages(thread, this.workspace.path, this.modelByThread.get(threadId) || "default");
  }

  async getStatus(): Promise<Record<string, JsonRecord>> {
    const sessions = await this.listSessions({ limit: 200 });
    return Object.fromEntries(sessions.flatMap((session) => {
      const id = stringField(session, "id");
      if (!id) return [];
      const metadata = isRecord(session.metadata) ? session.metadata : {};
      return [[id, { type: metadata.busy === true ? "busy" : "idle" }]];
    }));
  }

  async deleteSession(threadId: string): Promise<boolean> {
    await this.client.request("thread/delete", { threadId });
    this.activeTurnByThread.delete(threadId);
    this.modelByThread.delete(threadId);
    this.emit("session.deleted", { sessionID: threadId });
    return true;
  }

  async renameSession(threadId: string, title: string): Promise<JsonRecord> {
    await this.client.request("thread/name/set", { threadId, name: title });
    return this.getSession(threadId);
  }

  async startTurn(threadId: string, body: JsonRecord): Promise<void> {
    const input = inputFromOpenCodeParts(body.parts);
    if (!input.length) throw new Error("A Codex turn requires text or an image");
    const model = modelIdFromBody(body);
    const effort = reasoningEffortFromBody(body);
    if (model) this.modelByThread.set(threadId, model);
    const params: JsonRecord = {
      threadId,
      clientUserMessageId: stringField(body, "messageID") || randomUUID(),
      input,
      cwd: this.workspace.path,
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [this.workspace.path],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
    const result = await this.client.request("turn/start", params);
    const turn = objectField(result, "turn");
    const turnId = turn ? stringField(turn, "id") : "";
    if (turnId) this.activeTurnByThread.set(threadId, turnId);
  }

  async abortTurn(threadId: string): Promise<boolean> {
    let turnId = this.activeTurnByThread.get(threadId) || "";
    if (!turnId) {
      const thread = await this.readThread(threadId, true);
      const turns = arrayValue(thread.turns);
      const latest = turns[turns.length - 1];
      if (isRecord(latest) && latest.status === "inProgress") turnId = stringField(latest, "id");
    }
    if (!turnId) return false;
    await this.client.request("turn/interrupt", { threadId, turnId });
    this.activeTurnByThread.delete(threadId);
    return true;
  }

  pendingPermissions(threadId?: string): JsonRecord[] {
    return [...this.pendingApprovals.values()].flatMap((approval) =>
      !threadId || approval.sessionId === threadId ? [this.openCodePermission(approval)] : [],
    );
  }

  replyPermission(requestId: string, reply: string): boolean {
    const approval = this.pendingApprovals.get(requestId);
    if (!approval) return false;
    const decision = reply === "always" ? "acceptForSession" : reply === "reject" ? "decline" : "accept";
    this.pendingApprovals.delete(requestId);
    if (approval.method === "item/permissions/requestApproval") {
      if (reply === "reject") {
        this.client.respondError(approval.rpcId, -32000, "Permission request declined");
      } else {
        this.client.respond(approval.rpcId, {
          permissions: grantedPermissions(approval.permissions),
          scope: reply === "always" ? "session" : "turn",
        });
      }
    } else {
      this.client.respond(approval.rpcId, { decision });
    }
    this.emit("permission.v2.replied", {
      sessionID: approval.sessionId,
      requestID: requestId,
      reply,
    });
    return true;
  }

  async providerList(): Promise<JsonRecord> {
    const result = await this.client.request("model/list", { includeHidden: false });
    const data = isRecord(result) ? arrayValue(result.data) : [];
    const models = data.flatMap((entry) => isRecord(entry) ? [codexModelToOpenCode(entry)] : [])
      .filter((entry): entry is JsonRecord => entry !== null);
    const byId = Object.fromEntries(models.map((model) => [stringField(model, "id"), model]));
    const defaultEntry = data.find((entry) => isRecord(entry) && entry.isDefault === true);
    const defaultModel = isRecord(defaultEntry)
      ? stringField(defaultEntry, "model") || stringField(defaultEntry, "id")
      : stringField(models[0], "id");
    const account = await this.client.request("account/read", { refreshToken: false }).catch(() => null);
    const connected = Boolean(objectField(account, "account"));
    return {
      all: [{ id: "codex", name: "Codex (ChatGPT)", source: "custom", env: [], options: {}, models: byId }],
      default: defaultModel ? { codex: defaultModel } : {},
      connected: connected ? ["codex"] : [],
    };
  }

  private eventStream(request: Request): Response {
    const encoder = new TextEncoder();
    let unsubscribe = () => {};
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (event: OpenCodeEvent) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            // The browser closed the stream.
          }
        };
        send({ type: "server.connected", properties: { runtime: "codex" } });
        const listener = (event: OpenCodeEvent) => send(event);
        this.subscribers.add(listener);
        unsubscribe = () => this.subscribers.delete(listener);
        heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(": keepalive\n\n")); } catch {}
        }, 15_000);
        request.signal.addEventListener("abort", () => {
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
          try { controller.close(); } catch {}
        }, { once: true });
      },
      cancel: () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  async handleProxy(request: Request, proxyPath: string, url: URL): Promise<Response | null> {
    const path = normalizeProxyPath(proxyPath);
    try {
      await this.client.start();
      if (request.method === "GET" && path === "/global/health") {
        return jsonResponse({ healthy: true, version: this.sessionVersion(), runtime: "codex" });
      }
      if (request.method === "POST" && path === "/global/dispose") return jsonResponse(true);
      if (request.method === "GET" && path === "/event") return this.eventStream(request);
      if (request.method === "GET" && path === "/provider") return jsonResponse(await this.providerList());
      if (request.method === "GET" && path === "/provider/auth") return jsonResponse({});
      if (request.method === "GET" && path === "/config/providers") {
        const providers = await this.providerList();
        return jsonResponse({ providers: providers.all, default: providers.default });
      }
      if (request.method === "GET" && path === "/agent") {
        return jsonResponse([{
          name: "openwork",
          description: "Codex running on the remote OpenWork worker",
          mode: "primary",
          native: true,
          permission: [],
          options: {},
        }]);
      }
      if (request.method === "GET" && path === "/command") return jsonResponse([]);
      if (request.method === "GET" && path === "/permission") return jsonResponse(this.pendingPermissions());
      if (request.method === "GET" && path === "/question") return jsonResponse([]);
      if (request.method === "GET" && path === "/session/status") return jsonResponse(await this.getStatus());
      if (request.method === "GET" && path === "/session") {
        const limit = Number(url.searchParams.get("limit"));
        return jsonResponse(await this.listSessions({
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
          search: url.searchParams.get("search")?.trim() || undefined,
        }));
      }
      if (request.method === "POST" && path === "/session") {
        const body = await this.readBody(request);
        return jsonResponse(await this.createSession({
          title: stringField(body, "title") || undefined,
          model: modelIdFromBody(body),
        }));
      }
      const messageMatch = path.match(/^\/session\/([^/]+)\/message$/);
      if (request.method === "GET" && messageMatch?.[1]) {
        return jsonResponse(await this.getMessages(decodeURIComponent(messageMatch[1])));
      }
      const todoMatch = path.match(/^\/session\/([^/]+)\/todo$/);
      if (request.method === "GET" && todoMatch?.[1]) return jsonResponse([]);
      const childrenMatch = path.match(/^\/session\/([^/]+)\/children$/);
      if (request.method === "GET" && childrenMatch?.[1]) return jsonResponse([]);
      const diffMatch = path.match(/^\/session\/([^/]+)\/diff$/);
      if (request.method === "GET" && diffMatch?.[1]) return jsonResponse([]);
      const promptMatch = path.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (request.method === "POST" && promptMatch?.[1]) {
        await this.startTurn(decodeURIComponent(promptMatch[1]), await this.readBody(request));
        return jsonResponse({});
      }
      const abortMatch = path.match(/^\/session\/([^/]+)\/abort$/);
      if (request.method === "POST" && abortMatch?.[1]) {
        return jsonResponse(await this.abortTurn(decodeURIComponent(abortMatch[1])));
      }
      const sessionMatch = path.match(/^\/session\/([^/]+)$/);
      if (sessionMatch?.[1] && request.method === "GET") {
        return jsonResponse(await this.getSession(decodeURIComponent(sessionMatch[1])));
      }
      if (sessionMatch?.[1] && request.method === "DELETE") {
        return jsonResponse(await this.deleteSession(decodeURIComponent(sessionMatch[1])));
      }
      if (sessionMatch?.[1] && request.method === "PATCH") {
        const body = await this.readBody(request);
        const title = stringField(body, "title");
        if (!title) return errorResponse("title is required", 400);
        return jsonResponse(await this.renameSession(decodeURIComponent(sessionMatch[1]), title));
      }
      const legacyReply = path.match(/^\/permission\/([^/]+)\/reply$/);
      const v2Reply = path.match(/^\/api\/session\/([^/]+)\/permission\/([^/]+)\/reply$/);
      if (request.method === "POST" && (legacyReply?.[1] || v2Reply?.[2])) {
        const requestId = decodeURIComponent(legacyReply?.[1] || v2Reply?.[2] || "");
        const body = await this.readBody(request);
        return jsonResponse(this.replyPermission(requestId, stringField(body, "reply")));
      }
      const v2PermissionList = path.match(/^\/api\/session\/([^/]+)\/permission$/);
      if (request.method === "GET" && v2PermissionList?.[1]) {
        return jsonResponse(this.pendingPermissions(decodeURIComponent(v2PermissionList[1])));
      }
      return null;
    } catch (error) {
      return errorResponse(error);
    }
  }
}

export class CodexRuntimeService {
  private adapters = new Map<string, CodexOpenCodeAdapter>();

  constructor(
    private readonly config: ServerConfig,
    private readonly manager: CodexAppServerManager,
  ) {}

  async isSelected(workspaceId: string): Promise<boolean> {
    return workspaceUsesCodexRuntime(this.config, workspaceId);
  }

  adapterFor(workspace: WorkspaceInfo): CodexOpenCodeAdapter {
    const existing = this.adapters.get(workspace.id);
    if (existing) return existing;
    const adapter = new CodexOpenCodeAdapter(workspace, this.manager.clientFor(workspace));
    this.adapters.set(workspace.id, adapter);
    return adapter;
  }

  async select(workspace: WorkspaceInfo, runtime: AgentRuntime): Promise<CodexRuntimeStatus> {
    if (runtime === "codex") {
      await this.manager.clientFor(workspace).start();
    } else {
      this.adapters.get(workspace.id)?.dispose();
      this.adapters.delete(workspace.id);
      await this.manager.stopWorkspace(workspace.id);
    }
    await writeAgentRuntimeState(this.config, workspace.id, runtime);
    return this.status(workspace);
  }

  async status(workspace: WorkspaceInfo): Promise<CodexRuntimeStatus> {
    const { runtime } = await readAgentRuntimeState(this.config, workspace.id);
    let version: string | null = null;
    let error: string | null = null;
    let available = false;
    let accountResult: unknown = null;
    let defaultModel: string | null = null;
    let running = false;
    let platform: string | null = null;
    try {
      if (runtime === "codex") {
        const client = this.manager.clientFor(workspace);
        await client.start();
        running = client.running;
        version = client.metadata?.userAgent || null;
        platform = client.metadata ? `${client.metadata.platformOs}/${client.metadata.platformFamily}` : null;
        available = true;
        accountResult = await client.request("account/read", { refreshToken: false });
        const modelResult = await client.request("model/list", { limit: 100, includeHidden: false });
        const models = isRecord(modelResult) ? arrayValue(modelResult.data) : [];
        const preferred = models.find((entry) => isRecord(entry) && entry.isDefault === true) ?? models[0];
        if (isRecord(preferred)) defaultModel = stringField(preferred, "model") || stringField(preferred, "id") || null;
      } else {
        version = await probeCodexBinary();
        available = true;
      }
    } catch (statusError) {
      error = statusError instanceof Error ? statusError.message : stringValue(statusError) || "Codex is unavailable";
    }
    const account = objectField(accountResult, "account");
    const accountType = account && ["chatgpt", "apiKey", "amazonBedrock"].includes(stringField(account, "type"))
      ? stringField(account, "type")
      : null;
    return {
      runtime,
      available,
      experimental: true,
      version,
      error,
      process: {
        running,
        healthy: running && !error,
        transport: "stdio",
        placement: "remote-worker",
        publicPort: false,
        platform,
      },
      account: {
        connected: account !== null,
        type: accountType === "chatgpt" || accountType === "apiKey" || accountType === "amazonBedrock"
          ? accountType
          : null,
        email: account ? stringField(account, "email") || null : null,
        planType: account ? stringField(account, "planType") || null : null,
      },
      defaultModel,
    };
  }

  async startDeviceLogin(workspace: WorkspaceInfo): Promise<CodexDeviceLogin> {
    const client = this.manager.clientFor(workspace);
    await client.start();
    const result = await client.request("account/login/start", { type: "chatgptDeviceCode" });
    if (!isRecord(result) || result.type !== "chatgptDeviceCode") {
      throw new Error("Codex did not return a device-code login");
    }
    const loginId = stringField(result, "loginId");
    const verificationUrl = stringField(result, "verificationUrl");
    const userCode = stringField(result, "userCode");
    if (!loginId || !verificationUrl || !userCode) {
      throw new Error("Codex returned an incomplete device-code login");
    }
    return { loginId, verificationUrl, userCode };
  }

  async cancelLogin(workspace: WorkspaceInfo, loginId: string): Promise<void> {
    await this.manager.clientFor(workspace).request("account/login/cancel", { loginId });
  }

  async logout(workspace: WorkspaceInfo): Promise<void> {
    await this.manager.clientFor(workspace).request("account/logout", undefined);
  }

  async handleProxy(input: {
    workspace: WorkspaceInfo;
    request: Request;
    proxyPath: string;
    url: URL;
  }): Promise<Response | null> {
    if (!(await this.isSelected(input.workspace.id))) return null;
    return this.adapterFor(input.workspace).handleProxy(input.request, input.proxyPath, input.url);
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters.values()) adapter.dispose();
    this.adapters.clear();
    await this.manager.stop();
  }
}
