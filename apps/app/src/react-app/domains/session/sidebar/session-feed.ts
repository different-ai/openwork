import type { SessionLinkKind } from "@openwork/types/session-link";
import type { WorkspaceSessionGroup } from "../../../../app/types";
import type { FeedFolder, FeedGroupBy, FeedPlacement, FeedSortBy, WorkspaceGroupState } from "./session-management-store";
import { sessionCreatedAt, sessionLastActivityAt } from "./session-activity";
import { workbenchSessionKey } from "../chat/workbench-store";
import { shouldHideAttachedSideChat } from "./side-chat-status";
import { EMPTY_SESSION_TREE, type SessionTree } from "./session-tree";
import {
  getRootSessions,
  isActiveWorkSessionStatus,
  isNeedsAttentionSessionStatus,
  partitionArchivedSessions,
  type SessionListItem,
} from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FeedEntry = {
  group: WorkspaceSessionGroup;
  session: SessionListItem;
  nested?: { depth: number; kind: SessionLinkKind };
};
export type FeedSection = "today" | "yesterday" | "earlier" | "active" | "inactive" | "all";
const SECTION_ORDER: Record<FeedGroupBy, FeedSection[]> = {
  day: ["today", "yesterday", "earlier"],
  activity: ["active", "inactive"],
  none: ["all"],
};

export type FeedFolderShelf = FeedFolder & {
  label: string;
  entries: FeedEntry[];
  attention: "needs-you" | "unread" | null;
};

export type SessionFeed = {
  folders: FeedFolderShelf[];
  sections: { section: FeedSection; entries: FeedEntry[] }[];
  sortKeyById: ReadonlyMap<string, number>;
  reorderable: boolean;
};

export type SessionFeedContext = {
  pinnedIds: ReadonlySet<string>;
  attachedSideChatKeys: ReadonlySet<string>;
  selectedSessionId: string | null;
  unreadIds: ReadonlySet<string>;
  workedAtById: Readonly<Record<string, number>>;
  placementById: Readonly<Record<string, FeedPlacement>>;
  statusById: Record<string, string> | undefined;
  now: number;
  feedFolders: readonly FeedFolder[];
  groupsByWorkspace: Readonly<Record<string, WorkspaceGroupState>>;
  groupBy: FeedGroupBy;
  sortBy: FeedSortBy;
  treeFor?: (workspaceId: string) => SessionTree;
};

export function feedActivityKey(
  session: SessionListItem,
  workedAt: number | undefined,
  placement: FeedPlacement | undefined,
): number {
  const activityAt = sessionLastActivityAt(session, workedAt);
  return placement && placement.at >= activityAt ? placement.key : activityAt;
}

export function feedKeyBetween(above: number | undefined, below: number | undefined): number {
  if (above !== undefined && below !== undefined) return (above + below) / 2;
  if (above !== undefined) return above - 1;
  if (below !== undefined) return below + 1;
  return Date.now();
}

export function buildSessionFeed(groups: readonly WorkspaceSessionGroup[], context: SessionFeedContext): SessionFeed {
  const listed: FeedEntry[] = [];
  const folders = context.feedFolders.flatMap((folder): FeedFolderShelf[] => {
    const label = context.groupsByWorkspace[folder.workspaceId]?.groups.find((group) => group.id === folder.groupId)?.label;
    return label === undefined ? [] : [{ ...folder, label, entries: [], attention: null }];
  });
  const folderFor = (workspaceId: string, sessionId: string) => {
    const groupId = context.groupsByWorkspace[workspaceId]?.assignments[sessionId];
    return groupId ? folders.find((folder) => folder.workspaceId === workspaceId && folder.groupId === groupId) : undefined;
  };
  const treeFor = (workspaceId: string) => context.treeFor?.(workspaceId) ?? EMPTY_SESSION_TREE;
  const withNested = (entries: FeedEntry[]) => entries.flatMap((entry) => [
    entry,
    ...treeFor(entry.group.workspace.id).descendantsOf(entry.session.id)
      .map((child): FeedEntry => ({ group: entry.group, session: child.session, nested: { depth: child.depth, kind: child.kind } })),
  ]);
  for (const group of groups) {
    const tree = treeFor(group.workspace.id);
    const roots = getRootSessions(partitionArchivedSessions(group.sessions).active)
      .filter((session) => !context.pinnedIds.has(session.id) && !tree.nestedIds.has(session.id) && !(shouldHideAttachedSideChat(
        context.attachedSideChatKeys.has(workbenchSessionKey({ workspaceId: group.workspace.id, sessionId: session.id })),
        context.selectedSessionId === session.id,
        context.statusById?.[session.id],
      ) && tree.descendantsOf(session.id).length === 0));
    for (const session of roots) {
      const folder = folderFor(group.workspace.id, session.id);
      (folder ? folder.entries : listed).push({ group, session });
    }
  }
  const reorderable = context.sortBy === "activity";
  const sortKeyById = new Map<string, number>();
  const timeOf = (session: SessionListItem) => {
    let key = sortKeyById.get(session.id);
    if (key === undefined) {
      key = reorderable
        ? feedActivityKey(session, context.workedAtById[session.id], context.placementById[session.id])
        : sessionCreatedAt(session);
      sortKeyById.set(session.id, key);
    }
    return key;
  };
  const newestFirst = (a: FeedEntry, b: FeedEntry) => timeOf(b.session) - timeOf(a.session);
  listed.sort(newestFirst);
  for (const folder of folders) {
    folder.entries = withNested(folder.entries.sort(newestFirst));
    const ids = folder.entries.map((entry) => entry.session.id);
    folder.attention = ids.some((id) => isNeedsAttentionSessionStatus(context.statusById?.[id])) ? "needs-you"
      : ids.some((id) => context.unreadIds.has(id)) ? "unread"
      : null;
  }

  const midnight = new Date(context.now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const isActive = (sessionId: string) => {
    const status = context.statusById?.[sessionId];
    return isActiveWorkSessionStatus(status) || isNeedsAttentionSessionStatus(status) || context.unreadIds.has(sessionId);
  };
  const sectionOf = ({ group, session }: FeedEntry): FeedSection => {
    if (context.groupBy === "none") return "all";
    if (context.groupBy === "activity") {
      return isActive(session.id) || treeFor(group.workspace.id).descendantsOf(session.id).some((child) => isActive(child.session.id))
        ? "active"
        : "inactive";
    }
    const at = timeOf(session);
    return at >= today ? "today" : at >= today - DAY_MS ? "yesterday" : "earlier";
  };
  const bySection = new Map(SECTION_ORDER[context.groupBy].map((section): [FeedSection, FeedEntry[]] => [section, []]));
  for (const entry of listed) bySection.get(sectionOf(entry))?.push(entry);
  const sections = [...bySection]
    .filter(([, entries]) => entries.length > 0)
    .map(([section, entries]) => ({ section, entries: withNested(entries) }));
  return { folders, sections, sortKeyById, reorderable };
}
