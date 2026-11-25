import { useEffect, useMemo, useState } from "react";

import { selectActivityContext, useActivityStore } from "@/react-app/kernel/activity-store";
import type { ActivityBaseline, ActivitySource, MemberActivityEntry } from "@/react-app/kernel/activity-types";

export type ActivityFeedItem =
  | {
    type: "member";
    id: string;
    timestamp: number;
    entry: MemberActivityEntry;
    unavailable: boolean;
    unread: boolean;
  }
  | { type: "baseline"; id: string; timestamp: number; baseline: ActivityBaseline; unread: false };

const RESOURCE_SOURCE: Record<MemberActivityEntry["resource"]["kind"], ActivitySource> = {
  provider: "providers",
  skill: "capabilities",
  plugin: "capabilities",
  connection: "connections",
};

export function useActivityFeed(active = true) {
  const context = useActivityStore(selectActivityContext);
  const activeScopeKey = useActivityStore((state) => state.activeScopeKey);
  const refreshState = useActivityStore((state) => state.refreshState);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [active]);

  const items = useMemo(() => {
    const seenAt = context.seenAt ?? 0;
    const result: ActivityFeedItem[] = context.entries.map((entry) => {
      const snapshot = context.snapshots[RESOURCE_SOURCE[entry.resource.kind]];
      const unavailable = entry.change === "unavailable" || snapshot?.every(
        (resource) => resource.kind !== entry.resource.kind || resource.id !== entry.resource.id,
      ) === true;
      return { type: "member", id: `member:${entry.id}`, timestamp: entry.observedAt, entry, unavailable, unread: entry.observedAt > seenAt };
    });
    if (activeScopeKey && context.baseline && context.baseline.labels.length > 0) {
      result.push({ type: "baseline", id: "baseline", timestamp: context.baseline.observedAt, baseline: context.baseline, unread: false });
    }
    return result.sort((left, right) => right.timestamp - left.timestamp || left.id.localeCompare(right.id));
  }, [activeScopeKey, context]);

  const unreadCount = useMemo(() => items.filter((item) => item.unread).length, [items]);
  const nothingSharedYet = activeScopeKey !== null && context.baseline?.labels.length === 0
    && items.length === 0;

  const loading = activeScopeKey !== null && refreshState === "refreshing"
    && items.length === 0 && Object.keys(context.snapshots).length === 0;

  return { items, context, activeScopeKey, refreshState, loading, now, unreadCount, nothingSharedYet };
}
