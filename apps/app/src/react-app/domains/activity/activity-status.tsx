/** @jsxImportSource react */
import { CircleCheck, CloudOff, Filter } from "lucide-react";
import { Link } from "react-router";

import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { currentLocale, t } from "@/i18n";
import { ACTIVITY_REFRESH_EVENT } from "@/react-app/kernel/activity-types";
import { cn } from "@/lib/utils";

/** Skeleton rows keep the icon, text, time and action lanes so nothing jumps when data lands (A6). */
export function ActivityLoading({ compact = false }: { compact?: boolean }) {
  const widths = compact ? ["w-44", "w-36", "w-48"] : ["w-58", "w-50", "w-65"];
  const details = ["w-31", "w-26", "w-37"];
  return (
    <div data-activity-loading aria-busy="true" aria-label={t("activity.title")} className={compact ? "px-1.5 pb-1.5" : undefined}>
      {widths.map((width, row) => (
        <div key={row} className={cn("flex items-center px-3", compact ? "h-8.5 gap-2.5 px-2" : "h-13 gap-3")} aria-hidden="true">
          <Skeleton className={cn("shrink-0 rounded-full motion-reduce:animate-none", compact ? "size-3.5" : "size-6")} />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className={cn("h-2.5 max-w-full motion-reduce:animate-none", width)} />
            {!compact ? <Skeleton className={cn("h-2 max-w-full motion-reduce:animate-none", details[row])} /> : null}
          </span>
          <Skeleton className="h-2 w-6 shrink-0 motion-reduce:animate-none" />
          {!compact ? <span className="flex w-18 shrink-0 justify-end">{row < 2 ? <Skeleton className="h-2.5 w-10 motion-reduce:animate-none" /> : null}</span> : null}
        </div>
      ))}
    </div>
  );
}

function verifiedTime(verifiedAt: number, now: number) {
  const verified = new Date(verifiedAt);
  const sameDay = verified.toDateString() === new Date(now).toDateString();
  return verified.toLocaleString(currentLocale(), sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Neutral, not red: nothing the person did failed. The last known list stays below (A6). */
export function ActivityRefreshError({ verifiedAt, now, compact = false }: { verifiedAt: number | null; now: number; compact?: boolean }) {
  const message = verifiedAt === null
    ? t("activity.refresh_failed")
    : t("activity.refresh_failed_since", { time: verifiedTime(verifiedAt, now) });
  return (
    <div role="status" data-activity-refresh-error className={cn("flex items-center rounded-lg bg-muted/60", compact ? "mx-1.5 mb-1 min-h-9 gap-2.5 px-2" : "min-h-10 gap-3 px-3")}>
      <span aria-hidden="true" className={cn("flex shrink-0 items-center justify-center text-muted-foreground", compact ? "size-3.5" : "size-6")}>
        <CloudOff className="size-3.5" strokeWidth={1.5} />
      </span>
      <span className="min-w-0 flex-1 text-sm">{message}</span>
      <Button variant="ghost" size="xs" className="min-w-18 shrink-0 justify-end px-0 font-medium" onClick={() => window.dispatchEvent(new Event(ACTIVITY_REFRESH_EVENT))}>
        {t("activity.retry")}
      </Button>
    </div>
  );
}

/** Says what the filter hid, in the same row lanes, with the way back as the one action (A6). */
export function ActivityNoMatches({ kind, onShowAll }: { kind: "skill" | "plugin" | "connection"; onShowAll: () => void }) {
  const noMatches = { skill: t("activity.no_matches_skill"), plugin: t("activity.no_matches_plugin"), connection: t("activity.no_matches_connection") };
  return (
    <div data-activity-no-matches className="flex min-h-13 items-center gap-3 px-3">
      <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
        <Filter className="size-3.5" strokeWidth={1.5} />
      </span>
      <span className="min-w-0 flex-1 text-sm">{noMatches[kind]}</span>
      <Button variant="ghost" size="xs" className="shrink-0 justify-end px-0 font-medium" onClick={onShowAll}>{t("activity.show_all")}</Button>
    </div>
  );
}

/** First verification found nothing shared yet: one state line and one next step (A5 first week). */
export function ActivityNothingShared({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  return (
    <div data-activity-nothing-shared className={cn("flex items-center", compact ? "mx-1.5 mb-1.5 h-9 gap-2.5 px-2" : "min-h-13 gap-3 px-3")}>
      <span className={cn("min-w-0 flex-1 text-sm", compact ? "text-muted-foreground" : undefined)}>{t("activity.nothing_shared")}</span>
      <Link to="/extensions" onClick={onNavigate} className={cn(buttonVariants({ variant: "ghost", size: "xs" }), "shrink-0 justify-end px-0 font-medium")}>
        {t("activity.browse_library")}
      </Link>
    </div>
  );
}

/** No unread: say so in one line and keep the last few in view (A5). */
export function ActivityCaughtUp() {
  return (
    <div data-activity-caught-up className="flex h-8.5 items-center gap-2.5 px-2 text-sm">
      <CircleCheck aria-hidden="true" className="size-3.5 shrink-0" strokeWidth={1.5} />
      {t("activity.caught_up")}
    </div>
  );
}
