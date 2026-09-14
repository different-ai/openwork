import { z } from "zod";
import {
  matchingOpenworkModelSessions,
  openworkModelSessionSchema,
  openworkSessionRebindModelArgsSchema,
  openworkSessionSetModelArgsSchema,
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
  sessions: (workspace: Workspace) => Promise<unknown>;
}) {
  const inventory = async (workspace: Workspace) => z.array(openworkModelSessionSchema).parse(await deps.sessions(workspace))
    .filter((session) => session.directory === workspace.path);
  const save = (workspaceId: string, sessions: Array<{ id: string; title?: string }>, model: OpenworkSessionModel, dryRun: boolean) => {
    if (!dryRun) useSessionModelStore.getState().setModels(sessions.map((session) => session.id), {
      model: { providerID: model.providerId, modelID: model.modelId }, variant: model.variant,
    });
    return { ok: true, workspaceId, model, sessions: sessions.map((session) => ({ sessionId: session.id, title: session.title ?? session.id })),
      count: sessions.length, dryRun, savedLocally: !dryRun, appliesOn: "next_send", engineBindingUpdated: false };
  };
  return {
    async setModel(rawArgs: unknown) {
      const args = openworkSessionSetModelArgsSchema.parse(rawArgs);
      const matches = (await Promise.all(deps.workspaces.map(async (workspace) => ({
        workspace, sessions: (await inventory(workspace)).filter((session) => session.id === args.sessionId),
      })))).filter((entry) => entry.sessions.length > 0);
      const match = matches[0];
      if (matches.length !== 1 || !match) throw new Error("Session is missing or ambiguous.");
      if (match.sessions.some((session) => (session.time?.archived ?? 0) > 0)) throw new Error("Archived sessions cannot be repicked.");
      const catalog = await deps.catalog(match.workspace);
      const selector = args.model ?? { alias: args.alias };
      return save(match.workspace.id, match.sessions, resolveOpenworkModel(selector, catalog), args.dryRun === true);
    },
    async rebindModel(rawArgs: unknown) {
      const args = openworkSessionRebindModelArgsSchema.parse(rawArgs);
      const workspace = deps.workspaces.find((entry) => entry.id === args.workspaceId);
      if (!workspace) throw new Error("Workspace was not found; use its exact id.");
      const model = resolveOpenworkModel(args.to, await deps.catalog(workspace));
      const sessions = matchingOpenworkModelSessions(await inventory(workspace), args.from, localSessionModel);
      if (args.expectedSessionIds && (args.expectedSessionIds.length !== sessions.length || sessions.some((session) => !args.expectedSessionIds?.includes(session.id)))) {
        throw new Error("Matching sessions changed. Preview again before confirming.");
      }
      return save(workspace.id, sessions, model, args.dryRun === true);
    },
  };
}
