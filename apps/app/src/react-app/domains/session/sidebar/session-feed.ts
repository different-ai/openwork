// The Feed view of the sidebar: every workspace's sessions in one list, newest
// first, with sessions waiting on the person on top and settled ones in a shelf
// at the bottom.
import type { WorkspaceSessionGroup } from "../../../../app/types";
import type { FeedFolder, FeedGroupBy, FeedSortBy, SessionSettleEntry, WorkspaceGroupState } from "./session-management-store";
import { filterSettledSessions, sessionActivityAt, sessionCreatedAt } from "./session-settle";
import {
  getRootSessions,
  isActiveWorkSessionStatus,
  isNeedsAttentionSessionStatus,
  partitionArchivedSessions,
  type SessionListItem,
} from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FeedEntry = { group: WorkspaceSessionGroup; session: SessionListItem };
/** `all` is the single, unlabeled section when the Feed is not grouped. */
export type FeedSection = "today" | "yesterday" | "earlier" | "active" | "inactive" | "all";
const SECTION_ORDER: Record<FeedGroupBy, FeedSection[]> = {
  day: ["today", "yesterday", "earlier"],
  activity: ["active", "inactive"],
  none: ["all"],
};

export type FeedFolderShelf = FeedFolder & {
  label: string;
  entries: FeedEntry[];
  /** Something inside needs the person or has an unread result. */
  attention: "needs-you" | "unread" | null;
};

export type SessionFeed = {
  folders: FeedFolderShelf[];
  needsYou: FeedEntry[];
  sections: { section: FeedSection; entries: FeedEntry[] }[];
  settled: FeedEntry[];
};

export type SessionFeedContext = {
  pinnedIds: ReadonlySet<string>;
  unreadIds: ReadonlySet<string>;
  settledById: Record<string, SessionSettleEntry>;
  statusById: Record<string, string> | undefined;
  /** Workspaces that can settle (OpenCode v2 with the feature on). */
  settleWorkspaceIds: ReadonlySet<string> | undefined;
  autoSettleDays: number;
  now: number;
  feedFolders: readonly FeedFolder[];
  groupsByWorkspace: Readonly<Record<string, WorkspaceGroupState>>;
  groupBy: FeedGroupBy;
  sortBy: FeedSortBy;
};

/** Pinned sessions stay in the Pinned section, so the feed leaves them out. */
export function buildSessionFeed(groups: readonly WorkspaceSessionGroup[], context: SessionFeedContext): SessionFeed {
  const active: FeedEntry[] = [];
  const settled: FeedEntry[] = [];
  // Pinned folders are sticky: a session filed there stays until it is moved.
  const folders = context.feedFolders.flatMap((folder): FeedFolderShelf[] => {
    const label = context.groupsByWorkspace[folder.workspaceId]?.groups.find((group) => group.id === folder.groupId)?.label;
    return label === undefined ? [] : [{ ...folder, label, entries: [], attention: null }];
  });
  const folderFor = (workspaceId: string, sessionId: string) => {
    const groupId = context.groupsByWorkspace[workspaceId]?.assignments[sessionId];
    return groupId ? folders.find((folder) => folder.workspaceId === workspaceId && folder.groupId === groupId) : undefined;
  };
  for (const group of groups) {
    const unfiled = getRootSessions(partitionArchivedSessions(group.sessions).active)
      .filter((session) => !context.pinnedIds.has(session.id));
    const roots = unfiled.filter((session) => {
      const folder = folderFor(group.workspace.id, session.id);
      if (!folder) return true;
      folder.entries.push({ group, session });
      return false;
    });
    const settledIds = context.settleWorkspaceIds?.has(group.workspace.id)
      ? new Set(filterSettledSessions(roots, {
        settledById: context.settledById,
        statusById: context.statusById,
        pinnedIds: context.pinnedIds,
        unreadIds: context.unreadIds,
        autoSettleDays: context.autoSettleDays,
        now: context.now,
      }).map((session) => session.id))
      : new Set<string>();
    for (const session of roots) (settledIds.has(session.id) ? settled : active).push({ group, session });
  }
  const timeOf = context.sortBy === "created" ? sessionCreatedAt : sessionActivityAt;
  const newestFirst = (a: FeedEntry, b: FeedEntry) => timeOf(b.session) - timeOf(a.session);
  active.sort(newestFirst);
  settled.sort(newestFirst);
  for (const folder of folders) {
    folder.entries.sort(newestFirst);
    const ids = folder.entries.map((entry) => entry.session.id);
    folder.attention = ids.some((id) => isNeedsAttentionSessionStatus(context.statusById?.[id])) ? "needs-you"
      : ids.some((id) => context.unreadIds.has(id)) ? "unread"
      : null;
  }

  const midnight = new Date(context.now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  // Active: the agent is working, or it finished with a result not read yet.
  const sectionOf = ({ session }: FeedEntry): FeedSection => {
    if (context.groupBy === "none") return "all";
    if (context.groupBy === "activity") {
      return isActiveWorkSessionStatus(context.statusById?.[session.id]) || context.unreadIds.has(session.id) ? "active" : "inactive";
    }
    const at = timeOf(session);
    return at >= today ? "today" : at >= today - DAY_MS ? "yesterday" : "earlier";
  };
  const needsYou: FeedEntry[] = [];
  const bySection = new Map(SECTION_ORDER[context.groupBy].map((section): [FeedSection, FeedEntry[]] => [section, []]));
  for (const entry of active) {
    if (isNeedsAttentionSessionStatus(context.statusById?.[entry.session.id])) {
      needsYou.push(entry);
      continue;
    }
    bySection.get(sectionOf(entry))?.push(entry);
  }
  const sections = [...bySection]
    .filter(([, entries]) => entries.length > 0)
    .map(([section, entries]) => ({ section, entries }));
  return { folders, needsYou, sections, settled };
}
