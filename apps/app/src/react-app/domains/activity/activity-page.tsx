/** @jsxImportSource react */
import { useMemo, useState } from "react";

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { currentLocale, t } from "@/i18n";
import type { ActivityResource } from "@/react-app/kernel/activity-types";
import { useShellConfig } from "@/react-app/shell/shell-config";
import { ActivityEmpty } from "./activity-empty";
import { ActivityRow } from "./activity-row";
import { ActivityLoading, ActivityNoMatches, ActivityNothingShared, ActivityRefreshError } from "./activity-status";
import { useActivityFeed, type ActivityFeedItem } from "./use-activity-feed";

type ActivityFilter = "all" | "skill" | "plugin" | "connection";
const FILTERS: Array<{ value: ActivityFilter; label: string }> = [
  { value: "all", label: "activity.filter_all" },
  { value: "skill", label: "activity.filter_skills" },
  { value: "plugin", label: "activity.filter_plugins" },
  { value: "connection", label: "activity.filter_connections" },
];

function isFilter(value: unknown): value is ActivityFilter {
  return FILTERS.some((filter) => filter.value === value);
}

function dayLabel(timestamp: number, now: number) {
  const day = new Date(timestamp);
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return t("activity.today");
  if (day.toDateString() === yesterday.toDateString()) return t("activity.yesterday");
  const weekStart = new Date(now);
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
  if (day >= weekStart) return t("activity.earlier_this_week");
  return day.toLocaleDateString(currentLocale(), {
    month: "long", day: "numeric", year: day.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
  });
}

export function ActivityPage({ onTrySkill }: { onTrySkill?: (resource: ActivityResource) => void }) {
  const { config } = useShellConfig();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const { items, context, refreshState, loading, now, nothingSharedYet } = useActivityFeed(config.notifications);
  const groups = useMemo(() => {
    const byDay = new Map<string, ActivityFeedItem[]>();
    for (const item of items) {
      if (filter !== "all" && (item.type !== "member" || item.entry.resource.kind !== filter)) continue;
      const day = dayLabel(item.timestamp, now);
      const group = byDay.get(day);
      if (group) group.push(item);
      else byDay.set(day, [item]);
    }
    return [...byDay.entries()];
  }, [filter, items, now]);

  if (!config.notifications) return null;

  const body = () => {
    if (loading) return <ActivityLoading />;
    if (groups.length > 0) {
      return (
        <div>{groups.map(([day, group]) => (
          <section key={day} aria-label={day} className="flex flex-col">
            <h2 className="px-3 pb-1.5 pt-4 text-xs font-medium text-muted-foreground">{day}</h2>
            <div role="list">
              {group.map((item) => <ActivityRow key={item.id} item={item} now={now} onTrySkill={onTrySkill} />)}
            </div>
          </section>
        ))}</div>
      );
    }
    if (filter !== "all") return <ActivityNoMatches kind={filter} onShowAll={() => setFilter("all")} />;
    if (refreshState === "error") return null;
    if (nothingSharedYet) return <ActivityNothingShared />;
    return <ActivityEmpty />;
  };

  return (
    <section data-activity-page aria-label={t("activity.title")} className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-198 flex-col gap-5 px-4 pb-12 pt-12 lg:pt-32">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-xl font-semibold tracking-tight">{t("activity.title")}</h1>
          <div className="max-w-full overflow-x-auto">
            <ToggleGroup value={[filter]} onValueChange={(values) => { if (isFilter(values[0])) setFilter(values[0]); }} variant="segmented" spacing={0.5} size="xs" aria-label={t("activity.filter")}>
              {FILTERS.map((option) => <ToggleGroupItem key={option.value} value={option.value}>{t(option.label)}</ToggleGroupItem>)}
            </ToggleGroup>
          </div>
        </div>
        <div className="flex flex-col gap-1">
          {refreshState === "error" ? <ActivityRefreshError verifiedAt={context.verifiedAt} now={now} /> : null}
          {body()}
        </div>
      </div>
    </section>
  );
}
