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
import type { OpenworkControlHelpers } from "../../../shell/control/control-provider";
import { getSessionModelSelection, useSessionModelStore } from "../surface/session-model-store";

export function localSessionModel(sessionId: string): OpenworkSessionModel | null {
  const local = getSessionModelSelection(sessionId);
  return local ? { providerId: local.model.providerID, modelId: local.model.modelID, variant: local.variant } : null;
}

export type SessionModelWorkspace = { id: string; path: string };

type ModelRead = <T>(operation: () => Promise<T>) => Promise<T>;

export class SessionModelTargetSetChangedError extends Error {
  readonly code = "model_repick_target_set_changed";

  constructor(
    readonly expectedSessionIds: string[],
    readonly currentSessionIds: string[],
  ) {
    super("Matching sessions changed. Preview again before confirming.");
    this.name = "SessionModelTargetSetChangedError";
  }
}

function mutationDeadline(now: () => number, requestCreatedAt?: number) {
  const startedAt = now();
  const expired = () => new Error("Model repick timed out; no selections changed. Preview again before confirming.");
  const age = requestCreatedAt === undefined ? 0 : Date.now() - requestCreatedAt;
  if (requestCreatedAt !== undefined && (!Number.isSafeInteger(requestCreatedAt) || requestCreatedAt <= 0 || age < 0)) throw expired();
  const deadline = startedAt + 4_000 - age;
  const checkDeadline = () => { if (now() >= deadline) throw expired(); };
  checkDeadline();
  const read: ModelRead = async (operation) => {
    checkDeadline();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(expired()), deadline - now());
    });
    try {
      const result = await Promise.race([operation(), timeout]);
      checkDeadline();
      return result;
    } finally { clearTimeout(timer); }
  };
  return { read, checkDeadline };
}

