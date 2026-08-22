import { realpath } from "node:fs/promises";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { ApiError } from "../errors.js";
import { seedOpencodeSessionMessages } from "../opencode-db.js";
import {
  forgetSessionImport,
  readSessionImportState,
  recordSessionImports,
  type SessionImportMark,
} from "../session-imports.js";
import { buildSession, buildSessionList, buildSessionMessages, buildSessionSnapshot } from "../session-read-model.js";
import type { SessionSnapshotReadModel } from "../session-read-model.js";
import {
  buildSessionExportBundle,
  MAX_IMPORT_SESSIONS,
  parseSessionExportBundle,
  planSessionImport,
  renderSessionBundleMarkdown,
  SessionBundleError,
  type SessionExportBundle,
  type SessionTransferSensitiveMode,
} from "../session-transfer.js";
import {
  createSessionGroupId,
  normalizeSessionGroupState,
  readSessionGroupState,
  SessionGroupEventStore,
  updateSessionGroupState,
  type SessionGroupDefinition,
  type SessionGroupState,
} from "../session-groups.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ParseOptionalBoolean = (value: string | null, name: string) => boolean | undefined;
type ParseOptionalPositiveInteger = (value: string | null, name: string) => number | undefined;
type ParseOptionalNonNegativeInteger = (value: string | null, name: string) => number | undefined;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type WorkspaceOpencodeClient = ReturnType<typeof createOpencodeClient>;
type OpencodeClientResult<T, E> =
  | { data: T | undefined; error: undefined; response: Response }
  | { data: undefined; error: E; response?: Response };
type UnwrapOpencodeResult = <T, E>(result: OpencodeClientResult<T, E>, path: string) => NonNullable<T>;

