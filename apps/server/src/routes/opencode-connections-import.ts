import { z } from "zod";

import { ApiError } from "../errors.js";
import {
  OPENCODE_CONNECTIONS_IMPORT_LIMITS,
  opencodeUserConfigPaths,
  readOpencodeConnections,
  type OpencodeConfigStatus,
  type OpencodeConnectionKind,
} from "../opencode-connections-import.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export type OpencodeConnectionPreviewStatus = "new" | "already_present" | "invalid" | "blocked";

/** One connection in the person's OpenCode config. Carries no arguments, environment, headers or credentials. */
export type OpencodeConnectionPreviewItem = {
  name: string;
  kind?: OpencodeConnectionKind;
  target?: string;
  status: OpencodeConnectionPreviewStatus;
  /** Why it cannot be imported, in words a person can act on. */
  reason?: string;
};

export type OpencodeConnectionsPreview = { source: OpencodeConfigStatus; items: OpencodeConnectionPreviewItem[] };

export type OpencodeConnectionImportResult = {
  name: string;
  status: "imported" | "already_present" | "invalid" | "blocked" | "failed";
  message?: string;
};

/**
 * How one workspace takes connections. The server wires these to the same
 * steps as adding a connection by hand, so validation, organization rules and
 * the running engine treat an imported connection exactly like a typed one.
 */
export type OpencodeConnectionsImportTarget = {
  /** Names OpenWork already has for this workspace. */
  existingNames(): Promise<Set<string>>;
  /** Throws `organization_policy_denied` when the organization does not allow this connection. */
  checkPolicy(name: string): Promise<void>;
  /** Saves one connection and registers it with the running engine. */
  add(name: string, config: Record<string, unknown>): Promise<void>;
};

const BLOCKED_REASON = "Your organization does not allow this connection.";
const FAILED_MESSAGE = "OpenWork could not save this connection.";

async function blockedByPolicy(target: OpencodeConnectionsImportTarget, name: string): Promise<boolean> {
  try {
    await target.checkPolicy(name);
    return false;
  } catch (error) {
    if (error instanceof ApiError && error.code === "organization_policy_denied") return true;
    throw error;
  }
}

/** What importing would do, without changing anything. */
export async function previewOpencodeConnections(
  target: OpencodeConnectionsImportTarget,
  paths: string[] = opencodeUserConfigPaths(),
): Promise<OpencodeConnectionsPreview> {
  const source = await readOpencodeConnections(paths);
  const existing = source.connections.length > 0 ? await target.existingNames() : new Set<string>();
  const items: OpencodeConnectionPreviewItem[] = source.problems.map((problem) => ({
    name: problem.name,
    status: "invalid",
    reason: problem.reason,
  }));
  for (const connection of source.connections) {
    const shown = { name: connection.name, kind: connection.kind, target: connection.target };
    if (existing.has(connection.name)) items.push({ ...shown, status: "already_present" });
    else if (await blockedByPolicy(target, connection.name)) items.push({ ...shown, status: "blocked", reason: BLOCKED_REASON });
    else items.push({ ...shown, status: "new" });
  }
  return { source: source.status, items: items.sort((a, b) => a.name.localeCompare(b.name)) };
}

/**
 * Copy the chosen connections into OpenWork. A name OpenWork already has is
 * left as is, never overwritten: the person may have changed it here. Each
 * name gets one result, and one failure does not stop the rest. Results never
 * include error text from the save, which could quote a secret.
 */
export async function importOpencodeConnections(
  target: OpencodeConnectionsImportTarget,
  names: string[],
  paths: string[] = opencodeUserConfigPaths(),
): Promise<OpencodeConnectionImportResult[]> {
  const source = await readOpencodeConnections(paths);
  const connections = new Map(source.connections.map((connection) => [connection.name, connection]));
  const problems = new Map(source.problems.map((problem) => [problem.name, problem.reason]));
  const existing = await target.existingNames();
  const results: OpencodeConnectionImportResult[] = [];
  for (const name of [...new Set(names)]) {
    const connection = connections.get(name);
    if (!connection) {
      results.push({ name, status: "invalid", message: problems.get(name) ?? "It is no longer in your OpenCode config." });
      continue;
    }
    if (existing.has(name)) { results.push({ name, status: "already_present" }); continue; }
    try {
      if (await blockedByPolicy(target, name)) { results.push({ name, status: "blocked", message: BLOCKED_REASON }); continue; }
      await target.add(name, connection.config);
      existing.add(name);
      results.push({ name, status: "imported" });
    } catch (error) {
      if (error instanceof ApiError && error.code === "organization_policy_denied") {
        results.push({ name, status: "blocked", message: BLOCKED_REASON });
      } else {
        results.push({ name, status: "failed", message: FAILED_MESSAGE });
      }
    }
  }
  return results;
}

const importSchema = z.object({
  names: z.array(z.string().min(1).max(200)).min(1).max(OPENCODE_CONNECTIONS_IMPORT_LIMITS.connections),
}).strict();

interface RegisterOpencodeConnectionsImportRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  targetFor: (ctx: RequestContext, workspace: WorkspaceInfo) => OpencodeConnectionsImportTarget;
  /** Asks the person once for the whole import, as adding a connection by hand does. */
  requireApproval: (ctx: RequestContext, workspace: WorkspaceInfo, names: string[]) => Promise<void>;
  /** Defaults to the person's own OpenCode config files on each request. */
  configPaths?: string[];
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBody: (request: Request) => Promise<unknown>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

/**
 * Import the connections a person set up in their own OpenCode config.
 *
 * - GET /workspace/:id/opencode-import/connections lists them and whether
 *   OpenWork has each one already.
 * - POST /workspace/:id/opencode-import/connections { names } copies the
 *   chosen ones into OpenWork and reports each result.
 *
 * The person's OpenCode files are read, never written.
 */
export function registerOpencodeConnectionsImportRoutes(options: RegisterOpencodeConnectionsImportRoutesOptions): void {
  const { routes, config, targetFor, jsonResponse, readJsonBody, ensureWritable, requireClientScope, resolveWorkspace } = options;
  const paths = () => options.configPaths ?? opencodeUserConfigPaths();

  addRoute(routes, "GET", "/workspace/:id/opencode-import/connections", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse(await previewOpencodeConnections(targetFor(ctx, workspace), paths()));
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-import/connections", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const parsed = importSchema.safeParse(await readJsonBody(ctx.request));
    if (!parsed.success) throw new ApiError(400, "invalid_payload", "Choose at least one connection.");
    await options.requireApproval(ctx, workspace, parsed.data.names);
    return jsonResponse({ results: await importOpencodeConnections(targetFor(ctx, workspace), parsed.data.names, paths()) });
  });
}