export function createSessionModelActions<Workspace extends SessionModelWorkspace>(deps: {
  workspaces: Workspace[];
  catalog: (workspace: Workspace) => Promise<OpenworkCatalogModel[]>;
  directory: (workspace: Workspace) => Promise<string>;
  sessions: (workspace: Workspace) => Promise<unknown>;
  statuses: (workspace: Workspace) => Promise<{ data?: unknown; error?: unknown; response?: { status: number } }>;
  session?: (workspace: Workspace, sessionId: string) => Promise<unknown>;
  held?: (workspace: Workspace, sessionId: string) => boolean;
  working?: (workspace: Workspace, sessionId: string) => boolean;
  now?: () => number;
}) {
  const now = deps.now ?? (() => performance.now());
  const readStatuses = async (workspace: Workspace, read: ModelRead) => {
    const result = await read(() => deps.statuses(workspace));
    if (result.response?.status !== 200 || result.error !== undefined) throw new Error("Session activity unavailable; no selections changed.");
    return z.record(z.string(), z.discriminatedUnion("type", [
      z.object({ type: z.literal("idle") }),
      z.object({ type: z.literal("busy") }),
      z.object({ type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number() }),
    ])).parse(result.data);
  };
  const ownerDirectory = async (workspace: Workspace, read: ModelRead) => z.string().min(1).parse(await read(() => deps.directory(workspace)));
  const inventory = async (workspace: Workspace, read: ModelRead) => {
    const owner = await ownerDirectory(workspace, read);
    return z.array(openworkModelSessionSchema).parse(await read(() => deps.sessions(workspace))).filter((session) => session.directory === owner);
  };
  const readSession = async (workspace: Workspace, sessionId: string, read: ModelRead) => {
    const owner = await ownerDirectory(workspace, read);
    const getSession = deps.session;
    const session = openworkModelSessionSchema.parse(getSession ? await read(() => getSession(workspace, sessionId)) : (await inventory(workspace, read)).find((entry) => entry.id === sessionId));
    if (session.id !== sessionId || session.directory !== owner) throw new Error("Session does not belong to this workspace.");
    return session;
  };
  const save = (workspaceId: string, sessions: Array<{ id: string; title?: string }>, model: OpenworkSessionModel, dryRun: boolean, checkDeadline: () => void) => {
    checkDeadline();
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
    async setModel(rawArgs: unknown, helpers?: Pick<OpenworkControlHelpers, "requestCreatedAt">) {
      const { read, checkDeadline } = mutationDeadline(now, helpers?.requestCreatedAt);
      const args = openworkSessionSetModelArgsSchema.parse(rawArgs);
      const previous = getSessionModelSelection(args.sessionId);
      let workspace = args.workspaceId ? deps.workspaces.find((entry) => entry.id === args.workspaceId) : undefined;
      if (args.workspaceId && !workspace) throw new Error("Workspace was not found; use its exact id.");
      if (!args.workspaceId) {
        const matches = (await Promise.all(deps.workspaces.map(async (candidate) => ({
          workspace: candidate, sessions: (await inventory(candidate, read)).filter((session) => session.id === args.sessionId),
        }))).catch(() => { throw new Error("Session inventory unavailable; pass exact workspaceId to avoid unrelated workspace reads."); })).filter((entry) => entry.sessions.length > 0);
        if (matches.length !== 1) throw new Error("Session is missing or ambiguous; pass workspaceId.");
        workspace = matches[0]?.workspace;
      }
      if (!workspace) throw new Error("Session workspace unavailable; pass workspaceId.");
      const targetWorkspace = workspace;
      const catalog = await read(() => deps.catalog(targetWorkspace));
      const session = await readSession(targetWorkspace, args.sessionId, read);
      const model = resolveOpenworkModel(args.model ?? { alias: args.alias }, catalog);
      const statuses = await readStatuses(targetWorkspace, read);
      if ((session.time?.archived ?? 0) > 0 || deps.held?.(targetWorkspace, args.sessionId)) throw new Error("Archived or held sessions cannot be repicked.");
      if (statuses[session.id] && statuses[session.id].type !== "idle" || deps.working?.(targetWorkspace, args.sessionId)) throw new Error("Working sessions cannot be repicked. Wait until the session is idle.");
      if (getSessionModelSelection(args.sessionId) !== previous) throw new Error("Local selection changed; preview again before confirming.");
      return save(targetWorkspace.id, [session], model, args.dryRun === true, checkDeadline);
    },
    async rebindModel(rawArgs: unknown, helpers?: Pick<OpenworkControlHelpers, "requestCreatedAt">) {
      const { read, checkDeadline } = mutationDeadline(now, helpers?.requestCreatedAt);
      const args = openworkSessionRebindModelArgsSchema.parse(rawArgs);
      const workspace = deps.workspaces.find((entry) => entry.id === args.workspaceId);
      if (!workspace) throw new Error("Workspace was not found; use its exact id.");
      const previous = useSessionModelStore.getState().bySessionId;
      const catalog = await read(() => deps.catalog(workspace));
      if (catalog.some((model) => model.providerId === args.from.providerId && model.modelId === args.from.modelId)) {
        throw new Error("Source model is still available. Bulk repick only replaces the same unavailable model.");
      }
      const model = resolveOpenworkModel(args.to, catalog);
      const candidates = await inventory(workspace, read);
      const statuses = await readStatuses(workspace, read);
      const sessions = matchingOpenworkModelSessions(candidates, args.from, localSessionModel);
      if (sessions.some((session) => statuses[session.id] && statuses[session.id].type !== "idle" || deps.working?.(workspace, session.id))) throw new Error("Working sessions cannot be repicked. Wait until all matching sessions are idle.");
      if (sessions.some((session) => deps.held?.(workspace, session.id) || getSessionModelSelection(session.id) !== (previous[session.id] ?? null))) {
        throw new Error("Session selection or archive state changed; preview again before confirming.");
      }
      if (args.expectedSessionIds && (args.expectedSessionIds.length !== sessions.length || sessions.some((session) => !args.expectedSessionIds?.includes(session.id)))) {
        throw new SessionModelTargetSetChangedError(args.expectedSessionIds, sessions.map((session) => session.id));
      }
      return save(workspace.id, sessions, model, args.dryRun === true, checkDeadline);
    },
  };
}
