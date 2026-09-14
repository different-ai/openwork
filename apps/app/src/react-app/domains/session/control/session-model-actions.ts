import { z } from "zod";
import {
  matchingOpenworkModelSessions,
  openworkModelSessionSchema,
  openworkSessionRebindModelArgsSchema,
  openworkSessionSetModelArgsSchema,
  openworkSessionModelPreflightArgsSchema,
  resolveOpenworkModel,
  type OpenworkCatalogModel,
  type OpenworkSessionModel,
} from "@openwork/types/openwork-affordance";
import { getSessionModelSelection, useSessionModelStore } from "../surface/session-model-store";

export function localSessionModel(sessionId: string): OpenworkSessionModel | null {
  const local = getSessionModelSelection(sessionId);
  return local ? { providerId: local.model.providerID, modelId: local.model.modelID, variant: local.variant } : null;
}

export type SessionModelWorkspace = { id: string; path: string };

export function createSessionModelActions<Workspace extends SessionModelWorkspace>(deps: {
  workspaces: Workspace[];
  catalog: (workspace: Workspace) => Promise<OpenworkCatalogModel[]>;
  directory: (workspace: Workspace) => Promise<string>;
  sessions: (workspace: Workspace) => Promise<unknown>;
  session?: (workspace: Workspace, sessionId: string) => Promise<unknown>;
  held?: (workspace: Workspace, sessionId: string) => boolean;
}) {
  const ownerDirectory = async (workspace: Workspace) => z.string().min(1).parse(await deps.directory(workspace));
  const inventory = async (workspace: Workspace) => {
    const owner = await ownerDirectory(workspace);
    return z.array(openworkModelSessionSchema).parse(await deps.sessions(workspace)).filter((session) => session.directory === owner);
  };
  const readSession = async (workspace: Workspace, sessionId: string) => {
    const owner = await ownerDirectory(workspace);
    const session = openworkModelSessionSchema.parse(deps.session ? await deps.session(workspace, sessionId) : (await inventory(workspace)).find((session) => session.id === sessionId));
    if (session.id !== sessionId || session.directory !== owner) throw new Error("Session does not belong to this workspace.");
    return session;
  };
  const save = (workspaceId: string, sessions: Array<{ id: string; title?: string }>, model: OpenworkSessionModel, dryRun: boolean) => {
    if (!dryRun) useSessionModelStore.getState().setModels(sessions.map((session) => session.id), {
      model: { providerID: model.providerId, modelID: model.modelId }, variant: model.variant,
    });
    return { ok: true, workspaceId, model, sessions: sessions.map((session) => ({ sessionId: session.id, title: session.title ?? session.id })),
      count: sessions.length, dryRun, savedLocally: !dryRun, appliesOn: "next_send", engineBindingUpdated: false };
  };
  return {
    async preflight(rawArgs: unknown) {
      const args = openworkSessionModelPreflightArgsSchema.parse(rawArgs);
      const workspace = deps.workspaces.find((entry) => entry.id === args.workspaceId);
      if (!workspace) throw new Error("Workspace was not found.");
      const catalog = await deps.catalog(workspace);
      const selected = localSessionModel(args.sessionId) ?? args.model;
      return { ok: true, workspaceId: workspace.id, sessionId: args.sessionId, model: selected ? resolveOpenworkModel(selected, catalog) : null };
    },
    async setModel(rawArgs: unknown) {
      const args = openworkSessionSetModelArgsSchema.parse(rawArgs);
      const previous = getSessionModelSelection(args.sessionId);
      let workspace = args.workspaceId ? deps.workspaces.find((entry) => entry.id === args.workspaceId) : undefined;
      if (args.workspaceId && !workspace) throw new Error("Workspace was not found; use its exact id.");
      if (!args.workspaceId) {
        const matches = (await Promise.all(deps.workspaces.map(async (workspace) => ({
          workspace, sessions: (await inventory(workspace)).filter((session) => session.id === args.sessionId),
        }))).catch(() => { throw new Error("Session inventory unavailable; pass exact workspaceId to avoid unrelated workspace reads."); })).filter((entry) => entry.sessions.length > 0);
        if (matches.length !== 1) throw new Error("Session is missing or ambiguous; pass workspaceId.");
        workspace = matches[0]?.workspace;
      }
      if (!workspace) throw new Error("Session workspace unavailable; pass workspaceId.");
      const catalog = await deps.catalog(workspace);
      const session = await readSession(workspace, args.sessionId);
      if ((session.time?.archived ?? 0) > 0 || deps.held?.(workspace, args.sessionId)) throw new Error("Archived or held sessions cannot be repicked.");
      if (getSessionModelSelection(args.sessionId) !== previous) throw new Error("Local selection changed; preview again before confirming.");
      const selector = args.model ?? { alias: args.alias };
      return save(workspace.id, [session], resolveOpenworkModel(selector, catalog), args.dryRun === true);
    },
    async rebindModel(rawArgs: unknown) {
      const args = openworkSessionRebindModelArgsSchema.parse(rawArgs);
      const workspace = deps.workspaces.find((entry) => entry.id === args.workspaceId);
      if (!workspace) throw new Error("Workspace was not found; use its exact id.");
      const previous = useSessionModelStore.getState().bySessionId;
      const model = resolveOpenworkModel(args.to, await deps.catalog(workspace));
      const sessions = matchingOpenworkModelSessions(await inventory(workspace), args.from, localSessionModel);
      if (sessions.some((session) => deps.held?.(workspace, session.id) || getSessionModelSelection(session.id) !== (previous[session.id] ?? null))) {
        throw new Error("Session selection or archive state changed; preview again before confirming.");
      }
      if (args.expectedSessionIds && (args.expectedSessionIds.length !== sessions.length || sessions.some((session) => !args.expectedSessionIds?.includes(session.id)))) {
        throw new Error("Matching sessions changed. Preview again before confirming.");
      }
      return save(workspace.id, sessions, model, args.dryRun === true);
    },
  };
}
