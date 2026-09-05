import { ApiError } from "../errors.js";
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
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterSessionGroupRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  resolveWorkspaceWithoutBootstrap: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

export function registerSessionGroupRoutes(options: RegisterSessionGroupRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    resolveWorkspaceWithoutBootstrap,
  } = options;
  const sessionGroupEvents = new SessionGroupEventStore();

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

}