interface RegisterSessionRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  parseOptionalBoolean: ParseOptionalBoolean;
  parseOptionalPositiveInteger: ParseOptionalPositiveInteger;
  parseOptionalNonNegativeInteger: ParseOptionalNonNegativeInteger;
  parseExportSensitiveMode: (value: string | null) => SessionTransferSensitiveMode;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  resolveOpencodeDirectory: (workspace: WorkspaceInfo) => string | null;
  createWorkspaceOpencodeClient: (
    config: ServerConfig,
    workspace: WorkspaceInfo,
    options?: { boundedDiagnosticsReads?: boolean; sessionId?: string },
  ) => WorkspaceOpencodeClient;
  unwrapOpencodeResult: UnwrapOpencodeResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerSessionRoutes(options: RegisterSessionRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    parseOptionalBoolean,
    parseOptionalPositiveInteger,
    parseOptionalNonNegativeInteger,
    parseExportSensitiveMode,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    resolveWorkspaceWithoutBootstrap,
    resolveOpencodeDirectory,
    createWorkspaceOpencodeClient,
    unwrapOpencodeResult,
  } = options;
  const sessionGroupEvents = new SessionGroupEventStore();

  async function requireWorkspaceSession(workspace: WorkspaceInfo, value: Parameters<typeof buildSession>[0]) {
    const session = buildSession(value);
    const directory = resolveOpencodeDirectory(workspace);
    const [expectedDirectory, sessionDirectory] = workspace.workspaceType === "local" && directory && session.directory
      ? await Promise.all([
          realpath(directory).catch(() => directory),
          realpath(session.directory).catch(() => session.directory),
        ])
      : [directory, session.directory];
    if (expectedDirectory && sessionDirectory !== expectedDirectory) {
      throw new ApiError(404, "session_not_found", "Session not found");
    }
    return session;
  }

  function remapSessionReadError(error: unknown): never {
    if (error instanceof ApiError && error.code === "opencode_request_failed") {
      const details = error.details;
      const upstreamStatus =
        isRecord(details) && "status" in details ? Number(details.status) : NaN;
      if (upstreamStatus === 400) {
        throw new ApiError(400, "invalid_query", "OpenCode rejected the session read request", details);
      }
      if (upstreamStatus === 404) {
        throw new ApiError(404, "session_not_found", "Session not found", details);
      }
    }
    throw error;
  }

  async function listWorkspaceSessions(
    workspace: WorkspaceInfo,
    input: { roots?: boolean; start?: number; search?: string; limit?: number },
  ) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      return buildSessionList(
        unwrapOpencodeResult(
          await opencode.session.list({
            roots: input.roots,
            start: input.start,
            search: input.search,
            limit: input.limit,
          }),
          "/session",
        ),
      );
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function createWorkspaceSession(
    workspace: WorkspaceInfo,
    input: { title: string; prompt?: string; providerId?: string; modelId?: string; variant?: string },
  ) {
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    const session = buildSession(
      unwrapOpencodeResult(
        await opencode.session.create({ title: input.title }),
        "/session",
      ),
    );

    if (input.prompt) {
      const result = await opencode.session.promptAsync({
        sessionID: session.id,
        ...(input.providerId && input.modelId
          ? { model: { providerID: input.providerId, modelID: input.modelId } }
          : {}),
        ...(input.variant ? { variant: input.variant } : {}),
        parts: [{ type: "text", text: input.prompt }],
      });
      if (result.error !== undefined) {
        const upstreamStatus = result.response?.status;
        throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
          ...(upstreamStatus === undefined ? {} : { status: upstreamStatus }),
          body: result.error,
          path: `/session/${encodeURIComponent(session.id)}/prompt_async`,
        });
      }
    }

    return { item: session, started: Boolean(input.prompt) };
  }

  async function readWorkspaceSession(workspace: WorkspaceInfo, sessionId: string) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      return await requireWorkspaceSession(
        workspace,
        unwrapOpencodeResult(
          await opencode.session.get({ sessionID: sessionId }),
          `/session/${encodeURIComponent(sessionId)}`,
        ),
      );
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function readWorkspaceSessionMessages(
    workspace: WorkspaceInfo,
    sessionId: string,
    input: { limit?: number },
  ) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      const [session, messages] = await Promise.all([
        opencode.session
          .get({ sessionID: sessionId })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}`)),
        opencode.session
          .messages({ sessionID: sessionId, limit: input.limit })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}/message`)),
      ]);
      await requireWorkspaceSession(workspace, session);
      return buildSessionMessages(messages);
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function readWorkspaceSessionSnapshot(
    workspace: WorkspaceInfo,
    sessionId: string,
    input: { limit?: number },
  ) {
    try {
      const opencode = createWorkspaceOpencodeClient(config, workspace);
      const [session, messages, todos, statuses] = await Promise.all([
        opencode.session
          .get({ sessionID: sessionId })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}`)),
        opencode.session
          .messages({ sessionID: sessionId, limit: input.limit })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}/message`)),
        opencode.session
          .todo({ sessionID: sessionId })
          .then((result) => unwrapOpencodeResult(result, `/session/${encodeURIComponent(sessionId)}/todo`)),
        opencode.session.status().then((result) => unwrapOpencodeResult(result, "/session/status")),
      ]);
      await requireWorkspaceSession(workspace, session);
      return buildSessionSnapshot({ session, messages, todos, statuses });
    } catch (error) {
      remapSessionReadError(error);
    }
  }

  async function updateWorkspaceSessionGroups(
    workspaceId: string,
    updater: (current: SessionGroupState) => SessionGroupState,
  ) {
    return updateSessionGroupState(config, workspaceId, updater);
  }

  function requireStringField(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, "invalid_payload", `${field} is required`);
    }
    return value.trim();
  }

  function optionalStringField(body: Record<string, unknown>, field: string): string | undefined {
    const value = body[field];
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string" || !value.trim()) {
      throw new ApiError(400, "invalid_payload", `${field} must be a non-empty string`);
    }
    return value.trim();
  }

  function parseExportFormat(value: string | null): "json" | "markdown" {
    const trimmed = (value ?? "").trim();
    if (!trimmed || trimmed === "json") return "json";
    if (trimmed === "markdown") return "markdown";
    throw new ApiError(400, "invalid_query", `Invalid export format: ${trimmed}`);
  }

  /**
   * Snapshots for a whole workspace, read one at a time.
   *
   * Each snapshot is four OpenCode calls, so a parallel fan-out over a large
   * workspace would hammer the engine. Sessions deleted mid-export are skipped
   * rather than failing the whole bundle.
   */
  async function collectWorkspaceSnapshots(
    workspace: WorkspaceInfo,
    input: { sessionLimit: number; messageLimit?: number },
  ): Promise<SessionSnapshotReadModel[]> {
    const sessions = await listWorkspaceSessions(workspace, { limit: input.sessionLimit });
    const snapshots: SessionSnapshotReadModel[] = [];
    for (const session of sessions.slice(0, input.sessionLimit)) {
      try {
        snapshots.push(await readWorkspaceSessionSnapshot(workspace, session.id, { limit: input.messageLimit }));
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) continue;
        throw error;
      }
    }
    return snapshots;
  }

  function exportResponse(
    bundle: SessionExportBundle,
    warnings: ReturnType<typeof buildSessionExportBundle>["warnings"],
    input: { format: "json" | "markdown"; sensitiveMode: SessionTransferSensitiveMode },
  ): Response {
    // Same contract as workspace export: refuse to guess when a transcript
    // looks like it carries secrets, and let the caller pick include/exclude.
    if (warnings.length && input.sensitiveMode === "auto") {
      throw new ApiError(
        409,
        "session_export_requires_decision",
        "These sessions include secret-like content. Choose whether to redact it or include it before exporting.",
        { warnings },
      );
    }
    if (input.format === "markdown") {
      return new Response(renderSessionBundleMarkdown(bundle), {
        status: 200,
        headers: { "Content-Type": "text/markdown; charset=utf-8" },
      });
    }
    return jsonResponse(bundle);
  }

  addRoute(routes, "POST", "/workspace/:id/sessions", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const title = requireStringField(body, "title");
    if (title.length > 120) {
      throw new ApiError(400, "invalid_payload", "title must be 120 characters or fewer");
    }
    const prompt = optionalStringField(body, "prompt");
    const providerId = optionalStringField(body, "providerId");
    const modelId = optionalStringField(body, "modelId");
    const variant = optionalStringField(body, "variant");
    if (Boolean(providerId) !== Boolean(modelId)) {
      throw new ApiError(400, "invalid_payload", "providerId and modelId must be provided together");
    }
    if (prompt && prompt.length > 100_000) {
      throw new ApiError(400, "invalid_payload", "prompt must be 100000 characters or fewer");
    }
    const result = await createWorkspaceSession(workspace, {
      title,
      ...(prompt ? { prompt } : {}),
      ...(providerId && modelId ? { providerId, modelId } : {}),
      ...(variant ? { variant } : {}),
    });
    return jsonResponse(result, 201);
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/abort", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = ctx.params.sessionId?.trim();
    if (!sessionId) throw new ApiError(400, "invalid_payload", "sessionId is required");
    await readWorkspaceSession(workspace, sessionId);
    console.info("[openwork-server] abort", {
      phase: "start",
      source: "workspace.sessions.abort_route",
      initiator: "user",
      reason: "client requested session abort through OpenWork server route",
      workspaceId: workspace.id,
      sessionID: sessionId,
      actorType: ctx.actor?.type ?? "unknown",
    });
    const result = await createWorkspaceOpencodeClient(config, workspace, { sessionId }).session.abort({ sessionID: sessionId });
    if (result.error !== undefined) {
      console.info("[openwork-server] abort", {
        phase: "error",
        source: "workspace.sessions.abort_route",
        initiator: "user",
        workspaceId: workspace.id,
        sessionID: sessionId,
        actorType: ctx.actor?.type ?? "unknown",
      });
      throw new ApiError(502, "opencode_request_failed", "OpenCode abort failed");
    }
    console.info("[openwork-server] abort", {
      phase: "done",
      source: "workspace.sessions.abort_route",
      initiator: "user",
      workspaceId: workspace.id,
      sessionID: sessionId,
      actorType: ctx.actor?.type ?? "unknown",
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listWorkspaceSessions(workspace, {
      roots: parseOptionalBoolean(ctx.url.searchParams.get("roots"), "roots"),
      start: parseOptionalNonNegativeInteger(ctx.url.searchParams.get("start"), "start"),
      search: ctx.url.searchParams.get("search")?.trim() || undefined,
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/session-groups", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const result = await readSessionGroupState(config, workspace.id);
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PUT", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const state = normalizeSessionGroupState(body.state);
    const result = await updateWorkspaceSessionGroups(workspace.id, () => state);
    sessionGroupEvents.record(workspace.id, "imported");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/session-groups", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const label = requireStringField(body, "label").slice(0, 120);
    const requestedId = typeof body.id === "string" ? body.id.trim().slice(0, 128) : "";
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const existingIds = new Set(current.groups.map((group) => group.id));
      const id = requestedId && !existingIds.has(requestedId) ? requestedId : createSessionGroupId();
      return { ...current, groups: [...current.groups, { id, label }] };
    });
    const groupId = result.state.groups[result.state.groups.length - 1]?.id;
    sessionGroupEvents.record(workspace.id, "created", groupId ? { groupId } : undefined);
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/reorder", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const requestedIds = Array.isArray(body.groupIds)
      ? body.groupIds.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean)
      : [];
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const byId = new Map(current.groups.map((group) => [group.id, group]));
      const used = new Set<string>();
      const groups: SessionGroupDefinition[] = [];
      for (const id of requestedIds) {
        const group = byId.get(id);
        if (!group || used.has(id)) continue;
        groups.push(group);
        used.add(id);
      }
      for (const group of current.groups) {
        if (!used.has(group.id)) groups.push(group);
      }
      return { ...current, groups };
    });
    sessionGroupEvents.record(workspace.id, "reordered");
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/assignments/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) throw new ApiError(400, "invalid_payload", "sessionId is required");
    const body = await readJsonBody(ctx.request);
    const groupId = typeof body.groupId === "string" && body.groupId.trim() ? body.groupId.trim() : null;
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const assignments = { ...current.assignments };
      if (groupId && current.groups.some((group) => group.id === groupId)) {
        assignments[sessionId] = groupId;
      } else {
        delete assignments[sessionId];
      }
      return { ...current, assignments };
    });
    sessionGroupEvents.record(workspace.id, "assigned", { sessionId, ...(groupId ? { groupId } : {}) });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "PATCH", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const groupId = (ctx.params.groupId ?? "").trim();
    if (!groupId) throw new ApiError(400, "invalid_payload", "groupId is required");
    const body = await readJsonBody(ctx.request);
    const label = requireStringField(body, "label").slice(0, 120);
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => ({
      ...current,
      groups: current.groups.map((group) => group.id === groupId ? { ...group, label } : group),
    }));
    sessionGroupEvents.record(workspace.id, "updated", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "DELETE", "/workspace/:id/session-groups/:groupId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const groupId = (ctx.params.groupId ?? "").trim();
    if (!groupId) throw new ApiError(400, "invalid_payload", "groupId is required");
    const requestedDestinationGroupId = ctx.url.searchParams.get("destinationGroupId")?.trim() || null;
    const result = await updateWorkspaceSessionGroups(workspace.id, (current) => {
      const destinationGroupId = requestedDestinationGroupId && current.groups.some(
        (group) => group.id === requestedDestinationGroupId && group.id !== groupId,
      ) ? requestedDestinationGroupId : null;
      const assignments: Record<string, string> = {};
      for (const [sessionId, assignedGroupId] of Object.entries(current.assignments)) {
        if (assignedGroupId !== groupId) {
          assignments[sessionId] = assignedGroupId;
        } else if (destinationGroupId) {
          assignments[sessionId] = destinationGroupId;
        }
      }
      return {
        groups: current.groups.filter((group) => group.id !== groupId),
        assignments,
      };
    });
    sessionGroupEvents.record(workspace.id, "deleted", { groupId });
    return jsonResponse({ state: result.state, updatedAt: result.updatedAt });
  });

  addRoute(routes, "GET", "/workspace/:id/session-groups/events", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const sinceRaw = ctx.url.searchParams.get("since");
    const since = sinceRaw ? Number(sinceRaw) : undefined;
    const items = sessionGroupEvents.list(workspace.id, since);
    return jsonResponse({ items, cursor: sessionGroupEvents.cursor(workspace.id), workspaceId: workspace.id });
  });

  // Registered before "/workspace/:id/sessions/:sessionId" so the literal
  // "export" segment is not captured as a session id, matching how
  // "/session-groups/reorder" precedes "/session-groups/:groupId" above.
  addRoute(routes, "GET", "/workspace/:id/sessions/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const format = parseExportFormat(ctx.url.searchParams.get("format"));
    const sensitiveMode = parseExportSensitiveMode(ctx.url.searchParams.get("sensitive"));
    const sessionLimit = Math.min(
      parseOptionalPositiveInteger(ctx.url.searchParams.get("sessions"), "sessions") ?? MAX_IMPORT_SESSIONS,
      MAX_IMPORT_SESSIONS,
    );
    const snapshots = await collectWorkspaceSnapshots(workspace, {
      sessionLimit,
      messageLimit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    const { bundle, warnings } = buildSessionExportBundle({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      snapshots,
      sensitiveMode,
    });
    return exportResponse(bundle, warnings, { format, sensitiveMode });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/import", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);

    let planned;
    let bundle;
    try {
      bundle = parseSessionExportBundle(body);
      planned = planSessionImport(bundle);
    } catch (error) {
      if (error instanceof SessionBundleError) {
        throw new ApiError(400, "invalid_session_bundle", error.message, error.issues ? { issues: error.issues } : undefined);
      }
      throw error;
    }

    const workspaceRoot = resolveOpencodeDirectory(workspace) ?? workspace.path;
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    const imported: Array<{ sourceSessionId: string; sessionId: string; title: string; messages: number }> = [];
    const marks: Array<{ sessionId: string; mark: SessionImportMark }> = [];
    const importedAt = Date.now();
    const sourceWorkspaceName = bundle.workspaceName?.trim() || bundle.workspaceId;

    // Import never touches an existing session: every entry becomes a new one.
    for (const entry of planned) {
      const created = buildSession(
        unwrapOpencodeResult(await opencode.session.create({ title: entry.title }), "/session"),
      );
      const result = seedOpencodeSessionMessages({
        sessionId: created.id,
        workspaceRoot,
        messages: entry.messages,
      });
      imported.push({
        sourceSessionId: entry.sourceSessionId,
        sessionId: created.id,
        title: entry.title,
        messages: result.inserted,
      });
      marks.push({
        sessionId: created.id,
        mark: {
          sourceWorkspaceId: bundle.workspaceId,
          sourceWorkspaceName,
          sourceSessionId: entry.sourceSessionId,
          importedAt,
        },
      });
    }

    // Recorded after the sessions exist so a crash can never mark a session
    // that was not created.
    await recordSessionImports(config, workspace.id, marks);

    return jsonResponse({ ok: true, imported }, 201);
  });

  addRoute(routes, "GET", "/workspace/:id/session-imports", "client", async (ctx) => {
    const workspace = await resolveWorkspaceWithoutBootstrap(config, ctx.params.id);
    const result = await readSessionImportState(config, workspace.id);
    return jsonResponse({ marks: result.state.marks, updatedAt: result.updatedAt });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const format = parseExportFormat(ctx.url.searchParams.get("format"));
    const sensitiveMode = parseExportSensitiveMode(ctx.url.searchParams.get("sensitive"));
    const snapshot = await readWorkspaceSessionSnapshot(workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    const { bundle, warnings } = buildSessionExportBundle({
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      snapshots: [snapshot],
      sensitiveMode,
    });
    return exportResponse(bundle, warnings, { format, sensitiveMode });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const item = await readWorkspaceSession(workspace, sessionId);
    return jsonResponse({ item });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/messages", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const items = await readWorkspaceSessionMessages(workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/snapshot", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const item = await readWorkspaceSessionSnapshot(workspace, sessionId, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
    });
    return jsonResponse({ item });
  });

  addRoute(routes, "DELETE", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");

    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }

    await readWorkspaceSession(workspace, sessionId);
    const opencode = createWorkspaceOpencodeClient(config, workspace);
    unwrapOpencodeResult(
      await opencode.session.delete({ sessionID: sessionId }),
      `/session/${encodeURIComponent(sessionId)}`,
    );
    // Deleting an imported session drops its provenance too, so the marks
    // cannot outlive the sessions they describe.
    await forgetSessionImport(config, workspace.id, sessionId);

    return jsonResponse({ ok: true });
  });
}
