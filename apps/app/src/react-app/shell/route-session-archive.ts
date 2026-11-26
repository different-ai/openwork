import type { RouteSession } from "./route-workspaces";

export function withArchiveTime(session: RouteSession, archived: number): RouteSession {
  if ((session.time.archived ?? 0) === archived) return session;
  return { ...session, time: { ...session.time, archived } };
}

type Confirmation = { archived: number; updated: number; revision: number };

export function createRouteArchiveReconciler() {
  let revision = 0;
  const confirmed = new Map<string, Map<string, Confirmation>>();
  return {
    revision: () => revision,
    clear: (workspaceId: string) => confirmed.delete(workspaceId),
    remove: (workspaceId: string, sessionId: string) => confirmed.get(workspaceId)?.delete(sessionId),
    confirm(workspaceId: string, sessionId: string, archived: number, updated: number) {
      let workspace = confirmed.get(workspaceId);
      if (!workspace) confirmed.set(workspaceId, workspace = new Map());
      workspace.set(sessionId, { archived, updated, revision: ++revision });
    },
    reconcile(workspaceId: string, session: RouteSession, observation: { listRevision: number } | { eventUpdated?: number }) {
      const workspace = confirmed.get(workspaceId);
      const change = workspace?.get(session.id);
      if (!change) return session;
      if ("listRevision" in observation) {
        if (observation.listRevision < change.revision || session.time.updated < change.updated) {
          return withArchiveTime(session, change.archived);
        }
        change.archived = session.time.archived ?? 0;
        change.updated = session.time.updated;
        return session;
      }
      if (observation.eventUpdated === undefined || observation.eventUpdated <= change.updated) return withArchiveTime(session, change.archived);
      change.archived = session.time.archived ?? 0;
      change.updated = observation.eventUpdated;
      return session;
    },
  };
}
