import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import {
  buildNativeImport,
  CLAUDE_IMPORT_LIMITS,
  ClaudeImportError,
  claudeCodeProjectFolder,
  nativeSessionId,
  readClaudeCodeTranscript,
  readClaudeExport,
  type ImportedConversation,
  type NativeImportPayload,
} from "../claude-import.js";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

/** Calls one native OpenCode v2 route for a folder; undefined when v2 is not running. */
export type ClaudeImportEngine = {
  request(method: "GET" | "POST", path: string, directory: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  prepare(directory: string): Promise<void>;
};

export type ClaudeImportStatus = "new" | "imported" | "changed";

export type ClaudeImportItem = {
  sourceId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  status: ClaudeImportStatus;
  sessionId: string;
  notes: string[];
};

export type ClaudeImportResult = { sourceId: string; sessionId: string; status: "imported" | "already_imported" | "skipped_changed" | "failed"; message?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function engineUnavailable(): ApiError {
  return new ApiError(409, "engine_unavailable", "Importing needs the current OpenWork engine. Restart OpenWork and try again.");
}

function toApiError(error: unknown): unknown {
  if (error instanceof ClaudeImportError) return new ApiError(400, error.code, error.message);
  return error;
}

async function projectId(engine: ClaudeImportEngine, directory: string): Promise<string> {
  const response = await engine.request("GET", "/api/location", directory);
  const project = isRecord(response.body) && isRecord(response.body.project) ? response.body.project : undefined;
  if (response.status !== 200 || typeof project?.id !== "string") throw engineUnavailable();
  return project.id;
}

async function statusOf(engine: ClaudeImportEngine, conversation: ImportedConversation, directory: string): Promise<ClaudeImportStatus> {
  const response = await engine.request("GET", `/api/session/${encodeURIComponent(nativeSessionId(conversation, directory))}`, directory);
  if (response.status === 404) return "new";
  if (response.status !== 200) throw engineUnavailable();
  const info = isRecord(response.body) && isRecord(response.body.data) ? response.body.data : undefined;
  const meta = isRecord(info?.metadata) && isRecord(info.metadata.claudeImport) ? info.metadata.claudeImport : undefined;
  return meta?.sourceHash === conversation.sourceHash ? "imported" : "changed";
}

async function describe(engine: ClaudeImportEngine, conversations: ImportedConversation[], directory: string): Promise<ClaudeImportItem[]> {
  const items: ClaudeImportItem[] = [];
  for (const conversation of conversations) {
    items.push({
      sourceId: conversation.sourceId,
      title: conversation.title,
      updatedAt: conversation.updated,
      messageCount: conversation.messages.length,
      status: await statusOf(engine, conversation, directory),
      sessionId: nativeSessionId(conversation, directory),
      notes: conversation.notes,
    });
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Import each conversation at most once. An unchanged one is left as is; one
 * that changed in Claude after it was imported is skipped, never overwritten,
 * because the person may have continued it in OpenWork. A failed request is
 * reported and not retried: the deterministic session id makes a later run
 * see whether it landed.
 */
export async function importConversations(engine: ClaudeImportEngine, conversations: ImportedConversation[], directory: string): Promise<ClaudeImportResult[]> {
  await engine.prepare(directory);
  const project = await projectId(engine, directory);
  const results: ClaudeImportResult[] = [];
  for (const conversation of conversations) {
    const sessionId = nativeSessionId(conversation, directory);
    const status = await statusOf(engine, conversation, directory);
    if (status === "imported") { results.push({ sourceId: conversation.sourceId, sessionId, status: "already_imported" }); continue; }
    if (status === "changed") { results.push({ sourceId: conversation.sourceId, sessionId, status: "skipped_changed" }); continue; }
    const payload: NativeImportPayload = buildNativeImport(conversation, { directory, projectID: project });
    try {
      const response = await engine.request("POST", "/api/experimental/session/import", directory, payload);
      if (response.status !== 200) {
        results.push({ sourceId: conversation.sourceId, sessionId, status: "failed", message: `OpenWork could not save this conversation (${response.status}).` });
        continue;
      }
      results.push({ sourceId: conversation.sourceId, sessionId, status: "imported" });
    } catch {
      results.push({ sourceId: conversation.sourceId, sessionId, status: "failed", message: "OpenWork could not save this conversation." });
    }
  }
  return results;
}

/** Claude Code's data folder: `CLAUDE_CONFIG_DIR`, as Claude Code itself reads it, else ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
}

/** Claude Code saves each folder's sessions under <config>/projects/<folder>. */
export async function readClaudeCodeSessions(directory: string, configDir: string): Promise<ImportedConversation[]> {
  const folders = new Set([claudeCodeProjectFolder(directory)]);
  try { folders.add(claudeCodeProjectFolder(await realpath(directory))); } catch { /* folder may be gone */ }
  const conversations: ImportedConversation[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    const root = join(configDir, "projects", folder);
    let names: string[];
    try { names = await readdir(root); } catch { continue; }
    for (const name of names.filter((entry) => entry.endsWith(".jsonl")).sort()) {
      const path = join(root, name);
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > CLAUDE_IMPORT_LIMITS.transcriptBytes) continue;
        const conversation = readClaudeCodeTranscript(await readFile(path, "utf8"));
        if (seen.has(conversation.sourceId)) continue;
        seen.add(conversation.sourceId);
        conversations.push(conversation);
      } catch {
        // An empty or unreadable transcript is not offered.
      }
    }
  }
  return conversations;
}

/** The running native engine, or undefined while chats still use v1. */
export function createNativeClaudeImportEngine(
  preview: { status(): { chatRouting?: boolean }; connection(): { url: string; username: string; password: string } | undefined; ensureWorkspaceReady(directory: string): Promise<void> },
): ClaudeImportEngine | undefined {
  if (!preview.status().chatRouting) return undefined;
  const connection = preview.connection();
  if (!connection) return undefined;
  const authorization = `Basic ${Buffer.from(`${connection.username}:${connection.password}`).toString("base64")}`;
  return {
    prepare: (directory) => preview.ensureWorkspaceReady(directory),
    request: async (method, path, directory, body) => {
      const url = new URL(path, connection.url);
      url.searchParams.set("location[directory]", directory);
      const response = await fetch(url, {
        method,
        headers: body === undefined ? { authorization } : { authorization, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(method === "POST" ? 120_000 : 15_000),
      });
      const text = await response.text();
      let parsed: unknown = undefined;
      try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = undefined; }
      return { status: response.status, body: parsed };
    },
  };
}

const idsSchema = z.array(z.string().min(1).max(200)).min(1).max(CLAUDE_IMPORT_LIMITS.conversations);
const codeImportSchema = z.object({ ids: idsSchema }).strict();

interface RegisterClaudeImportRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  engineForWorkspace: (workspace: WorkspaceInfo) => ClaudeImportEngine | undefined;
  /** Defaults to `claudeConfigDir()` on each request. */
  claudeConfigDir?: string;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<unknown>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

/**
 * Import Claude history into a workspace as native chats.
 *
 * - POST /workspace/:id/claude-import/export (multipart: file, mode, ids)
 *   previews or imports conversations from a Claude data export.
 * - GET/POST /workspace/:id/claude-import/code lists or imports the Claude
 *   Code sessions saved for this folder on this computer.
 */
export function registerClaudeImportRoutes(options: RegisterClaudeImportRoutesOptions): void {
  const { routes, config, engineForWorkspace, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspaceWithoutBootstrap } = options;
  const configDir = () => options.claudeConfigDir ?? claudeConfigDir();

  const engineFor = (workspace: WorkspaceInfo) => {
    const engine = engineForWorkspace(workspace);
    if (!engine) throw engineUnavailable();
    return engine;
  };

  addRoute(routes, "POST", "/workspace/:id/claude-import/export", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const declared = Number(ctx.request.headers.get("content-length") ?? "0");
    if (declared > CLAUDE_IMPORT_LIMITS.uploadBytes + 1024 * 1024) {
      throw new ApiError(413, "claude_export_too_large", "This export is too large. Export a shorter date range.");
    }
    let form: FormData;
    try { form = await ctx.request.formData(); } catch { throw new ApiError(400, "invalid_payload", "Choose a Claude export file."); }
    const file = form.get("file");
    if (!(file instanceof Blob)) throw new ApiError(400, "invalid_payload", "Choose a Claude export file.");
    if (file.size > CLAUDE_IMPORT_LIMITS.uploadBytes) throw new ApiError(413, "claude_export_too_large", "This export is too large. Export a shorter date range.");
    let conversations: ImportedConversation[];
    try { conversations = readClaudeExport(Buffer.from(await file.arrayBuffer())); } catch (error) { throw toApiError(error); }
    const engine = engineFor(workspace);
    if (form.get("mode") !== "import") {
      return jsonResponse({ items: await describe(engine, conversations, workspace.path) });
    }
    ensureWritable(config);
    let ids: string[];
    try { ids = idsSchema.parse(JSON.parse(String(form.get("ids") ?? "[]"))); } catch { throw new ApiError(400, "invalid_payload", "Choose at least one conversation."); }
    const wanted = new Set(ids);
    return jsonResponse({ results: await importConversations(engine, conversations.filter((item) => wanted.has(item.sourceId)), workspace.path) });
  });

  addRoute(routes, "GET", "/workspace/:id/claude-import/code", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const conversations = await readClaudeCodeSessions(workspace.path, configDir());
    if (conversations.length === 0) return jsonResponse({ items: [] });
    return jsonResponse({ items: await describe(engineFor(workspace), conversations, workspace.path) });
  });

  addRoute(routes, "POST", "/workspace/:id/claude-import/code", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const parsed = codeImportSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_payload", "Choose at least one session.");
    const wanted = new Set(parsed.data.ids);
    const conversations = (await readClaudeCodeSessions(workspace.path, configDir())).filter((item) => wanted.has(item.sourceId));
    return jsonResponse({ results: await importConversations(engineFor(workspace), conversations, workspace.path) });
  });
}
