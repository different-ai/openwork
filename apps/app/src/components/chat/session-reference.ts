import { getDisplaySessionTitle } from "@/app/lib/session-title";
import type { Session } from "@opencode-ai/sdk/v2/client";

export type SessionMetadataRuntime = {
  workspaceId: string;
  runtimeWorkspaceId: string;
  opencodeBaseUrl: string;
  openworkToken: string;
};

export type SessionMetadataCallbacks = {
  onSessionCreated: (session: Session) => void;
  onSessionUpdated: (update: { sessionId: string; info: Record<string, unknown> }) => void;
  onSessionDeleted: (sessionId: string) => void;
};

export type SessionReferenceIdentity = {
  workspaceId: string;
  sessionId: string;
};

export type SessionReference = SessionReferenceIdentity & {
  title: string;
  archived?: boolean;
};

export type SessionReferenceMetadata = {
  id: string;
  title?: string | null;
  time?: { archived?: number | null };
};

export type SessionReferenceInventory = {
  workspaceId: string;
  available: boolean;
  sessions: readonly SessionReferenceMetadata[];
};

export type ParsedSessionReference = {
  workspaceId?: string;
  sessionId: string;
};

const bareSessionId = /^ses_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const routeSegment = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function isRouteSegment(value: string): boolean {
  return !/[\s\u0000-\u001f\u007f]/.test(value) && routeSegment.test(value);
}

function decodeSegment(value: string): string | undefined {
  try {
    const decoded = decodeURIComponent(value);
    return isRouteSegment(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function parseSessionReference(rawHrefOrId: string): ParsedSessionReference | undefined {
  if (/[\s\u0000-\u001f\u007f?#\\]/.test(rawHrefOrId)) return undefined;
  if (bareSessionId.test(rawHrefOrId)) return { sessionId: rawHrefOrId };
  const scoped = /^\/workspace\/([^/]+)\/session\/([^/]+)$/.exec(rawHrefOrId);
  if (scoped) {
    const workspaceId = decodeSegment(scoped[1]);
    const sessionId = decodeSegment(scoped[2]);
    return workspaceId && sessionId ? { workspaceId, sessionId } : undefined;
  }
  const legacy = /^\/session\/([^/]+)$/.exec(rawHrefOrId);
  const sessionId = legacy ? decodeSegment(legacy[1]) : undefined;
  return sessionId ? { sessionId } : undefined;
}

export function sessionReferenceKey(reference: SessionReferenceIdentity): string {
  return JSON.stringify([reference.workspaceId, reference.sessionId]);
}

export function sessionReferenceHref(reference: SessionReferenceIdentity): string {
  return `/workspace/${encodeURIComponent(reference.workspaceId)}/session/${encodeURIComponent(reference.sessionId)}`;
}

export function isSessionReferenceInventoryCurrent(
  currentScope: string | null,
  loadedScope: string | undefined,
): boolean {
  return currentScope !== null && currentScope.length > 0 && currentScope === loadedScope;
}

export function createSessionReferenceIndex(inventories: readonly SessionReferenceInventory[]) {
  const byPair = new Map<string, SessionReference>();
  const bySessionId = new Map<string, SessionReference | undefined>();
  const unavailableWorkspaceIds = new Set(inventories.filter((inventory) => !inventory.available).map((inventory) => inventory.workspaceId));
  for (const inventory of inventories) {
    if (unavailableWorkspaceIds.has(inventory.workspaceId)) continue;
    for (const session of inventory.sessions) {
      const identity = { workspaceId: inventory.workspaceId, sessionId: session.id };
      if (!isRouteSegment(identity.workspaceId) || !isRouteSegment(identity.sessionId)) continue;
      const key = sessionReferenceKey(identity);
      if (byPair.has(key)) continue;
      const reference: SessionReference = {
        ...identity,
        title: getDisplaySessionTitle(session.title),
        archived: Boolean(session.time?.archived),
      };
      byPair.set(key, reference);
      bySessionId.set(session.id, bySessionId.has(session.id) ? undefined : reference);
    }
  }
  return {
    // Ignore inventory ordering and activity-only metadata so a title resolver
    // does not invalidate every memoized message on unrelated session events.
    revision: JSON.stringify([
      [...unavailableWorkspaceIds].sort(),
      [...byPair.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ]),
    resolve(rawHrefOrId: string): SessionReference | undefined {
      const parsed = parseSessionReference(rawHrefOrId);
      if (!parsed) return undefined;
      return parsed.workspaceId
        ? byPair.get(sessionReferenceKey({ workspaceId: parsed.workspaceId, sessionId: parsed.sessionId }))
        : unavailableWorkspaceIds.size === 0 ? bySessionId.get(parsed.sessionId) : undefined;
    },
    get(reference: SessionReferenceIdentity): SessionReference | undefined {
      return byPair.get(sessionReferenceKey(reference));
    },
  };
}
