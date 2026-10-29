// The Feed view of the sidebar: every workspace's sessions in one list, newest
// activity first, with sessions waiting on the person on top and settled ones
// in a shelf at the bottom.
import type { WorkspaceSessionGroup } from "../../../../app/types";
import type { SessionSettleEntry } from "./session-management-store";
import { filterSettledSessions, sessionActivityAt } from "./session-settle";
import { getRootSessions, isNeedsAttentionSessionStatus, partitionArchivedSessions, type SessionListItem } from "./utils";

const DAY_MS = 24 * 60 * 60 * 1000;

export type FeedEntry = { group: WorkspaceSessionGroup; session: SessionListItem };
export type FeedDay = "today" | "yesterday" | "earlier";
const DAY_ORDER: FeedDay[] = ["today", "yesterday", "earlier"];

export type SessionFeed = {
  needsYou: FeedEntry[];
  days: { day: FeedDay; entries: FeedEntry[] }[];
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
};

/** Pinned sessions stay in the Pinned section, so the feed leaves them out. */
export function buildSessionFeed(groups: readonly WorkspaceSessionGroup[], context: SessionFeedContext): SessionFeed {
  const active: FeedEntry[] = [];
  const settled: FeedEntry[] = [];
  for (const group of groups) {
    const roots = getRootSessions(partitionArchivedSessions(group.sessions).active)
      .filter((session) => !context.pinnedIds.has(session.id));
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
  const newestFirst = (a: FeedEntry, b: FeedEntry) => sessionActivityAt(b.session) - sessionActivityAt(a.session);
  active.sort(newestFirst);
  settled.sort(newestFirst);

  const midnight = new Date(context.now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const needsYou: FeedEntry[] = [];
  const byDay: Record<FeedDay, FeedEntry[]> = { today: [], yesterday: [], earlier: [] };
  for (const entry of active) {
    if (isNeedsAttentionSessionStatus(context.statusById?.[entry.session.id])) {
      needsYou.push(entry);
      continue;
    }
    const at = sessionActivityAt(entry.session);
    byDay[at >= today ? "today" : at >= today - DAY_MS ? "yesterday" : "earlier"].push(entry);
  }
  const days = DAY_ORDER
    .filter((day) => byDay[day].length > 0)
    .map((day) => ({ day, entries: byDay[day] }));
  return { needsYou, days, settled };
}
