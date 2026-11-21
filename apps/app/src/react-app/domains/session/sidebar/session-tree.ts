import { SESSION_LINK_MAX_DEPTH, type SessionLinkKind } from "@openwork/types/session-link";

import { t } from "../../../../i18n";
import { isSessionArchived, type SessionListItem } from "./utils";

export type SessionTreeChild = {
  session: SessionListItem;
  kind: SessionLinkKind;
  depth: number;
};

export type SessionTreeParent = { sessionId: string; kind: SessionLinkKind };

export type SessionTree = {
  nestedIds: ReadonlySet<string>;
  descendantsOf: (sessionId: string) => readonly SessionTreeChild[];
  parentOf: (sessionId: string) => SessionTreeParent | undefined;
  depthOf: (sessionId: string) => number;
};

const NO_CHILDREN: readonly SessionTreeChild[] = [];

export const EMPTY_SESSION_TREE: SessionTree = {
  nestedIds: new Set(),
  descendantsOf: () => NO_CHILDREN,
  parentOf: () => undefined,
  depthOf: () => 0,
};

const createdAt = (session: SessionListItem) => {
  const value = session.time?.created;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

export function buildSessionTree(
  sessions: readonly SessionListItem[],
  options: { standaloneIds?: ReadonlySet<string> } = {},
): SessionTree {
  const listed = new Map<string, SessionListItem>();
  for (const session of sessions) {
    if (session.parentID?.trim() || isSessionArchived(session)) continue;
    if (!listed.has(session.id)) listed.set(session.id, session);
  }

  const parents = new Map<string, SessionTreeParent>();
  for (const session of listed.values()) {
    const link = session.openworkSessionLink;
    if (!link || link.parentID === session.id || options.standaloneIds?.has(session.id)) continue;
    if (listed.has(link.parentID)) parents.set(session.id, { sessionId: link.parentID, kind: link.kind });
  }

  for (const start of [...parents.keys()]) {
    const seen = new Set([start]);
    let cursor = parents.get(start)?.sessionId;
    while (cursor !== undefined && parents.has(cursor)) {
      if (seen.has(cursor)) {
        for (const id of seen) parents.delete(id);
        break;
      }
      seen.add(cursor);
      cursor = parents.get(cursor)?.sessionId;
    }
  }
  if (parents.size === 0) return EMPTY_SESSION_TREE;

  const childrenByParent = new Map<string, SessionListItem[]>();
  for (const [id, parent] of parents) {
    const session = listed.get(id);
    if (!session) continue;
    const siblings = childrenByParent.get(parent.sessionId) ?? [];
    siblings.push(session);
    childrenByParent.set(parent.sessionId, siblings);
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((left, right) => createdAt(left) - createdAt(right) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  }

  const descendants = new Map<string, readonly SessionTreeChild[]>();
  const collect = (parentId: string, depth: number, into: SessionTreeChild[]) => {
    for (const session of childrenByParent.get(parentId) ?? []) {
      const kind = parents.get(session.id)?.kind;
      if (!kind) continue;
      into.push({ session, kind, depth: Math.min(depth, SESSION_LINK_MAX_DEPTH) });
      collect(session.id, depth + 1, into);
    }
  };

  const depthOf = (sessionId: string) => {
    let depth = 0;
    for (let cursor = parents.get(sessionId)?.sessionId; cursor !== undefined; cursor = parents.get(cursor)?.sessionId) depth += 1;
    return depth;
  };

  return {
    nestedIds: new Set(parents.keys()),
    descendantsOf: (sessionId) => {
      if (!childrenByParent.has(sessionId)) return NO_CHILDREN;
      const known = descendants.get(sessionId);
      if (known) return known;
      const rows: SessionTreeChild[] = [];
      collect(sessionId, depthOf(sessionId) + 1, rows);
      descendants.set(sessionId, rows);
      return rows;
    },
    parentOf: (sessionId) => parents.get(sessionId),
    depthOf,
  };
}

export function canLinkSessionTo(sessions: readonly SessionListItem[], parentId: string): boolean {
  const parent = sessions.find((session) => session.id === parentId);
  if (!parent || parent.parentID?.trim() || isSessionArchived(parent)) return false;
  return buildSessionTree(sessions).depthOf(parentId) < SESSION_LINK_MAX_DEPTH;
}

export function sessionTreeKindLabel(kind: SessionLinkKind): string {
  return kind === "side" ? t("session_tree.side_chat") : t("session_tree.started_by_agent");
}
